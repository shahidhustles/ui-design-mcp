import type { MetadataStore } from '../../cache/metadata.js';
import type { Config } from '../../config.js';
import { HttpError, fetchJson } from '../../http.js';
import { log } from '../../log.js';
import type { CatalogApp } from '../../types.js';

export const SOURCE = 'screensdesign';
const CATALOG_API = 'https://api.screensdesign.com/v1/apps/';

interface CatalogPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: RawCatalogApp[];
}

/**
 * List endpoint (`/v1/apps/?page=N`) shape — verified 2026-09-23.
 * `store_id` / `appstore_link` / `category_primary` only exist on the
 * detail endpoint (`/v1/apps/<id>/`) and in the decoded SSR payload.
 */
interface RawCatalogApp {
  id: number;
  slug: string;
  name: string;
  shortname?: string;
  icon?: string;
  developer?: { id: number; name: string; slug: string };
  avs?: {
    id?: number;
    url?: string | null;
    screens?: unknown[];
    paywall_type?: string | null;
    onboarding_step_count?: number | null;
    has_onboarding_with_quiz?: boolean | null;
  } | null;
  revenue?: number | null;
  revenue_list?: { year: number; month: number; revenue: number }[];
  downloads?: number | null;
  /** "4.70" — a STRING */
  rating_value?: string | null;
  released?: string | null;
  updated?: string | null;
  advertised?: boolean;
  featured?: boolean;
  latest_appvideo_id?: number | null;
  store_id?: string | null;
  appstore_link?: string | null;
  category_primary?: string | null;
}

export function mapCatalogApp(raw: RawCatalogApp): CatalogApp {
  const rating = raw.rating_value === undefined || raw.rating_value === null
    ? null
    : Number(raw.rating_value);
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    storeId: raw.store_id ?? null,
    category: raw.category_primary ?? null,
    rating: Number.isFinite(rating as number) ? (rating as number) : null,
    downloads: raw.downloads ?? null,
    revenue: raw.revenue ?? null,
    paywallType: raw.avs?.paywall_type ?? null,
    onboardingStepCount: raw.avs?.onboarding_step_count ?? null,
    iconUrl: raw.icon ?? null,
    appstoreLink: raw.appstore_link ?? null,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Observed throttle behavior (2026-09-23): a token bucket (~30 req) that
 * on exhaustion 429s with `retry-after: 640` — and the window SLIDES:
 * any request (even a 429'd one) inside the cooldown re-arms it. The API
 * also degrades per-page size under sustained load (50 → 6/page) before
 * 429ing. So a burst of ~30 pages must be followed by total silence for
 * the full retry-after; fast retries otherwise keep the cooldown alive
 * forever. Crawl on its own limiter key, single-shot per page.
 */
const SYNC_SOURCE = 'screensdesign-catalog';
const SYNC_INTERVAL_MS = 1200;
const HARD_CAP_PAGES = 550; // 2,711 apps even at the degraded 6/page

async function fetchCatalogPage(url: string, cfg: Config): Promise<CatalogPage> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetchJson<CatalogPage>(SYNC_SOURCE, url, cfg, { noRetry: true }, SYNC_INTERVAL_MS);
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status === 429) {
        const wait = (e.retryAfterMs ?? 600_000) + 30_000;
        log(`catalog 429 — silent for ${Math.round(wait / 1000)}s (full retry-after window)`);
        await sleep(wait);
        continue;
      }
      if (attempt < 3) {
        log(`catalog page failed (${e instanceof Error ? e.message : e}) — retrying in 60s`);
        await sleep(60_000);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Full catalog sync: follow `next` links until null (2,711 apps).
 * Idempotent upserts; on mid-sync failure sets `catalog_partial` and the
 * next call resumes from `catalog_last_page + 1`. If that point has already
 * passed the page cap, resume falls back to a full resync from page 1 —
 * otherwise a pass that died exactly at the cap would re-run zero pages
 * forever. Resume is safe while the API holds its (degraded) per-page size
 * steady — if the size shifts, a few apps slip between pages and the 7-day
 * TTL full resync picks them up.
 */
export async function syncCatalog(
  store: MetadataStore,
  cfg: Config,
): Promise<{ synced: number; partial: boolean }> {
  const syncedAt = new Date().toISOString();
  const resumeFrom = Number(store.getMeta('catalog_last_page') ?? 0) || 0;
  let startPage = store.catalogPartial() && resumeFrom > 0 ? resumeFrom + 1 : 1;
  if (startPage > HARD_CAP_PAGES) {
    log(`catalog resume at page ${startPage} exceeds cap ${HARD_CAP_PAGES} — full resync from page 1`);
    startPage = 1;
  }
  let next: string | null = `${CATALOG_API}?page=${startPage}`;
  let page = startPage;
  let synced = 0;
  let partial = false;
  while (next && page <= HARD_CAP_PAGES) {
    try {
      const body = await fetchCatalogPage(next, cfg);
      const apps = (body.results ?? []).map(mapCatalogApp);
      if (apps.length > 0) {
        store.upsertApps(apps, syncedAt);
        synced += apps.length;
      }
      store.setMeta('catalog_last_page', String(page));
      next = body.next;
      page++;
    } catch (e) {
      log(`catalog sync stopping at page ${page}:`, e instanceof Error ? e.message : e);
      partial = true;
      break;
    }
  }
  if (next !== null && page > HARD_CAP_PAGES) partial = true;
  store.setCatalogSyncedAt(syncedAt, partial);
  log(`catalog sync done: ${synced} apps upserted over ${page - 1} pages, total ${store.appCount()}${partial ? ' (partial — retry next call)' : ''}`);
  return { synced, partial };
}

export function catalogFresh(store: MetadataStore, cfg: Config): boolean {
  const syncedAt = store.catalogSyncedAt();
  if (!syncedAt) return false;
  return Date.now() - Date.parse(syncedAt) < cfg.catalogTtlDays * 86_400_000 && store.appCount() > 0;
}
