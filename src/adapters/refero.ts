import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import { fetchJson } from '../http.js';
import { log } from '../log.js';
import type { FacetItem, Platform, UIScreen, UIFlow } from '../types.js';
import type { Adapter, FlowQuery, Health, SearchQuery } from './adapter.js';

export const SOURCE = 'refero';
const API = 'https://api.refero.design/v1';

// ── Live shapes (verified 2026-09-23, fixtures in test/fixtures/) ────────

/** GET /v1/search envelope. Records live under `records` (NOT `results`/`data`). */
export interface ReferoSearchResponse {
  pagination: { current: number; next: number | null; pages: number; count: number };
  records: ReferoRecord[];
  options: { search_uuid: string | null };
}

export interface ReferoTag {
  id: number;
  kind: string;
  name: string;
}

export interface ReferoSite {
  id: number;
  domain: string;
  favicon_url: string;
  description?: string;
  name: string;
}

export interface ReferoFont {
  id: number;
  name: string | null;
  display_name: string | null;
}

export interface ReferoRecord {
  id: number;
  uuid: string;
  width: number;
  height: number;
  created_at: string;
  /** Full-res frames, in order */
  url: string[];
  thumbnail_url: string;
  preview_url: string;
  video_url: string | null;
  video_preview_url: string | null;
  /** REAL source page URL */
  page_url: string;
  /** null for iOS app screenshots */
  site: ReferoSite | null;
  page_types: ReferoTag[];
  design_patterns: ReferoTag[];
  page_elements: ReferoTag[];
  flow_ids: number[];
  /** [r, g, b] triplets */
  colors: number[][];
  fonts: ReferoFont[];
  single_screen: boolean;
}

export interface ReferoFlowScreenshot {
  id: number;
  uuid: string;
  url: string[];
  thumbnail_url: string;
  preview_url: string;
}

export interface ReferoFlow {
  id: number;
  name: string;
  description?: string;
  site: ReferoSite | null;
  /** Ordered */
  screenshots: ReferoFlowScreenshot[];
}

// ── Facet dictionaries ─────────────────────────────────────────────────────

export const FACET_KINDS = ['page_types', 'design_patterns', 'page_elements', 'apps', 'sites'] as const;
export type FacetKind = (typeof FACET_KINDS)[number];

/**
 * Map user tags to Refero facet id params. Exact lowercase name match,
 * priority page_types > design_patterns > page_elements > apps > sites.
 * One facet per tag; unmatched tags are reported, not fatal.
 */
export function mapTagsToFacets(
  tags: string[] | undefined,
  facets: Record<string, FacetItem[]>,
): { params: URLSearchParams; matched: string[]; unknown: string[] } {
  const params = new URLSearchParams();
  const matched: string[] = [];
  const unknown: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    let hit: { kind: FacetKind; id: string } | null = null;
    for (const kind of FACET_KINDS) {
      const item = (facets[kind] ?? []).find((f) => f.name.toLowerCase() === tag);
      if (item) {
        hit = { kind, id: item.id };
        break;
      }
    }
    if (hit) {
      params.append(`${hit.kind}[id][]`, hit.id);
      matched.push(tag);
    } else {
      unknown.push(tag);
    }
  }
  return { params, matched, unknown };
}

export function searchUrl(
  query: string | undefined,
  opts: { page?: number; order?: 'trending' | 'newest' | 'oldest'; extra?: URLSearchParams } = {},
): string {
  const p = new URLSearchParams();
  if (query) p.set('query', query);
  p.set('page', String(opts.page ?? 1));
  if (opts.order) p.set('order', opts.order);
  for (const [k, v] of opts.extra ?? new URLSearchParams()) p.append(k, v);
  return `${API}/search?${p.toString()}`;
}

/**
 * `apps` and `sites` endpoints are paginated ({pagination, records});
 * page_types/design_patterns/page_elements are bare complete lists.
 */
async function fetchFacetPage(
  kind: FacetKind,
  page: number,
  cfg: Config,
): Promise<{ items: FacetItem[]; pages: number }> {
  const url =
    kind === 'apps' || kind === 'sites' ? `${API}/${kind}/available?page=${page}` : `${API}/${kind}/available`;
  const body = await fetchJson<unknown>(SOURCE, url, cfg);
  let items: unknown[] = [];
  let pages = 1;
  if (Array.isArray(body)) {
    items = body;
  } else if (body && typeof body === 'object') {
    const o = body as { records?: unknown[]; pagination?: { pages?: number } };
    items = o.records ?? [];
    pages = o.pagination?.pages ?? 1;
  }
  const toItem = (raw: Record<string, unknown>): FacetItem => ({
    id: String(raw['id'] ?? raw['uuid'] ?? ''),
    name: String(kind === 'sites' ? raw['domain'] ?? raw['name'] ?? '' : raw['name'] ?? raw['domain'] ?? ''),
  });
  return {
    items: (items as Record<string, unknown>[]).filter((r) => r && typeof r === 'object').map(toItem),
    pages,
  };
}

/** Load/refresh facet dictionaries into sqlite (TTL-gated). */
export async function loadFacets(store: MetadataStore, cfg: Config): Promise<void> {
  const now = Date.now();
  for (const kind of FACET_KINDS) {
    const fetchedAt = store.facetsFetchedAt(kind);
    const fresh = fetchedAt !== null && now - Date.parse(fetchedAt) < cfg.facetTtlDays * 86_400_000;
    if (fresh && store.getFacets(kind).length > 0) continue;
    try {
      let all: FacetItem[] = [];
      let page = 1;
      let pages = 1;
      do {
        const res = await fetchFacetPage(kind, page, cfg);
        all = all.concat(res.items);
        pages = res.pages;
        page++;
      } while (page <= pages && page <= 30);
      store.setFacets(kind, all, new Date().toISOString());
      log(`loaded ${all.length} ${kind} facets`);
    } catch (e) {
      log(`facet refresh failed for ${kind}:`, e instanceof Error ? e.message : e);
    }
  }
}

// ── Record mapping (pure) ─────────────────────────────────────────────────

/** rgb triplet / {r,g,b} / "rgb(…)" / "#hex" → "#rrggbb" (clamped). */
export function toHex(rgb: number[] | { r: number; g: number; b: number } | string): string | null {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  if (Array.isArray(rgb)) {
    const r = rgb[0];
    const g = rgb[1];
    const b = rgb[2];
    if (r === undefined || g === undefined || b === undefined) return null;
    return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
  }
  if (typeof rgb === 'string') {
    if (/^#[0-9a-f]{6}$/i.test(rgb)) return rgb.toLowerCase();
    const m = rgb.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) return `#${clamp(Number(m[1]))}${clamp(Number(m[2]))}${clamp(Number(m[3]))}`;
    return null;
  }
  if (rgb.r !== undefined && rgb.g !== undefined && rgb.b !== undefined) {
    return `#${clamp(rgb.r)}${clamp(rgb.g)}${clamp(rgb.b)}`;
  }
  return null;
}

function tagsOf(r: Pick<ReferoRecord, 'page_types' | 'design_patterns' | 'page_elements'>): string[] {
  return [...(r.page_types ?? []), ...(r.design_patterns ?? []), ...(r.page_elements ?? [])]
    .map((t) => t.name.trim().toLowerCase())
    .filter(Boolean);
}

function appOf(site: ReferoSite | null): UIScreen['app'] {
  return site ? { name: site.name, slug: site.domain, logoUrl: site.favicon_url } : undefined;
}

function platformOf(site: ReferoSite | null): Platform {
  return site ? 'web' : 'ios';
}

export function mapRecord(r: ReferoRecord): UIScreen {
  let title: string | undefined;
  if (r.site) {
    try {
      const path = new URL(r.page_url).pathname.replace(/^\//, '').replace(/\/$/, '');
      if (path) title = path;
    } catch {
      title = undefined;
    }
  }
  return {
    id: `${SOURCE}:${r.uuid}`,
    source: SOURCE,
    kind: r.video_url || (r.url ?? []).length > 1 ? 'flow' : 'screen',
    platform: platformOf(r.site),
    app: appOf(r.site),
    title,
    tags: tagsOf(r),
    imageUrls: r.url ?? [],
    cachedUrls: [],
    thumbnailUrl: r.preview_url ?? r.thumbnail_url,
    videoUrl: r.video_url ?? undefined,
    colors: (r.colors ?? []).map(toHex).filter((c): c is string => c !== null),
    fonts: (r.fonts ?? [])
      .map((f) => f.display_name ?? f.name)
      .filter((f): f is string => !!f),
    sourceUrl: r.page_url,
    capturedAt: r.created_at,
  };
}

export function mapFlow(f: ReferoFlow): UIFlow {
  const platform = platformOf(f.site);
  const siteUrl = f.site ? `https://${f.site.domain}` : `https://refero.design`;
  const steps: UIScreen[] = (f.screenshots ?? []).map((s, i) => ({
    id: `${SOURCE}:flow:${f.id}:step:${i + 1}`,
    source: SOURCE,
    kind: 'screen',
    platform,
    app: appOf(f.site),
    title: `${f.name} — step ${i + 1}`,
    tags: [],
    imageUrls: s.url ?? [],
    cachedUrls: [],
    thumbnailUrl: s.preview_url ?? s.thumbnail_url,
    sourceUrl: siteUrl,
  }));
  return {
    id: `${SOURCE}:flow:${f.id}`,
    source: SOURCE,
    kind: 'flow',
    platform,
    app: appOf(f.site),
    title: f.name,
    tags: [],
    imageUrls: steps[0]?.imageUrls ?? [],
    cachedUrls: [],
    thumbnailUrl: steps[0]?.thumbnailUrl,
    sourceUrl: siteUrl,
    steps,
  };
}

// ── Adapter ────────────────────────────────────────────────────────────────

export function createReferoAdapter(store: MetadataStore, cfg: Config): Adapter {
  async function rawSearch(query: string | undefined): Promise<ReferoRecord[]> {
    const body = await fetchJson<ReferoSearchResponse>(SOURCE, searchUrl(query), cfg);
    return body.records ?? [];
  }

  function byPlatform(records: ReferoRecord[], platform: Platform | undefined): ReferoRecord[] {
    if (!platform || platform === 'unknown') return records;
    return records.filter((r) => platformOf(r.site) === platform);
  }

  return {
    name: SOURCE,
    capabilities: {
      platforms: ['web', 'ios'],
      kinds: ['screen', 'flow'],
      search: true,
      flows: true,
    },

    async healthCheck(): Promise<Health> {
      try {
        await fetchJson<unknown>(SOURCE, `${API}/page_types/available`, cfg);
        return { ok: true };
      } catch (e) {
        return { ok: false, note: e instanceof Error ? e.message : String(e) };
      }
    },

    async searchScreens(q: SearchQuery): Promise<UIScreen[]> {
      await loadFacets(store, cfg);
      const facets: Record<string, FacetItem[]> = {};
      for (const kind of FACET_KINDS) facets[kind] = store.getFacets(kind);
      const { params, unknown } = mapTagsToFacets(q.tags, facets);
      if (unknown.length > 0) log(`unmatched tags (ignored): ${unknown.join(', ')}`);
      const records = byPlatform(await rawSearch(q.query), q.platform).map(mapRecord);
      for (const rec of records) {
        store.upsertRecord({
          id: rec.id,
          source: rec.source,
          kind: rec.kind,
          platform: rec.platform,
          payloadJson: JSON.stringify(rec),
          createdAt: rec.capturedAt ?? new Date().toISOString(),
        });
      }
      return records;
    },

    async getFlows(q: FlowQuery): Promise<UIFlow[]> {
      const limit = Math.min(q.limit ?? 5, 10);
      const records = byPlatform(await rawSearch(q.query ?? q.app), q.platform);
      const ids: number[] = [];
      for (const r of records) {
        for (const fid of r.flow_ids ?? []) if (!ids.includes(fid)) ids.push(fid);
      }
      const flows: UIFlow[] = [];
      for (const fid of ids.slice(0, limit)) {
        try {
          const flow = await fetchJson<ReferoFlow>(SOURCE, `${API}/flows/${fid}`, cfg);
          flows.push(mapFlow(flow));
        } catch (e) {
          log(`flow ${fid} failed:`, e instanceof Error ? e.message : e);
        }
      }
      return flows;
    },
  };
}
