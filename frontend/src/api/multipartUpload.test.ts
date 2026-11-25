import { describe, expect, it, vi } from 'vitest';
import {
  InvalidMultipartPlanError,
  PartUploadError,
  sliceParts,
  uploadMultipart,
  type MultipartUploadOptions,
} from './multipartUpload';
import type { MultipartPlan } from './types';

const urlOf = (n: number) => `/medimg/uploads/u1/f1/big.zip?partNumber=${n}&X-Amz-Signature=s${n}`;

function plan(partSize: number, count: number): MultipartPlan {
  return {
    partSize,
    parts: Array.from({ length: count }, (_, i) => ({ partNumber: i + 1, url: urlOf(i + 1) })),
  };
}

function bytes(length: number): Blob {
  return new Blob([new Uint8Array(length).map((_, i) => i % 251)]);
}

const partOf = (url: string) => Number(new URL(url, 'http://x').searchParams.get('partNumber'));

interface Call {
  part: number;
  init: RequestInit;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

/**
 * Fetch whose responses the test controls: every call stays pending until the test settles it,
 * and an aborted signal rejects it like the real fetch.
 */
function controlledFetch() {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = vi.fn((input: string, init?: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<Response>((resolve, reject) => {
      let open = true;
      const done = () => {
        if (open) inFlight -= 1;
        open = false;
      };
      const call: Call = {
        part: partOf(input),
        init: init ?? {},
        resolve: (r) => {
          done();
          resolve(r);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      };
      init?.signal?.addEventListener('abort', () =>
        call.reject(new DOMException('aborted', 'AbortError')),
      );
      calls.push(call);
    });
  });
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    calls,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const ok = (etag: string) => new Response(null, { status: 200, headers: { ETag: etag } });

/** Lets the scheduler react to settled promises. */
const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitForCalls(f: { calls: Call[] }, n: number) {
  await vi.waitFor(() => expect(f.calls.length).toBeGreaterThanOrEqual(n));
}

function options(overrides: Partial<MultipartUploadOptions>): MultipartUploadOptions {
  return {
    file: bytes(10),
    plan: plan(4, 3),
    retryDelayMs: () => 0,
    ...overrides,
  };
}

describe('sliceParts', () => {
  it('cuts the file at partSize, the last part shorter, in ascending part order', () => {
    const shuffled: MultipartPlan = { partSize: 4, parts: [...plan(4, 3).parts].reverse() };
    expect(sliceParts(10, shuffled)).toEqual([
      { partNumber: 1, url: urlOf(1), start: 0, end: 4 },
      { partNumber: 2, url: urlOf(2), start: 4, end: 8 },
      { partNumber: 3, url: urlOf(3), start: 8, end: 10 },
    ]);
  });

  it.each([
    ['too few parts', 10, plan(4, 2)],
    ['too many parts', 8, plan(4, 3)],
    [
      'a gap in the numbering',
      10,
      { partSize: 4, parts: [1, 2, 4].map((n) => ({ partNumber: n, url: urlOf(n) })) },
    ],
    ['a zero part size', 10, { partSize: 0, parts: [] }],
  ])('rejects a plan with %s', (_name, size, bad) => {
    expect(() => sliceParts(size, bad)).toThrow(InvalidMultipartPlanError);
  });
});

describe('uploadMultipart', () => {
  it('keeps at most 3 parts in flight and sends each byte range without Authorization or Content-Type', async () => {
    const f = controlledFetch();
    const file = bytes(20);
    const progress: number[] = [];
    const done = uploadMultipart(
      options({
        file,
        plan: plan(4, 5),
        fetch: f.fetchImpl,
        onProgress: (loaded, total) => {
          expect(total).toBe(20);
          progress.push(loaded);
        },
      }),
    );

    await waitForCalls(f, 3);
    await flush();
    expect(f.calls.map((c) => c.part)).toEqual([1, 2, 3]);
    expect(f.inFlight).toBe(3);

    f.calls[1]?.resolve(ok('"e2"'));
    await waitForCalls(f, 4);
    await flush();
    expect(f.calls).toHaveLength(4);
    for (const c of f.calls.slice(2)) c.resolve(ok(`"e${c.part}"`));
    await waitForCalls(f, 5);
    f.calls[4]?.resolve(ok('"e5"'));
    f.calls[0]?.resolve(ok('"e1"'));

    await expect(done).resolves.toEqual(
      [1, 2, 3, 4, 5].map((n) => ({ partNumber: n, etag: `"e${n}"` })),
    );
    expect(f.maxInFlight).toBe(3);

    const first = f.calls[0]?.init;
    expect(first?.method).toBe('PUT');
    expect(first?.headers).toBeUndefined();
    const body = first?.body as Blob;
    expect(body.size).toBe(4);
    expect(body.type).toBe('');
    expect(new Uint8Array(await body.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect((f.calls[4]?.init.body as Blob).size).toBe(4);

    // Byte progress grows by each finished part, whatever the order.
    expect(progress).toEqual([4, 8, 12, 16, 20]);
  });

  it('returns the parts in ascending order even when they finish out of order', async () => {
    const f = controlledFetch();
    const done = uploadMultipart(options({ fetch: f.fetchImpl }));
    await waitForCalls(f, 3);
    f.calls[2]?.resolve(ok('"c"'));
    f.calls[0]?.resolve(ok('"a"'));
    f.calls[1]?.resolve(ok('"b"'));
    await expect(done).resolves.toEqual([
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
      { partNumber: 3, etag: '"c"' },
    ]);
  });

  it('retries a part after 5xx and network errors with growing backoff, up to 3 times', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const fetchImpl = vi.fn((input: string) => {
      if (partOf(input) !== 2) return Promise.resolve(ok('"x"'));
      attempts += 1;
      if (attempts === 1) return Promise.resolve(new Response(null, { status: 503 }));
      if (attempts === 2) return Promise.reject(new TypeError('Failed to fetch'));
      if (attempts === 3) return Promise.resolve(new Response(null, { status: 500 }));
      return Promise.resolve(ok('"after-retries"'));
    }) as unknown as typeof fetch;

    const parts = await uploadMultipart(
      options({
        fetch: fetchImpl,
        retryDelayMs: (retry) => {
          delays.push(retry);
          return 0;
        },
      }),
    );

    expect(attempts).toBe(4);
    expect(delays).toEqual([1, 2, 3]);
    expect(parts[1]).toEqual({ partNumber: 2, etag: '"after-retries"' });
  });

  it('gives up after the third retry and aborts the other parts', async () => {
    const signals: AbortSignal[] = [];
    let part2Attempts = 0;
    const fetchImpl = vi.fn((input: string, init?: RequestInit) => {
      if (partOf(input) === 2) {
        part2Attempts += 1;
        return Promise.resolve(new Response(null, { status: 502 }));
      }
      // Other parts hang until aborted.
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    }) as unknown as typeof fetch;

    const error = await uploadMultipart(options({ fetch: fetchImpl })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PartUploadError);
    expect(error).toMatchObject({ partNumber: 2, status: 502, retryable: true });
    expect(part2Attempts).toBe(4);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('does not retry an error that cannot heal (403 expired signature, missing ETag)', async () => {
    const forbidden = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
    await expect(
      uploadMultipart(options({ plan: plan(10, 1), fetch: forbidden })),
    ).rejects.toMatchObject({ status: 403, retryable: false });
    expect(forbidden).toHaveBeenCalledTimes(1);

    const noEtag = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    await expect(
      uploadMultipart(options({ plan: plan(10, 1), fetch: noEtag })),
    ).rejects.toMatchObject({ status: null, retryable: false });
    expect(noEtag).toHaveBeenCalledTimes(1);
  });

  it('aborts every part in flight and a pending retry when the signal aborts', async () => {
    const f = controlledFetch();
    const abort = new AbortController();
    let retryScheduled = false;
    const done = uploadMultipart(
      options({
        plan: plan(2, 5),
        fetch: f.fetchImpl,
        signal: abort.signal,
        retryDelayMs: () => {
          retryScheduled = true;
          return 60_000;
        },
      }),
    );
    await waitForCalls(f, 3);
    // Part 1 fails transiently and waits a minute before its retry.
    f.calls[0]?.resolve(new Response(null, { status: 500 }));
    await vi.waitFor(() => expect(retryScheduled).toBe(true));

    abort.abort();
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.inFlight).toBe(0);
    expect(f.calls.slice(1).every((c) => c.init.signal?.aborted)).toBe(true);
    // Nothing new starts after the abort.
    const started = f.calls.length;
    await flush();
    expect(f.calls).toHaveLength(started);
  });

  it('does not start at all with an already aborted signal', async () => {
    const f = controlledFetch();
    const abort = new AbortController();
    abort.abort();
    await expect(
      uploadMultipart(options({ fetch: f.fetchImpl, signal: abort.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toHaveLength(0);
  });
});
