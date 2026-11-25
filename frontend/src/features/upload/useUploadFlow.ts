import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { putToPresignedUrl, uploadsApi } from '@/api/endpoints';
import { InvalidMultipartPlanError, PartUploadError, uploadMultipart } from '@/api/multipartUpload';
import { queryKeys } from '@/api/queryKeys';
import {
  isTerminalUpload,
  type CompleteUploadRequest,
  type InputType,
  type UploadDto,
  type Uuid,
  type Vec3,
} from '@/api/types';
import { classifyFile, type UploadKind, type ZipContent } from './fileValidation';

/** Poll interval for `GET /uploads/{id}` while the server processes the file. */
export const UPLOAD_POLL_MS = 1000;

/**
 * Give up polling after this long. The server marks stuck uploads FAILED after 10 min (2D) or
 * 30 min (volume); a CT volume is normally ready within a few minutes on CPU. A DICOM X-ray goes
 * through the same ingest queue as the volumes, so it may wait behind one.
 */
export const UPLOAD_PROCESSING_TIMEOUT_MS: Record<UploadKind, number> = {
  image: 2 * 60_000,
  dicom: 5 * 60_000,
  volume: 10 * 60_000,
};

export type UploadPhase =
  'idle' | 'initializing' | 'uploading' | 'completing' | 'processing' | 'done' | 'failed';

/**
 * Why an upload failed. `request` carries the HTTP / network error (usually a ProblemDetail);
 * `part` is a part of a multipart upload that storage refused (`status`) or never answered (null).
 */
export type UploadFailure =
  | { kind: 'request'; error: unknown }
  | { kind: 'part'; partNumber: number; status: number | null }
  | { kind: 'processing'; detail: string | null }
  | { kind: 'timeout' }
  | { kind: 'invalidResponse' };

export interface StartUploadInput {
  patientId: Uuid;
  file: File;
  modalityHint?: string;
  bodyPartHint?: string;
  /** What the user said a ZIP holds; only changes the wording while the server processes it. */
  zipContent?: ZipContent;
  /** Voxel spacing of a ZIP of PNG/JPG slices, in mm. */
  sliceSpacingMm?: Vec3;
}

/** Parts of a multipart upload that are done, out of all of them. */
export interface PartsProgress {
  done: number;
  total: number;
}

interface LocalState {
  phase: Exclude<UploadPhase, 'done'>;
  kind: UploadKind;
  zipContent: ZipContent | null;
  uploadId: Uuid | null;
  percent: number;
  parts: PartsProgress | null;
  failure: UploadFailure | null;
}

const INITIAL: LocalState = {
  phase: 'idle',
  kind: 'image',
  zipContent: null,
  uploadId: null,
  percent: 0,
  parts: null,
  failure: null,
};

/** Phases during which leaving the page loses the transfer. */
const TRANSFERRING: ReadonlySet<UploadPhase> = new Set(['initializing', 'uploading', 'completing']);

class InvalidUploadResponseError extends Error {}

/**
 * Upload state machine: `uploads/init` → one PUT to the presigned URL (with progress), or the
 * parts of a multipart upload → `uploads/{id}/complete` (with the parts' ETags) → poll
 * `uploads/{id}` until DONE / FAILED or the timeout. Unmounting, `cancel` and `reset` abort the
 * transfer.
 */
export function useUploadFlow() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LocalState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const poll = useQuery({
    queryKey: queryKeys.uploads.detail(state.uploadId ?? ''),
    queryFn: () => uploadsApi.get(state.uploadId ?? ''),
    enabled: state.phase === 'processing' && state.uploadId !== null,
    refetchInterval: (q) => {
      const data = q.state.data;
      return data && isTerminalUpload(data.status) ? false : UPLOAD_POLL_MS;
    },
  });

  const upload: UploadDto | undefined = state.phase === 'processing' ? poll.data : undefined;

  let phase: UploadPhase = state.phase;
  let failure = state.failure;
  if (state.phase === 'processing' && upload?.status === 'DONE') phase = 'done';
  if (state.phase === 'processing' && upload?.status === 'FAILED') {
    phase = 'failed';
    failure = { kind: 'processing', detail: upload.error };
  }
  if (state.phase === 'processing' && poll.isError) {
    phase = 'failed';
    failure = { kind: 'request', error: poll.error };
  }

  const studyId = phase === 'done' ? (upload?.studyId ?? null) : null;
  const inputType: InputType | null = upload?.inputType ?? null;

  // A finished upload changes the case's study list / count.
  useEffect(() => {
    if (phase === 'done') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.patients.all });
    }
  }, [phase, queryClient]);

  // Give up after the timeout; leaving `processing` also disables the poll query.
  const stillProcessing = phase === 'processing';
  useEffect(() => {
    if (!stillProcessing) return;
    const timer = setTimeout(() => {
      setState((s) =>
        s.phase === 'processing' ? { ...s, phase: 'failed', failure: { kind: 'timeout' } } : s,
      );
    }, UPLOAD_PROCESSING_TIMEOUT_MS[state.kind]);
    return () => clearTimeout(timer);
  }, [stillProcessing, state.uploadId, state.kind]);

  // Closing the tab mid-transfer would throw away a possibly long upload: the browser asks first.
  const transferring = TRANSFERRING.has(phase);
  useEffect(() => {
    if (!transferring) return;
    const confirmLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', confirmLeave);
    return () => window.removeEventListener('beforeunload', confirmLeave);
  }, [transferring]);

  const start = useCallback(
    async ({
      patientId,
      file,
      modalityHint,
      bodyPartHint,
      zipContent,
      sliceSpacingMm,
    }: StartUploadInput) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      const spec = classifyFile(file);
      const kind = spec?.kind ?? 'image';
      const contentType = spec?.contentType ?? 'application/octet-stream';
      const base: LocalState = { ...INITIAL, kind, zipContent: zipContent ?? null };

      try {
        setState({ ...base, phase: 'initializing' });
        const init = await uploadsApi.init({
          patientId,
          files: [{ name: file.name, size: file.size, contentType }],
          modalityHint,
          bodyPartHint,
          ...(sliceSpacingMm ? { sliceSpacingMm } : {}),
        });
        abort.signal.throwIfAborted();
        const target = init.files[0];
        if (!target) throw new InvalidUploadResponseError();

        let body: CompleteUploadRequest | undefined;
        if (target.multipart) {
          const total = target.multipart.parts.length;
          setState({
            ...base,
            phase: 'uploading',
            uploadId: init.uploadId,
            parts: { done: 0, total },
          });
          const parts = await uploadMultipart({
            file,
            plan: target.multipart,
            signal: abort.signal,
            onProgress: (loaded, size) =>
              setState((s) => ({
                ...s,
                percent: Math.floor((loaded / size) * 100),
                parts: { done: (s.parts?.done ?? 0) + 1, total },
              })),
          });
          body = { files: [{ fileId: target.fileId, parts }] };
        } else if (target.putUrl) {
          setState({ ...base, phase: 'uploading', uploadId: init.uploadId });
          await putToPresignedUrl(
            target.putUrl,
            file,
            contentType,
            (percent) => setState((s) => ({ ...s, percent })),
            abort.signal,
          );
        } else {
          throw new InvalidUploadResponseError();
        }

        setState((s) => ({ ...s, phase: 'completing', percent: 100 }));
        const completed = await uploadsApi.complete(init.uploadId, body);
        abort.signal.throwIfAborted();
        queryClient.setQueryData(queryKeys.uploads.detail(init.uploadId), completed);
        setState((s) => ({ ...s, phase: 'processing' }));
      } catch (e) {
        if (abort.signal.aborted) return;
        setState((s) => ({ ...s, phase: 'failed', failure: toFailure(e) }));
      }
    },
    [queryClient],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(INITIAL);
  }, []);

  return {
    phase,
    kind: state.kind,
    zipContent: state.zipContent,
    /** Upload progress of the file, 0..100 (by finished part for a multipart upload). */
    percent: state.percent,
    /** Parts done / total while a multipart upload runs; null for a single PUT. */
    parts: state.parts,
    /** Server-side processing progress, 0..100. */
    processingPercent: upload?.progress ?? 0,
    uploadId: state.uploadId,
    uploadStatus: upload?.status ?? null,
    studyId,
    inputType,
    failure,
    start,
    /** Aborts the transfer (every part in flight) and goes back to idle. */
    cancel: reset,
    reset,
  };
}

function toFailure(error: unknown): UploadFailure {
  if (error instanceof InvalidUploadResponseError || error instanceof InvalidMultipartPlanError) {
    return { kind: 'invalidResponse' };
  }
  if (error instanceof PartUploadError) {
    return { kind: 'part', partNumber: error.partNumber, status: error.status };
  }
  return { kind: 'request', error };
}
