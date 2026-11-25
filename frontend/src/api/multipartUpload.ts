/**
 * Browser side of an S3 multipart upload: the file is cut into the parts the server presigned
 * (`InitUploadFile.multipart`), each part is PUT to its own URL, and the `ETag` of every part is
 * collected for `POST /uploads/{id}/complete`.
 *
 * Parts go out with `fetch` and no `Authorization` header (S3 authenticates the presigned URL
 * itself) and no `Content-Type` (a `Blob.slice()` has none; the part URLs do not sign one). The
 * storage is served on the page's origin, so the `ETag` response header is readable.
 */
import type { CompletedPart, MultipartPlan } from './types';

/** Parts in flight at once. */
export const MULTIPART_CONCURRENCY = 3;
/** Retries of one part after its first attempt failed with a transient error. */
export const MULTIPART_MAX_RETRIES = 3;

/** 1 s, 2 s, 4 s. */
export const defaultRetryDelayMs = (retry: number) => 1000 * 2 ** (retry - 1);

/** The plan does not match the file (wrong part count, numbering or size). */
export class InvalidMultipartPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMultipartPlanError';
  }
}

/** One part could not be uploaded (after its retries, when the error was transient). */
export class PartUploadError extends Error {
  readonly partNumber: number;
  /** HTTP status, or null for a network error or a response without `ETag`. */
  readonly status: number | null;
  /** Network errors, 5xx, 408 and 429 are worth retrying; an expired signature (403) is not. */
  readonly retryable: boolean;

  constructor(partNumber: number, status: number | null, retryable: boolean, message: string) {
    super(message);
    this.name = 'PartUploadError';
    this.partNumber = partNumber;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface PartSlice {
  partNumber: number;
  url: string;
  /** Byte range `[start, end)` of the file. */
  start: number;
  end: number;
}

/**
 * Byte range of every part, in ascending part order. Part `n` starts at `(n - 1) · partSize`; the
 * plan must number its parts 1..N with N = ceil(size / partSize).
 */
export function sliceParts(size: number, plan: MultipartPlan): PartSlice[] {
  const { partSize } = plan;
  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new InvalidMultipartPlanError(`Invalid part size ${partSize}`);
  }
  const expected = Math.max(1, Math.ceil(size / partSize));
  const parts = [...plan.parts].sort((a, b) => a.partNumber - b.partNumber);
  if (parts.length !== expected || parts.some((p, i) => p.partNumber !== i + 1)) {
    throw new InvalidMultipartPlanError(
      `Expected parts 1..${expected} for ${size} bytes, got [${plan.parts.map((p) => p.partNumber).join(', ')}]`,
    );
  }
  return parts.map((p) => ({
    partNumber: p.partNumber,
    url: p.url,
    start: (p.partNumber - 1) * partSize,
    end: Math.min(p.partNumber * partSize, size),
  }));
}

export interface MultipartUploadOptions {
  file: Blob;
  plan: MultipartPlan;
  /** Aborts every part in flight and every pending retry. */
  signal?: AbortSignal;
  /** Bytes of the parts uploaded so far; a part counts once its PUT has succeeded. */
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  concurrency?: number;
  maxRetries?: number;
  /** Delay before retry `n` (1-based). */
  retryDelayMs?: (retry: number) => number;
  /** Defaults to the global `fetch`, looked up at call time. */
  fetch?: typeof fetch;
}

/**
 * Uploads every part, at most `concurrency` at a time, retrying transient failures with backoff.
 * Resolves with the parts in ascending `partNumber` order, as `CompleteMultipartUpload` requires.
 * On the first part that fails for good the other parts are aborted; the promise settles only
 * once nothing is in flight any more. Rejects with the signal's reason when aborted from outside.
 */
export async function uploadMultipart({
  file,
  plan,
  signal,
  onProgress,
  concurrency = MULTIPART_CONCURRENCY,
  maxRetries = MULTIPART_MAX_RETRIES,
  retryDelayMs = defaultRetryDelayMs,
  fetch: fetchImpl = (input, init) => globalThis.fetch(input, init),
}: MultipartUploadOptions): Promise<CompletedPart[]> {
  const slices = sliceParts(file.size, plan);
  signal?.throwIfAborted();

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });

  const completed: CompletedPart[] = new Array<CompletedPart>(slices.length);
  let next = 0;
  let uploadedBytes = 0;
  let failure: { error: unknown } | null = null;

  const uploadPart = async (slice: PartSlice): Promise<string> => {
    let response: Response;
    try {
      response = await fetchImpl(slice.url, {
        method: 'PUT',
        body: file.slice(slice.start, slice.end),
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new PartUploadError(
        slice.partNumber,
        null,
        true,
        `Part ${slice.partNumber}: network error`,
      );
    }
    if (!response.ok) {
      const { status } = response;
      const retryable = status >= 500 || status === 408 || status === 429;
      throw new PartUploadError(
        slice.partNumber,
        status,
        retryable,
        `Part ${slice.partNumber}: HTTP ${status}`,
      );
    }
    const etag = response.headers.get('ETag');
    if (!etag) {
      throw new PartUploadError(
        slice.partNumber,
        null,
        false,
        `Part ${slice.partNumber}: no ETag in the response`,
      );
    }
    return etag;
  };

  const uploadWithRetries = async (slice: PartSlice): Promise<string> => {
    for (let retry = 0; ; retry += 1) {
      try {
        return await uploadPart(slice);
      } catch (error) {
        const transient = error instanceof PartUploadError && error.retryable;
        if (controller.signal.aborted || !transient || retry >= maxRetries) throw error;
        await sleep(retryDelayMs(retry + 1), controller.signal);
      }
    }
  };

  const worker = async () => {
    while (next < slices.length && !controller.signal.aborted) {
      const index = next;
      next += 1;
      const slice = slices[index] as PartSlice;
      try {
        const etag = await uploadWithRetries(slice);
        completed[index] = { partNumber: slice.partNumber, etag };
        uploadedBytes += slice.end - slice.start;
        onProgress?.(uploadedBytes, file.size);
      } catch (error) {
        // The first failure wins; aborting stops the other workers and their parts in flight.
        if (!failure && !signal?.aborted) failure = { error };
        controller.abort();
        return;
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(concurrency, slices.length)) }, worker),
    );
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }

  signal?.throwIfAborted();
  if (failure) throw (failure as { error: unknown }).error;
  return completed;
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
