import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createReferoAdapter,
  FACET_KINDS,
  loadFacets,
  mapFlow,
  mapRecord,
  mapTagsToFacets,
  searchUrl,
  toHex,
  type ReferoFlow,
  type ReferoRecord,
  type ReferoSearchResponse,
} from '../src/adapters/refero.js';
import { MetadataStore } from '../src/cache/metadata.js';
import type { Config } from '../src/config.js';
import type { FacetItem } from '../src/types.js';

const search = JSON.parse(readFileSync('test/fixtures/refero-search-checkout.json', 'utf8')) as ReferoSearchResponse;
const flow = JSON.parse(readFileSync('test/fixtures/refero-flow-detail.json', 'utf8')) as ReferoFlow;
const facetsRaw = JSON.parse(readFileSync('test/fixtures/refero-facets.json', 'utf8')) as Record<
  string,
  Array<{ id: number; name?: string; domain?: string }>
>;
const facets: Record<string, FacetItem[]> = Object.fromEntries(
  Object.entries(facetsRaw).map(([kind, items]) => [
    kind,
    items.map((i) => ({ id: String(i.id), name: String(i.name ?? i.domain ?? '') })),
  ]),
);

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('toHex', () => {
  it('converts rgb triplets', () => {
    expect(toHex([41, 42, 47])).toBe('#292a2f');
    expect(toHex([251, 251, 251])).toBe('#fbfbfb');
    expect(toHex([235, 52, 28])).toBe('#eb341c');
  });
  it('clamps out-of-range values', () => {
    expect(toHex([300, -5, 256])).toBe('#ff00ff');
  });
  it('passes through hex and parses rgb() strings', () => {
    expect(toHex('#AABBCC')).toBe('#aabbcc');
    expect(toHex('rgb(10, 20, 30)')).toBe('#0a141e');
  });
  it('rejects junk', () => {
    expect(toHex([1, 2])).toBeNull();
    expect(toHex('nope')).toBeNull();
  });
});

describe('mapRecord', () => {
  it('maps a live web record', () => {
    const rec = search.records[0] as ReferoRecord;
    const out = mapRecord(rec);
    expect(out.id).toBe(`refero:${rec.uuid}`);
    expect(out.source).toBe('refero');
    expect(out.platform).toBe('web');
    expect(out.app?.name).toBe(rec.site?.name);
    expect(out.tags).toContain('checkout'); // page_types → lowercase tags
    expect(out.sourceUrl).toBe(rec.page_url);
    expect(out.imageUrls).toBe(rec.url);
    expect(out.cachedUrls).toEqual([]);
    expect(out.colors.length).toBe(rec.colors.length);
    expect(out.colors[0]).toMatch(/^#[0-9a-f]{6}$/);
    expect(out.thumbnailUrl).toBe(rec.preview_url);
    expect(out.fonts).not.toContain(null);
  });

  it('maps site-less records as iOS', () => {
    const rec = { ...(search.records[0] as ReferoRecord), site: null };
    expect(mapRecord(rec).platform).toBe('ios');
  });

  it('marks multi-frame or videoed records as flows', () => {
    const rec = search.records[0] as ReferoRecord;
    expect(mapRecord(rec).kind).toBe(rec.url.length > 1 ? 'flow' : 'screen');
    expect(mapRecord({ ...rec, url: ['one.jpg'], video_url: null }).kind).toBe('screen');
  });
});

describe('mapFlow', () => {
  it('maps an ordered flow', () => {
    const out = mapFlow(flow);
    expect(out.kind).toBe('flow');
    expect(out.title).toBe(flow.name);
    expect(out.steps.length).toBe(flow.screenshots.length);
    expect(out.steps.length).toBeGreaterThan(1);
    expect(out.steps[0]?.imageUrls.length).toBeGreaterThan(0);
    expect(out.steps[0]?.id).toBe(`refero:flow:${flow.id}:step:1`);
  });
});

describe('mapTagsToFacets', () => {
  // Fixture-driven: the trimmed facets file only carries the first items of
  // each dictionary, so match on whatever the fixture actually holds.
  const firstPageType = facets['page_types']?.[0]!;

  it('matches tags to facet ids with id-bracket params', () => {
    const { params, matched, unknown } = mapTagsToFacets([firstPageType.name.toUpperCase(), 'wibble'], facets);
    expect(matched).toEqual([firstPageType.name.toLowerCase()]);
    expect(unknown).toEqual(['wibble']);
    expect(decodeURIComponent(params.toString())).toContain(`page_types[id][]=${firstPageType.id}`);
  });

  it('emits the documented app_id/site_id filter names for apps and sites', () => {
    const app = facets['apps']?.[0]!;
    const site = facets['sites']?.[0]!;
    const { params, matched } = mapTagsToFacets([app.name, site.name], facets);
    expect(matched).toEqual([app.name.toLowerCase(), site.name.toLowerCase()]);
    const qs = decodeURIComponent(params.toString());
    expect(qs).toContain(`app_id[id][]=${app.id}`);
    expect(qs).toContain(`site_id[id][]=${site.id}`);
    expect(qs).not.toContain(`apps[id][]`);
    expect(qs).not.toContain(`sites[id][]`);
  });

  it('is case-insensitive and empty-safe', () => {
    const { params, unknown } = mapTagsToFacets([], facets);
    expect(params.toString()).toBe('');
    expect(unknown).toEqual([]);
    const { matched } = mapTagsToFacets([`  ${firstPageType.name}  `], facets);
    expect(matched).toEqual([firstPageType.name.toLowerCase()]);
  });
});

describe('searchUrl', () => {
  it('builds query + pagination + facet params', () => {
    const extra = new URLSearchParams();
    extra.append('page_types[id][]', '9');
    const url = searchUrl('checkout', { page: 2, order: 'newest', extra });
    const qs = decodeURIComponent(new URL(url).searchParams.toString().replace(/\+/g, ' '));
    expect(url).toContain('/v1/search?');
    expect(qs).toContain('query=checkout');
    expect(qs).toContain('page=2');
    expect(qs).toContain('order=newest');
    expect(qs).toContain('page_types[id][]=9');
  });

  it('omits query when browsing', () => {
    expect(searchUrl(undefined)).toContain('page=1');
    expect(searchUrl(undefined)).not.toContain('query=');
  });
});

describe('loadFacets', () => {
  let dir: string;
  let store: MetadataStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'uimcp-refero-'));
    store = new MetadataStore(path.join(dir, 'meta.sqlite'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the stored dictionary when a 200 returns an empty list', async () => {
    const kind = 'apps';
    const seed = facets[kind]!;
    store.setFacets(kind, seed, '2020-01-01T00:00:00.000Z'); // stale → refresh runs
    const fetchMock = vi.fn(async () => jsonResponse({ pagination: { pages: 1 }, records: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await loadFacets(store, cfg);
    expect(fetchMock).toHaveBeenCalled();
    expect(store.getFacets(kind).map((f) => f.id).sort()).toEqual(seed.map((f) => f.id).sort());
  });

  it('still refreshes when the list is non-empty', async () => {
    const kind = 'page_types';
    const seed = facets[kind]!;
    store.setFacets(kind, seed.slice(0, 2), '2020-01-01T00:00:00.000Z'); // stale → refresh runs
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(seed.map((f) => ({ id: Number(f.id), name: f.name })))));
    await loadFacets(store, cfg);
    expect(store.getFacets(kind).length).toBe(seed.length);
  });
});

describe('createReferoAdapter', () => {
  let dir: string;
  let store: MetadataStore;
  let adapter: ReturnType<typeof createReferoAdapter>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'uimcp-refero-'));
    store = new MetadataStore(path.join(dir, 'meta.sqlite'));
    // Fresh timestamps → loadFacets skips the network; only the search hits fetch.
    for (const kind of FACET_KINDS) store.setFacets(kind, facets[kind] ?? [], new Date().toISOString());
    adapter = createReferoAdapter(store, cfg);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function mkRecord(i: number): ReferoRecord {
    return { ...(search.records[0] as ReferoRecord), uuid: `uuid-${i}` };
  }

  function searchEnvelope(page: number, records: ReferoRecord[]): ReferoSearchResponse {
    return {
      pagination: { current: page, next: null, pages: 99, count: 999 },
      records,
      options: { search_uuid: null },
    };
  }

  it('sends the matched tag facet params in the search request', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        urls.push(String(url));
        return jsonResponse(search);
      }),
    );
    const app = facets['apps']?.[0]!;
    const site = facets['sites']?.[0]!;
    const out = await adapter.searchScreens!({ query: 'checkout', tags: [app.name, site.name], limit: 10 });
    expect(out.length).toBe(search.records.length);
    const req = new URL(urls[0]!);
    expect(req.pathname).toBe('/v1/search');
    expect(req.searchParams.get('query')).toBe('checkout');
    expect(req.searchParams.get('app_id[id][]')).toBe(app.id);
    expect(req.searchParams.get('site_id[id][]')).toBe(site.id);
    expect(req.searchParams.get('apps[id][]')).toBeNull();
    expect(req.searchParams.get('sites[id][]')).toBeNull();
  });

  it('walks further pages until limit is collected, deduping by uuid', async () => {
    const pages: number[][] = [
      [1, 2, 3],
      [3, 4, 5], // uuid-3 repeats
    ];
    const pagesSeen: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const p = Number(new URL(String(url)).searchParams.get('page') ?? 1);
        pagesSeen.push(p);
        return jsonResponse(searchEnvelope(p, (pages[p - 1] ?? []).map(mkRecord)));
      }),
    );
    const out = await adapter.searchScreens!({ query: 'checkout', limit: 5 });
    expect(out.map((r) => r.id)).toEqual([
      'refero:uuid-1',
      'refero:uuid-2',
      'refero:uuid-3',
      'refero:uuid-4',
      'refero:uuid-5',
    ]);
    expect(pagesSeen).toEqual([1, 2]);
  });

  it('stops on an empty page', async () => {
    const pagesSeen: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const p = Number(new URL(String(url)).searchParams.get('page') ?? 1);
        pagesSeen.push(p);
        const records = p === 1 ? [mkRecord(1), mkRecord(2)] : [];
        return jsonResponse(searchEnvelope(p, records));
      }),
    );
    const out = await adapter.searchScreens!({ query: 'checkout', limit: 48 });
    expect(out.length).toBe(2);
    expect(pagesSeen).toEqual([1, 2]);
  });

  it('caps the page walk at 5 pages', async () => {
    const pagesSeen: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const p = Number(new URL(String(url)).searchParams.get('page') ?? 1);
        pagesSeen.push(p);
        return jsonResponse(searchEnvelope(p, [mkRecord(p * 10), mkRecord(p * 10 + 1)]));
      }),
    );
    const out = await adapter.searchScreens!({ query: 'checkout', limit: 48 });
    expect(pagesSeen).toEqual([1, 2, 3, 4, 5]);
    expect(out.length).toBe(10);
  });
});
