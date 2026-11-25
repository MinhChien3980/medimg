import { fetchEventSource, type FetchEventSourceInit } from '@microsoft/fetch-event-source';
import { http as mock, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/features/auth/authStore';
import { donePrediction, JOB_ID, tokens } from '@/test/fixtures';
import { API, server } from '@/test/server';
import { streamPrediction, StreamUnavailableError } from './predictionStream';

vi.mock('@microsoft/fetch-event-source', () => ({
  EventStreamContentType: 'text/event-stream',
  fetchEventSource: vi.fn(),
}));

const fesMock = vi.mocked(fetchEventSource);

function sseResponse(status = 200): Response {
  return new Response(null, {
    status,
    headers: {
      'content-type': status === 200 ? 'text/event-stream; charset=utf-8' : 'application/json',
    },
  });
}

/** Simulates the library: open, deliver messages, then resolve when aborted. */
async function runStream(init: FetchEventSourceInit, messages: Array<[string, unknown]>) {
  try {
    await init.onopen?.(sseResponse());
    for (const [event, data] of messages) {
      init.onmessage?.({ id: '', event, data: JSON.stringify(data), retry: undefined });
    }
    if (!init.signal?.aborted) init.onclose?.();
  } catch (err) {
    init.onerror?.(err);
  }
}

const handlers = () => ({
  onOpen: vi.fn(),
  onProgress: vi.fn(),
  onDone: vi.fn(),
  onFailed: vi.fn(),
});

describe('streamPrediction', () => {
  beforeEach(() => {
    fesMock.mockReset();
    useAuthStore.getState().setSession(tokens('acc', 'ref'));
  });

  it('sends the bearer token, forwards progress and resolves on done', async () => {
    fesMock.mockImplementation((_url, init) =>
      runStream(init, [
        ['progress', { jobId: JOB_ID, status: 'RUNNING', progress: 30 }],
        ['done', donePrediction],
      ]),
    );
    const h = handlers();

    await streamPrediction(JOB_ID, h, { signal: new AbortController().signal });

    expect(fesMock).toHaveBeenCalledTimes(1);
    const [url, init] = fesMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/predictions/${JOB_ID}/events`);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer acc' });
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onProgress).toHaveBeenCalledWith({ jobId: JOB_ID, status: 'RUNNING', progress: 30 });
    expect(h.onDone).toHaveBeenCalledWith(donePrediction);
  });

  it('reconnects when the server closes the stream early', async () => {
    let attempt = 0;
    fesMock.mockImplementation((_url, init) => {
      attempt += 1;
      return attempt === 1
        ? runStream(init, [['progress', { jobId: JOB_ID, status: 'RUNNING', progress: 10 }]])
        : runStream(init, [['failed', { ...donePrediction, status: 'FAILED' }]]);
    });
    const h = handlers();

    await streamPrediction(JOB_ID, h, { signal: new AbortController().signal, baseDelayMs: 1 });

    expect(attempt).toBe(2);
    expect(h.onFailed).toHaveBeenCalledTimes(1);
  });

  it('gives up with StreamUnavailableError after maxFailures consecutive errors', async () => {
    fesMock.mockImplementation(async (_url, init) => {
      try {
        await init.onopen?.(sseResponse(502));
      } catch (err) {
        init.onerror?.(err);
      }
    });

    await expect(
      streamPrediction(JOB_ID, handlers(), {
        signal: new AbortController().signal,
        maxFailures: 3,
        baseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(StreamUnavailableError);
    expect(fesMock).toHaveBeenCalledTimes(3);
  });

  it('refreshes the access token once on 401 and reconnects with the new one', async () => {
    server.use(mock.post(`${API}/auth/refresh`, () => HttpResponse.json(tokens('acc2', 'ref2'))));
    fesMock.mockImplementation(async (_url, init) => {
      if (init.headers?.Authorization === 'Bearer acc') {
        try {
          await init.onopen?.(sseResponse(401));
        } catch (err) {
          init.onerror?.(err);
        }
        return;
      }
      await runStream(init, [['done', donePrediction]]);
    });
    const h = handlers();

    await streamPrediction(JOB_ID, h, { signal: new AbortController().signal });

    expect(fesMock).toHaveBeenCalledTimes(2);
    expect(fesMock.mock.calls[1]?.[1].headers).toMatchObject({ Authorization: 'Bearer acc2' });
    expect(h.onDone).toHaveBeenCalled();
  });

  it('stops quietly when the caller aborts', async () => {
    const controller = new AbortController();
    fesMock.mockImplementation(
      (_url, init) =>
        new Promise<void>((resolve) => {
          if (init.signal?.aborted) resolve();
          init.signal?.addEventListener('abort', () => resolve());
        }),
    );
    const p = streamPrediction(JOB_ID, handlers(), { signal: controller.signal });
    controller.abort();
    await expect(p).resolves.toBeUndefined();
  });
});
