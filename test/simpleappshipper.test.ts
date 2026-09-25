import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createSimpleAppShipperAdapter,
  filterUiElements,
  mapAppDetail,
  mapUiElement,
  storeIdFromUrl,
} from '../src/adapters/simpleappshipper.js';
import { MetadataStore } from '../src/cache/metadata.js';
import type { Config } from '../src/config.js';
import type { UIScreen } from '../src/types.js';

const sitemap = JSON.parse(readFileSync('test/fixtures/simpleappshipper-sitemap.json', 'utf8')) as {
  apps: { id: string; name: string }[];
};
const appDetail = JSON.parse(readFileSync('test/fixtures/simpleappshipper-app-detail.json', 'utf8')) as {
  app: { id: string; name: string; store_url?: string | null };
  screens: { id: string; screen_type?: string | null; image_url: string; uploaded_at?: string | null }[];
};
const uiElements = JSON.parse(readFileSync('test/fixtures/simpleappshipper-ui-elements.json', 'utf8')) as {
  ui_elements: {
    slug: string;
    name: string;
    category?: string | null;
    design_examples: { slug: string; title: string; description?: string | null; href?: string | null; image_url: string }[];
  }[];
};

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

describe('storeIdFromUrl', () => {
  it('extracts the App Store id', () => {
    expect(storeIdFromUrl('https://apps.apple.com/us/app/google-keep/id1029207872?uo=4')).toBe('1029207872');
  });
  it('returns undefined without an id', () => {
    expect(storeIdFromUrl(null)).toBeUndefined();
    expect(storeIdFromUrl(undefined)).toBeUndefined();
    expect(storeIdFromUrl('https://example.com/app')).toBeUndefined();
  });
});

describe('mapAppDetail', () => {
  const out = mapAppDetail(appDetail as never);

  it('maps the app profile (ios, store id from store_url)', () => {
    expect(out.app.name).toBe(appDetail.app.name);
    expect(out.app.platform).toBe('ios');
    expect(out.app.storeId).toBe('1029207872');
    expect(out.app.iconUrl).toBeTruthy();
    expect(out.app.category).toBe('Productivity');
  });

  it('returns every screen with attribution and screen_type tags', () => {
    expect(out.screens.length).toBe(15);
    const s0 = out.screens[0]!;
    expect(s0.id).toBe(`simpleappshipper:screen:${appDetail.screens[0]!.id}`);
    expect(s0.source).toBe('simpleappshipper');
    expect(s0.kind).toBe('screen');
    expect(s0.platform).toBe('ios');
    expect(s0.app?.name).toBe(appDetail.app.name);
    expect(s0.imageUrls).toEqual([appDetail.screens[0]!.image_url]);
    expect(s0.cachedUrls).toEqual([]);
    expect(s0.sourceUrl).toBe('https://simpleappshipper.com/library');
    expect(s0.capturedAt).toBe(appDetail.screens[0]!.uploaded_at ?? undefined);
    expect(s0.tags).toContain((appDetail.screens[0]!.screen_type ?? '').toLowerCase());
    expect(s0.tags).toContain('productivity');
  });

  it('orders screens by flow_index regardless of input order', () => {
    const indexById = new Map(appDetail.screens.map((s) => [s.id, (s as { flow_index?: number }).flow_index ?? 0]));
    for (const screens of [[...appDetail.screens].reverse(), appDetail.screens]) {
      const outShuffled = mapAppDetail({ ...appDetail, screens } as never);
      expect(outShuffled.screens.length).toBe(15);
      const idx = outShuffled.screens.map((s) => indexById.get(s.id.slice('simpleappshipper:screen:'.length))!);
      expect(idx).toEqual([...idx].sort((a, b) => a - b)); // non-decreasing flow_index
    }
  });
});

describe('mapUiElement + filterUiElements', () => {
  const buttons = uiElements.ui_elements.find((e) => e.slug === 'buttons')!;

  it('maps a ui-element to component records', () => {
    const out = mapUiElement(buttons);
    expect(out.length).toBe(buttons.design_examples.length);
    expect(out.every((r) => r.kind === 'component' && r.source === 'simpleappshipper')).toBe(true);
    expect(out.every((r) => r.platform === 'unknown')).toBe(true);
    const r0 = out[0]!;
    // Element slug is part of the id: example slugs are only unique per category.
    expect(r0.id).toBe(`simpleappshipper:component:buttons/${buttons.design_examples[0]!.slug}`);
    expect(r0.title).toBe(buttons.design_examples[0]!.title);
    expect(r0.tags).toContain('buttons');
    expect(r0.tags).toContain('input & action');
    expect(r0.imageUrls).toEqual([buttons.design_examples[0]!.image_url]);
    expect(r0.sourceUrl).toBe(`https://simpleappshipper.com${buttons.design_examples[0]!.href}`);
  });

  it('category name/slug match returns the whole element', () => {
    const out = filterUiElements(uiElements.ui_elements, 'button');
    expect(out.map((e) => e.slug)).toEqual(['buttons']);
    expect(out[0]!.design_examples.length).toBe(buttons.design_examples.length);
  });

  it('example-level match keeps only the matching examples', () => {
    const out = filterUiElements(uiElements.ui_elements, 'donut');
    expect(out.length).toBe(1);
    expect(out[0]!.slug).toBe('charts');
    expect(out[0]!.design_examples.map((e) => e.title)).toEqual(['Custom Donut Chart']);
  });

  it('empty query keeps everything; unknown query matches nothing', () => {
    expect(filterUiElements(uiElements.ui_elements, '').length).toBe(uiElements.ui_elements.length);
    expect(filterUiElements(uiElements.ui_elements, '  ')).toHaveLength(uiElements.ui_elements.length);
    expect(filterUiElements(uiElements.ui_elements, 'wibble')).toEqual([]);
  });
});

describe('createSimpleAppShipperAdapter', () => {
  let dir: string;
  let store: MetadataStore;
  let adapter: ReturnType<typeof createSimpleAppShipperAdapter>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'uimcp-sas-'));
    store = new MetadataStore(path.join(dir, 'meta.sqlite'));
    adapter = createSimpleAppShipperAdapter(store, cfg);
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

  it('getApp: prefix-matches the catalog, one detail call, ordered screens', async () => {
    const fetchMock = stubFetch([
      ['/api/sitemap', () => jsonResponse(sitemap)],
      ['/api/apps/', () => jsonResponse(appDetail)],
    ]);
    const out = await adapter.getApp!({ name: 'Google Keep' });
    expect(out.app.name).toBe(appDetail.app.name);
    expect(out.screens.length).toBe(15);
    expect(out.screens.every((s) => s.platform === 'ios')).toBe(true);
    // sitemap once + detail once.
    expect(fetchMock.mock.calls.length).toBe(2);
    // Second call: catalog served from sqlite, only the detail refetches.
    await adapter.getApp!({ name: 'Google Keep' });
    const sitemaps = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/sitemap'));
    expect(sitemaps.length).toBe(1);
  });

  it('unknown app → SourceError naming the app', async () => {
    stubFetch([['/api/sitemap', () => jsonResponse(sitemap)]]);
    await expect(adapter.getApp!({ name: 'Wibble Wobble' })).rejects.toThrow(
      /no Simple App Shipper app matching "Wibble Wobble"/,
    );
  });

  it('searchComponents returns component records, capped at limit', async () => {
    stubFetch([['/api/ui-elements', () => jsonResponse(uiElements)]]);
    const out: UIScreen[] = await adapter.searchComponents!({ query: 'button' });
    expect(out.length).toBe(4); // whole buttons category
    expect(out.every((r) => r.kind === 'component')).toBe(true);
    const limited = await adapter.searchComponents!({ query: '', limit: 5 });
    expect(limited.length).toBe(5); // 20 examples across 6 categories, capped
  });

  it('component queries match example text, not just categories', async () => {
    stubFetch([['/api/ui-elements', () => jsonResponse(uiElements)]]);
    const out = await adapter.searchComponents!({ query: 'donut' });
    expect(out.length).toBe(1);
    expect(out[0]!.title).toBe('Custom Donut Chart');
  });

  it('healthCheck ok, and its meta cache feeds searchComponents', async () => {
    const fetchMock = stubFetch([['/api/ui-elements', () => jsonResponse(uiElements)]]);
    const h = await adapter.healthCheck();
    expect(h.ok).toBe(true);
    await adapter.searchComponents!({ query: 'button' });
    // One /api/ui-elements for the whole sequence — the second read comes from meta.
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});
