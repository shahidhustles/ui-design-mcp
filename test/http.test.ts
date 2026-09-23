import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, __resetLimitersForTests, fetchJson } from '../src/http.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  cacheDir: '/tmp/uimcp-test',
  rateLimitMs: 0,
  maxResults: 24,
  timeoutMs: 5000,
  retryBaseMs: 10,
  fakeOffline: false,
  catalogTtlDays: 7,
  facetTtlDays: 7,
};

beforeEach(() => __resetLimitersForTests());
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('http', () => {
  it('retries 500s then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 3) return jsonResponse({ e: 1 }, 500);
        return jsonResponse({ ok: true });
      }),
    );
    const out = await fetchJson<{ ok: boolean }>('test', 'https://example.test/a', cfg);
    expect(out).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable 404', async () => {
    const mock = vi.fn(async () => jsonResponse({ error: 'nope' }, 404));
    vi.stubGlobal('fetch', mock);
    await expect(fetchJson('test', 'https://example.test/b', cfg)).rejects.toThrow(HttpError);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After on 429', async () => {
    const mock = vi.fn(async () => {
      if (mock.mock.calls.length < 2) return jsonResponse({}, 429, { 'retry-after': '0.05' });
      return jsonResponse({ ok: 2 });
    });
    vi.stubGlobal('fetch', mock);
    const t0 = Date.now();
    await fetchJson('test', 'https://example.test/c', cfg);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('throws the last HttpError after exhausting retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ e: 1 }, 503)));
    await expect(fetchJson('test', 'https://example.test/d', cfg)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('fake offline throws before any network', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    await expect(
      fetchJson('test', 'https://example.test/e', { ...cfg, fakeOffline: true }),
    ).rejects.toThrow(/fake offline/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('aborts on timeout and surfaces HttpError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    await expect(
      fetchJson('test', 'https://example.test/f', { ...cfg, timeoutMs: 40 }),
    ).rejects.toThrow(HttpError);
  });

  it('paces concurrent requests for the same source', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    const t0 = Date.now();
    await Promise.all([
      fetchJson('paced', 'https://example.test/1', { ...cfg, rateLimitMs: 60 }),
      fetchJson('paced', 'https://example.test/2', { ...cfg, rateLimitMs: 60 }),
      fetchJson('paced', 'https://example.test/3', { ...cfg, rateLimitMs: 60 }),
    ]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
  });
});
