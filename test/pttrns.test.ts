import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createPttrnsAdapter,
  mapPatternRecord,
  parseAppPagePatterns,
  parseCategoryTaxonomy,
  parsePatternDetail,
  slugify,
} from '../src/adapters/pttrns.js';
import { MetadataStore } from '../src/cache/metadata.js';
import type { Config } from '../src/config.js';
import type { UIScreen } from '../src/types.js';

const indexHtml = readFileSync('test/fixtures/pttrns-index.html', 'utf8');
const loomHtml = readFileSync('test/fixtures/pttrns-detail-loom.html', 'utf8');
const targetHtml = readFileSync('test/fixtures/pttrns-detail-target.html', 'utf8');
const airbnbHtml = readFileSync('test/fixtures/pttrns-app-airbnb.html', 'utf8');

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

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('slugify', () => {
  it('normalizes titles to site slugs', () => {
    expect(slugify('Signing up')).toBe('signing-up');
    expect(slugify('  Coach Mark  ')).toBe('coach-mark');
    expect(slugify('Onboarding & tips')).toBe('onboarding-tips');
  });
});

describe('parseCategoryTaxonomy', () => {
  const cats = parseCategoryTaxonomy(indexHtml);

  it('extracts the full 100-item category list with slugs and titles', () => {
    expect(cats.length).toBe(100);
    expect(cats.every((c) => c.slug && c.title)).toBe(true);
  });

  it('resolves known categories', () => {
    expect(cats.find((c) => c.slug === 'login')?.title).toBe('Login');
    expect(cats.find((c) => c.slug === 'button')?.title).toBe('Button');
    expect(cats.find((c) => c.slug === 'coach-mark')?.title).toBe('Coach Mark');
  });

  it('decodes HTML entities in titles', () => {
    const withAmp = cats.find((c) => c.title.includes('&'));
    expect(withAmp).toBeTruthy();
    expect(withAmp!.title).not.toMatch(/&amp;/);
  });
});

describe('parsePatternDetail', () => {
  const loom = parsePatternDetail(loomHtml)!;
  const target = parsePatternDetail(targetHtml)!;

  it('parses the recent Loom pattern (app + labels + -p-500 thumbnail)', () => {
    expect(loom.appName).toBe('Loom');
    expect(loom.appTagline).toBe('Video messaging for work.');
    expect(loom.appSlug).toBe('/applications/loom');
    expect(loom.appIconUrl).toBeTruthy();
    expect(loom.uxCategories).toEqual(['Walkthrough']);
    expect(loom.uiElements).toEqual(['Button', 'Progress Bar']);
    expect(loom.appCategory).toEqual(['Business']);
    expect(loom.imageUrl).toContain('IMG_5166');
    expect(loom.thumbnailUrl).toContain('-p-500');
    expect(loom.thumbnailUrl).not.toBe(loom.imageUrl);
  });

  it('parses the older Target pattern (no srcset → no thumbnail)', () => {
    expect(target.appName).toBe('Target');
    expect(target.appSlug).toBe('/applications/target');
    expect(target.uxCategories).toEqual(['Search', 'Content Detail']);
    expect(target.uiElements).toEqual([]);
    expect(target.appCategory).toEqual(['Shopping']);
    expect(target.thumbnailUrl).toBeUndefined();
    expect(target.imageUrl).toContain('website-files.com');
  });

  it('returns null when the layout changed (no screenshot or app name)', () => {
    expect(parsePatternDetail('<html><body>nothing</body></html>')).toBeNull();
  });
});

describe('parseAppPagePatterns', () => {
  const patterns = parseAppPagePatterns(airbnbHtml);

  it('extracts every pattern card with id, screenshot, thumbnail, app name', () => {
    expect(patterns.length).toBe(98);
    expect(patterns.every((p) => p.id && p.imageUrl && p.appName === 'Airbnb')).toBe(true);
  });

  it('orders by site grid order and carries the -p-500 variant when present', () => {
    expect(patterns[0]!.id).toBe('7686');
    expect(patterns[0]!.thumbnailUrl).toBeTruthy();
    expect(patterns[0]!.thumbnailUrl).toContain('-p-500');
  });

  it('returns [] for a page without pattern cards', () => {
    expect(parseAppPagePatterns('<html></html>')).toEqual([]);
  });
});

describe('mapPatternRecord', () => {
  const loom = parsePatternDetail(loomHtml)!;
  const rec = mapPatternRecord('10044', {
    appName: loom.appName,
    appSlug: loom.appSlug,
    appIconUrl: loom.appIconUrl,
    categories: [...loom.uxCategories, ...loom.uiElements, ...loom.appCategory],
    imageUrl: loom.imageUrl,
    thumbnailUrl: loom.thumbnailUrl,
  });

  it('builds the unified component record (pttrns:pattern:<id>, ios)', () => {
    expect(rec.id).toBe('pttrns:pattern:10044');
    expect(rec.source).toBe('pttrns');
    expect(rec.kind).toBe('component');
    expect(rec.platform).toBe('ios');
    expect(rec.app).toEqual({ name: 'Loom', slug: '/applications/loom', logoUrl: loom.appIconUrl });
    expect(rec.title).toBe('Loom — Walkthrough');
    expect(rec.tags).toEqual(expect.arrayContaining(['walkthrough', 'button', 'progress bar', 'business', 'loom']));
    expect(rec.imageUrls).toEqual([loom.imageUrl]);
    expect(rec.thumbnailUrl).toBe(loom.thumbnailUrl);
    expect(rec.cachedUrls).toEqual([]);
    expect(rec.sourceUrl).toBe('https://app.pttrns.com/patterns/10044');
  });
});

describe('createPttrnsAdapter', () => {
  let dir: string;
  let store: MetadataStore;
  let adapter: ReturnType<typeof createPttrnsAdapter>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'uimcp-pttrns-'));
    store = new MetadataStore(path.join(dir, 'meta.sqlite'));
    adapter = createPttrnsAdapter(store, cfg);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function stubFetch(routes: [string, () => Response][]): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
      const u = String(url);
      for (const [needle, make] of routes) {
        if (u.includes(needle)) return make();
      }
      return new Response('not stubbed: ' + u, { status: 404 });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('category query: taxonomy → filter API → detail pages, newest first', async () => {
    const fetchMock = stubFetch([
      ['api.jetboost.io/filter', () => jsonResponse({ '10044': true, '5000': true })],
      ['/patterns/10044', () => htmlResponse(loomHtml)],
      ['/patterns/5000', () => htmlResponse(targetHtml)],
      ['/patterns', () => htmlResponse(indexHtml)],
    ]);
    const out: UIScreen[] = await adapter.searchComponents!({ query: 'login', limit: 12 });
    expect(out.length).toBe(2);
    // 10044 > 5000 — newest id first.
    expect(out[0]!.id).toBe('pttrns:pattern:10044');
    expect(out[0]!.title).toBe('Loom — Walkthrough');
    expect(out[0]!.app?.slug).toBe('/applications/loom');
    expect(out[0]!.thumbnailUrl).toContain('-p-500');
    expect(out[1]!.id).toBe('pttrns:pattern:5000');
    expect(out[1]!.tags).toContain('shopping'); // app vertical is a tag
    expect(out[1]!.thumbnailUrl).toBeUndefined();
    // The filter call carries the category slug.
    const filterCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('api.jetboost.io/filter'));
    expect(filterCall).toBeDefined();
    expect(String(filterCall![0])).toContain('q=login');
    // Taxonomy once, one detail per picked id, nothing else.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/patterns')).length).toBe(1);
  });

  it('category query matches by title case-insensitively', async () => {
    stubFetch([
      ['api.jetboost.io/filter', () => jsonResponse({ '10044': true })],
      ['/patterns/10044', () => htmlResponse(loomHtml)],
      ['/patterns', () => htmlResponse(indexHtml)],
    ]);
    const out = await adapter.searchComponents!({ query: 'Login' });
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe('pttrns:pattern:10044');
  });

  it('synonym queries resolve to the site category ("onboarding" → guided-tour, "sign up" → signup)', async () => {
    const fetchMock = stubFetch([
      ['api.jetboost.io/filter', () => jsonResponse({ '10044': true })],
      ['/patterns/10044', () => htmlResponse(loomHtml)],
      ['/patterns', () => htmlResponse(indexHtml)],
    ]);
    const out = await adapter.searchComponents!({ query: 'onboarding' });
    expect(out.length).toBe(1);
    let filterCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('api.jetboost.io/filter'));
    expect(String(filterCall![0])).toContain('q=guided-tour');
    await adapter.searchComponents!({ query: 'Sign Up' });
    filterCall = fetchMock.mock.calls.filter((c) => String(c[0]).includes('api.jetboost.io/filter')).at(-1);
    expect(String(filterCall![0])).toContain('q=signup');
  });

  it('app-name query: falls through to the /applications page', async () => {
    const fetchMock = stubFetch([
      ['/applications/airbnb', () => htmlResponse(airbnbHtml)],
      ['/patterns', () => htmlResponse(indexHtml)],
    ]);
    const out: UIScreen[] = await adapter.searchComponents!({ query: 'airbnb', limit: 3 });
    expect(out.length).toBe(3); // capped at limit
    expect(out.every((r) => r.app?.name === 'Airbnb' && r.app?.slug === 'airbnb')).toBe(true);
    expect(out[0]!.id).toBe('pttrns:pattern:7686');
    // No filter call on the app axis.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('jetboost'))).toBe(false);
  });

  it('unknown query: app slugs 500 one by one → empty result', async () => {
    const fetchMock = stubFetch([
      ['/applications/', () => htmlResponse('<html>500</html>', 500)],
      ['/patterns', () => htmlResponse(indexHtml)],
    ]);
    const out = await adapter.searchComponents!({ query: 'lorem ipsum' });
    expect(out).toEqual([]);
    // slugify("lorem ipsum") + "lorem" + "ipsum" — deduped, one noRetry fetch each.
    const appCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/applications/'));
    expect(appCalls.length).toBe(3);
  });

  it('platform web → empty without any fetch (iOS-only corpus)', async () => {
    const fetchMock = stubFetch([['/patterns', () => htmlResponse(indexHtml)]]);
    const out = await adapter.searchComponents!({ query: 'login', platform: 'web' });
    expect(out).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('healthCheck warms the taxonomy cache; searchComponents reuses it', async () => {
    const fetchMock = stubFetch([
      ['api.jetboost.io/filter', () => jsonResponse({ '10044': true })],
      ['/patterns/10044', () => htmlResponse(loomHtml)],
      ['/patterns', () => htmlResponse(indexHtml)],
    ]);
    const h = await adapter.healthCheck();
    expect(h.ok).toBe(true);
    const out = await adapter.searchComponents!({ query: 'login' });
    expect(out.length).toBe(1);
    // /patterns fetched exactly once for the whole sequence — the taxonomy is meta-cached.
    const indexCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/patterns'));
    expect(indexCalls.length).toBe(1);
  });
});
