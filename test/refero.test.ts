import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  mapFlow,
  mapRecord,
  mapTagsToFacets,
  searchUrl,
  toHex,
  type ReferoFlow,
  type ReferoRecord,
  type ReferoSearchResponse,
} from '../src/adapters/refero.js';
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
