import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source';
import { API_BASE, getValidAccessToken, refreshAccessToken } from './http';
import type { PredictionDto, PredictionProgressEvent, Uuid } from './types';

/**
 * Live prediction status over SSE (`GET /predictions/{id}/events`).
 *
 * `EventSource` cannot send an Authorization header, so this uses fetch streaming via
 * `@microsoft/fetch-event-source`. Comment lines (`:hb` heartbeats every 15 s) are
 * dropped by the parser. Reconnection is handled here (not by the library) so a fresh
 * access token can be used on every attempt.
 */
export interface PredictionStreamHandlers {
  onOpen?: () => void;
  onProgress: (event: PredictionProgressEvent) => void;
  onDone: (prediction: PredictionDto) => void;
  onFailed: (prediction: PredictionDto) => void;
}

export interface PredictionStreamOptions {
  signal: AbortSignal;
  /** Consecutive failed connection attempts before giving up (→ caller falls back to polling). */
  maxFailures?: number;
  /** Base reconnect delay, doubled per consecutive failure. */
  baseDelayMs?: number;
}

/** The stream could not be kept open; callers should poll instead. */
export class StreamUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Prediction event stream unavailable', { cause });
    this.name = 'StreamUnavailableError';
  }
}

class UnauthorizedStreamError extends Error {}
class StreamClosedError extends Error {}
class StreamHttpError extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Resolves when a terminal event (`done` / `failed`) was delivered or `signal` aborted.
 * Rejects with `StreamUnavailableError` after `maxFailures` consecutive failures.
 */
export async function streamPrediction(
  jobId: Uuid,
  handlers: PredictionStreamHandlers,
  { signal, maxFailures = 3, baseDelayMs = 1000 }: PredictionStreamOptions,
): Promise<void> {
  let failures = 0;
  let authRetried = false;

  while (!signal.aborted) {
    let terminal = false;
    const attempt = new AbortController();
    const forwardAbort = () => attempt.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });

    try {
      const token = await getValidAccessToken();
      if (signal.aborted) return;
      const headers: Record<string, string> = { Accept: EventStreamContentType };
      if (token) headers.Authorization = `Bearer ${token}`;

      await fetchEventSource(`${API_BASE}/predictions/${jobId}/events`, {
        signal: attempt.signal,
        headers,
        openWhenHidden: true,
        onopen: (response) => {
          if (response.status === 401) throw new UnauthorizedStreamError();
          const type = response.headers.get('content-type') ?? '';
          if (!response.ok || !type.startsWith(EventStreamContentType)) {
            throw new StreamHttpError(`HTTP ${response.status}`);
          }
          failures = 0;
          authRetried = false;
          handlers.onOpen?.();
          return Promise.resolve();
        },
        onmessage: (msg) => {
          if (!msg.data) return;
          switch (msg.event) {
            case 'progress':
              handlers.onProgress(JSON.parse(msg.data) as PredictionProgressEvent);
              break;
            case 'done':
              terminal = true;
              handlers.onDone(JSON.parse(msg.data) as PredictionDto);
              attempt.abort();
              break;
            case 'failed':
              terminal = true;
              handlers.onFailed(JSON.parse(msg.data) as PredictionDto);
              attempt.abort();
              break;
            default:
              break;
          }
        },
        onclose: () => {
          // Server ended the stream without a terminal event → reconnect.
          throw new StreamClosedError();
        },
        onerror: (err: unknown) => {
          // Rethrow: disables the library's built-in retry, the loop below decides.
          throw err;
        },
      });
    } catch (err) {
      if (signal.aborted || terminal) return;
      if (err instanceof UnauthorizedStreamError && !authRetried) {
        authRetried = true;
        try {
          await refreshAccessToken();
          continue;
        } catch (refreshError) {
          throw new StreamUnavailableError(refreshError);
        }
      }
      failures += 1;
      if (failures >= maxFailures) throw new StreamUnavailableError(err);
      await sleep(baseDelayMs * 2 ** (failures - 1), signal);
      continue;
    } finally {
      signal.removeEventListener('abort', forwardAbort);
    }

    // fetchEventSource resolved: either aborted by us after a terminal event, or by caller.
    if (terminal || signal.aborted) return;
  }
}
