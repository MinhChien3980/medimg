import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { putToPresignedUrl, uploadsApi } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import { isTerminalUpload, type UploadDto, type Uuid } from '@/api/types';
import { resolveContentType } from './fileValidation';

/** Poll interval for `GET /uploads/{id}` while the server processes the image. */
export const UPLOAD_POLL_MS = 1000;

/** Give up polling after this long (the server marks stuck uploads FAILED after 10 min). */
export const UPLOAD_PROCESSING_TIMEOUT_MS = 2 * 60_000;

export type UploadPhase =
  'idle' | 'initializing' | 'uploading' | 'completing' | 'processing' | 'done' | 'failed';

/** Why an upload failed. `request` carries the HTTP / network error (usually a ProblemDetail). */
export type UploadFailure =
  | { kind: 'request'; error: unknown }
  | { kind: 'processing'; detail: string | null }
  | { kind: 'timeout' }
  | { kind: 'invalidResponse' };

export interface StartUploadInput {
  patientId: Uuid;
  file: File;
  modalityHint?: string;
  bodyPartHint?: string;
}

interface LocalState {
  phase: Exclude<UploadPhase, 'done'>;
  uploadId: Uuid | null;
  percent: number;
  failure: UploadFailure | null;
}

const INITIAL: LocalState = { phase: 'idle', uploadId: null, percent: 0, failure: null };

class InvalidUploadResponseError extends Error {}

/**
 * Upload state machine: `uploads/init` → PUT to presigned URL (progress) →
 * `uploads/{id}/complete` → poll `uploads/{id}` until DONE / FAILED or the timeout.
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
    }, UPLOAD_PROCESSING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [stillProcessing, state.uploadId]);

  const start = useCallback(
    async ({ patientId, file, modalityHint, bodyPartHint }: StartUploadInput) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      const contentType = resolveContentType(file) ?? 'application/octet-stream';

      try {
        setState({ ...INITIAL, phase: 'initializing' });
        const init = await uploadsApi.init({
          patientId,
          files: [{ name: file.name, size: file.size, contentType }],
          modalityHint,
          bodyPartHint,
        });
        const target = init.files[0];
        if (!target) throw new InvalidUploadResponseError();

        setState({ ...INITIAL, phase: 'uploading', uploadId: init.uploadId });
        await putToPresignedUrl(
          target.putUrl,
          file,
          contentType,
          (percent) => setState((s) => ({ ...s, percent })),
          abort.signal,
        );

        setState((s) => ({ ...s, phase: 'completing', percent: 100 }));
        const completed = await uploadsApi.complete(init.uploadId);
        queryClient.setQueryData(queryKeys.uploads.detail(init.uploadId), completed);
        setState((s) => ({ ...s, phase: 'processing' }));
      } catch (e) {
        if (abort.signal.aborted) return;
        const failed: UploadFailure =
          e instanceof InvalidUploadResponseError
            ? { kind: 'invalidResponse' }
            : { kind: 'request', error: e };
        setState((s) => ({ ...s, phase: 'failed', failure: failed }));
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
    percent: state.percent,
    uploadId: state.uploadId,
    uploadStatus: upload?.status ?? null,
    studyId,
    failure,
    start,
    reset,
  };
}
