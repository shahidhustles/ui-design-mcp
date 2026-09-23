import type { Config } from './config.js';
import { log } from './log.js';

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /**
   * Single shot: throw on the first non-2xx instead of retrying. For
   * callers that manage their own (long) cooldown — e.g. the catalog
   * sync, where a 429 re-arms a sliding window and fast retries keep it
   * alive forever.
   */
  noRetry?: boolean;
}

class RateLimiter {
  private nextFree = 0;
  constructor(private readonly intervalMs: number) {}

  /**
   * Reserve a slot before sleeping so concurrent acquires space out instead
   * of all reading the same `last` and bursting together.
   */
  async acquire(): Promise<void> {
    if (this.intervalMs <= 0) return;
    const now = Date.now();
    const start = Math.max(now, this.nextFree);
    this.nextFree = start + this.intervalMs;
    if (start > now) await sleep(start - now);
  }
}

const limiters = new Map<string, RateLimiter>();

function limiterFor(source: string, intervalMs: number): RateLimiter {
  let limiter = limiters.get(source);
  if (!limiter) {
    limiter = new RateLimiter(intervalMs);
    limiters.set(source, limiter);
  }
  return limiter;
}

/** Test hook: concurrent test workers must not share spacing state. */
export function __resetLimitersForTests(): void {
  limiters.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return ms * (0.8 + Math.random() * 0.4);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * fetch with browser-like UA, per-source rate limit, timeout, and
 * 3 retries with backoff on network errors / timeouts / 429 / 5xx.
 * `intervalMs` overrides the per-source spacing (bulk syncs use slower keys).
 */
async function fetchWithRetry(
  source: string,
  url: string,
  cfg: Config,
  opts: FetchOpts = {},
  intervalMs?: number,
): Promise<Response> {
  if (cfg.fakeOffline) throw new HttpError(`fake offline (source=${source})`, undefined, url);
  const limiter = limiterFor(source, intervalMs ?? cfg.rateLimitMs);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    await limiter.acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        // undici's BodyInit typing rejects Buffer<ArrayBufferLike>; ours never
        // carries anything exotic, so cast at the boundary.
        body: opts.body as RequestInit['body'],
        signal: ctrl.signal,
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          ...(opts.headers ?? {}),
        },
      });
    } catch (e) {
      lastErr = new HttpError(
        `request failed: ${e instanceof Error ? e.message : String(e)} (${url})`,
        undefined,
        url,
      );
      await sleep(jitter(cfg.retryBaseMs * 2 ** attempt));
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res;
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    const retryable = (res.status === 429 || res.status >= 500) && !opts.noRetry;
    lastErr = new HttpError(`HTTP ${res.status} for ${url}`, res.status, url, retryAfterMs);
    if (!retryable) throw lastErr;
    await res.body?.cancel().catch(() => {});
    await sleep(jitter(Math.min(retryAfterMs ?? cfg.retryBaseMs * 2 ** attempt, 5_000)));
  }
  throw lastErr instanceof Error ? lastErr : new HttpError(`failed after retries: ${url}`, undefined, url);
}

export async function fetchJson<T>(
  source: string,
  url: string,
  cfg: Config,
  opts?: FetchOpts,
  intervalMs?: number,
): Promise<T> {
  const res = await fetchWithRetry(source, url, cfg, opts, intervalMs);
  return (await res.json()) as T;
}

export async function fetchText(
  source: string,
  url: string,
  cfg: Config,
  opts?: FetchOpts,
  intervalMs?: number,
): Promise<string> {
  const res = await fetchWithRetry(source, url, cfg, opts, intervalMs);
  return res.text();
}

export async function fetchBuffer(
  source: string,
  url: string,
  cfg: Config,
  opts?: FetchOpts,
  intervalMs?: number,
): Promise<Buffer> {
  const res = await fetchWithRetry(source, url, cfg, opts, intervalMs);
  return Buffer.from(await res.arrayBuffer());
}

/** Debug helper for smokes: fetch + log the shape of the top level. */
export async function probeShape(source: string, url: string, cfg: Config): Promise<string> {
  const res = await fetchWithRetry(source, url, cfg);
  const text = await res.text();
  log(`${url} → HTTP ${res.status}, ${text.length} bytes`);
  return text;
}
