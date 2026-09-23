import path from 'node:path';

export interface Config {
  /** Root for sqlite + image cache. UIMCP_CACHE_DIR, default ./data */
  cacheDir: string;
  /** Min spacing between requests per source. UIMCP_RATE_LIMIT_MS, default 500 */
  rateLimitMs: number;
  /** Default result cap per tool. UIMCP_MAX_RESULTS, default 24 */
  maxResults: number;
  /** Per-request timeout. Default 15000 */
  timeoutMs: number;
  /** Base retry delay; attempt N waits retryBaseMs * 2**N (jittered). Default 500 */
  retryBaseMs: number;
  /** UIMCP_FAKE_OFFLINE=1 → throw before any network (cache-hit tests) */
  fakeOffline: boolean;
  /** ScreensDesign catalog staleness before re-sync. Default 7 days */
  catalogTtlDays: number;
  /** Refero facet dictionary staleness before refresh. Default 7 days */
  facetTtlDays: number;
}

function intFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function boolFrom(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    cacheDir: env.UIMCP_CACHE_DIR ? path.resolve(env.UIMCP_CACHE_DIR) : path.resolve('data'),
    rateLimitMs: intFrom(env.UIMCP_RATE_LIMIT_MS, 500),
    maxResults: intFrom(env.UIMCP_MAX_RESULTS, 24),
    timeoutMs: intFrom(env.UIMCP_TIMEOUT_MS, 15_000),
    retryBaseMs: intFrom(env.UIMCP_RETRY_BASE_MS, 500),
    fakeOffline: boolFrom(env.UIMCP_FAKE_OFFLINE),
    catalogTtlDays: intFrom(env.UIMCP_CATALOG_TTL_DAYS, 7),
    facetTtlDays: intFrom(env.UIMCP_FACET_TTL_DAYS, 7),
  };
}
