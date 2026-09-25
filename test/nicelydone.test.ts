import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createNicelyDoneAdapter,
  mapFlow,
  mapPatternStep,
  patternImageUrl,
  productLogoUrl,
  slugify,
  type NdFlow,
} from '../src/adapters/nicelydone/index.js';
import { extractNuxtPayload, findFlowsNode, parseNuxtPayload } from '../src/adapters/nicelydone/decode.js';
import { MetadataStore } from '../src/cache/metadata.js';
import type { Config } from '../src/config.js';

const flowHtml = readFileSync('test/fixtures/nicelydone-flow-signing-up.html', 'utf8');
const appFlowsHtml = readFileSync('test/fixtures/nicelydone-app-flows.html', 'utf8');
const contentMeta = JSON.parse(readFileSync('test/fixtures/nicelydone-content-meta.json', 'utf8')) as {
  flowCategories: { slug: string; title: string; flows: NdFlow[] }[];
};
const contentApps = JSON.parse(readFileSync('test/fixtures/nicelydone-content-apps.json', 'utf8')) as {
  products: unknown[];
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
function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status });
}

describe('parseNuxtPayload', () => {
  it('decodes null-prototype objects with shared references', () => {
    const out = parseNuxtPayload(JSON.stringify([
      ['null', 'a', 1, 'b', 1], // shared ref 1 for both keys
      'x',
    ])) as Record<string, unknown>;
    expect(out.a).toBe('x');
    expect(out.b).toBe('x');
  });

  it('decodes plain arrays with -1 (undefined) and -2 (hole) sentinels', () => {
    const out = parseNuxtPayload(JSON.stringify([
      [1, -1, -2], // [ref→"v", undefined, hole]
      'v',
    ])) as unknown[];
    expect(out.length).toBe(3);
    expect(out[0]).toBe('v');
    expect(out[1]).toBeUndefined();
  });

  it('decodes the Date tag and throws on unknown tags', () => {
    const d = parseNuxtPayload(JSON.stringify([
      ['Date', '2026-01-02T03:04:05.000Z'],
    ]));
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(() => parseNuxtPayload(JSON.stringify([['Wibble', 1], 'x']))).toThrow(/unknown nuxt payload tag: Wibble/);
  });
});

describe('extractNuxtPayload + findFlowsNode (live signing-up page)', () => {
  const payload = extractNuxtPayload(flowHtml);
  const node = findFlowsNode(payload)!;
  const flows = node.flows as NdFlow[];
  const f0 = flows[0]!;

  it('returns the Nuxt envelope', () => {
    expect(payload['serverRendered']).toBe(true);
    expect(typeof payload['data']).toBe('object');
  });

  it('finds the flows node with ordered, attributed flows', () => {
    expect(node.count).toBe(242);
    expect(flows.length).toBe(36);
    expect(f0.title).toBe('Signing up');
    expect(typeof f0.uuid).toBe('string');
    expect(f0.patterns.length).toBeGreaterThan(1); // ordered onboarding steps
    expect(f0.categories?.[0]?.slug).toBe('signing-up');
    expect(f0.product?.slug).toBe('bud');
    expect(f0.patterns[0]?.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('pure mappers', () => {
  const payload = extractNuxtPayload(flowHtml);
  const f0 = findFlowsNode(payload)!.flows[0] as NdFlow;

  it('patternImageUrl uses the only public transform', () => {
    expect(patternImageUrl({ uuid: 'abc-123' })).toBe('https://assets.nicelydone.club/t/900x484/abc-123.jpg');
  });

  it('productLogoUrl builds the logo URL or undefined', () => {
    expect(productLogoUrl('logo.png')).toBe('https://assets.nicelydone.club/logos/logo.png');
    expect(productLogoUrl(null)).toBeUndefined();
    expect(productLogoUrl(undefined)).toBeUndefined();
  });

  it('slugify normalizes user category input', () => {
    expect(slugify('Signing up')).toBe('signing-up');
    expect(slugify('  Early Access! ')).toBe('early-access');
    expect(slugify('a--b  c')).toBe('a-b-c');
  });

  it('mapPatternStep maps a step with app attribution and 900px image', () => {
    const p = f0.patterns[0]!;
    const out = mapPatternStep(p, f0.product, 'https://nicelydone.club/flows/signing-up');
    expect(out.id).toBe(`nicelydone:pattern:${p.uuid}`);
    expect(out.source).toBe('nicelydone');
    expect(out.kind).toBe('screen');
    expect(out.platform).toBe('web');
    expect(out.app?.name).toBe(f0.product?.title);
    expect(out.app?.slug).toBe(f0.product?.slug);
    expect(out.app?.logoUrl).toBe(`https://assets.nicelydone.club/logos/${f0.product?.logo}`);
    expect(out.tags).toContain('account creation'); // "Account creation" lowercased
    expect(out.imageUrls).toEqual([patternImageUrl(p)]);
    expect(out.cachedUrls).toEqual([]);
    expect(out.sourceUrl).toBe('https://nicelydone.club/flows/signing-up');
  });

  it('mapFlow keeps step order and merges category + pattern tags', () => {
    const out = mapFlow(f0, 'https://nicelydone.club/flows/signing-up');
    expect(out.id).toBe(`nicelydone:flow:${f0.uuid}`);
    expect(out.kind).toBe('flow');
    expect(out.title).toBe('Signing up');
    expect(out.steps.length).toBe(f0.patterns.length);
    expect(out.steps[0]!.imageUrls[0]).toBe(patternImageUrl(f0.patterns[0]!));
    expect(out.tags).toContain('signing-up');
    expect(out.tags).toContain('account creation');
    expect(out.imageUrls).toEqual(out.steps[0]!.imageUrls);
    expect(out.app?.name).toBe('Bud');
  });

  it('mapFlow falls back to the numeric id for sample flows (no flow uuid)', () => {
    // Sample flows carry a numeric id instead of a uuid. Within one category
    // that id is not unique (exact-duplicate entries + shared first-pattern
    // uuids), so the adapter synthesizes a unique uuid before mapping — a raw
    // sample passed straight to mapFlow maps by its id.
    const sample = contentMeta.flowCategories[0]!.flows[0]!;
    expect(sample.uuid).toBeUndefined();
    const out = mapFlow(sample, 'https://nicelydone.club/flows/create-event');
    expect(out.id).toBe(`nicelydone:flow:${sample.id}`);
    expect(out.steps.length).toBe(sample.patterns.length);
  });
});

describe('createNicelyDoneAdapter', () => {
  let dir: string;
  let store: MetadataStore;
  let adapter: ReturnType<typeof createNicelyDoneAdapter>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'uimcp-nd-'));
    store = new MetadataStore(path.join(dir, 'meta.sqlite'));
    adapter = createNicelyDoneAdapter(store, cfg);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Route stubs by URL substring, in order. */
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

  it('getOnboarding(category) → decoded page flows, capped at limit', async () => {
    const fetchMock = stubFetch([
      ['/api/content/meta', () => jsonResponse(contentMeta)],
      ['/flows/signing-up', () => htmlResponse(flowHtml)],
    ]);
    const out = await adapter.getOnboarding!({ category: 'signing-up' });
    expect(out.length).toBe(6); // default limit
    expect(out.every((f) => f.source === 'nicelydone' && f.platform === 'web')).toBe(true);
    expect(out.every((f) => Array.isArray(f.steps) && f.steps.length > 1)).toBe(true);
    expect(out[0]!.id).toMatch(/^nicelydone:flow:/);
    // One taxonomy call + one SSR page call — no per-flow fetches.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('category by title (not slug) resolves the same category', async () => {
    stubFetch([
      ['/api/content/meta', () => jsonResponse(contentMeta)],
      ['/flows/', () => htmlResponse(flowHtml)],
    ]);
    const out = await adapter.getOnboarding!({ category: 'Signing up', limit: 3 });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('getOnboarding(app) resolves the product in the catalog, then its flows page', async () => {
    const fetchMock = stubFetch([
      ['/api/content/apps', () => jsonResponse(contentApps)],
      ['/apps/magnific/flows', () => htmlResponse(appFlowsHtml)],
    ]);
    const out = await adapter.getOnboarding!({ app: 'Magnific' });
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((f) => Array.isArray(f.steps) && f.steps.length > 1)).toBe(true);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://nicelydone.club/api/content/apps');
    expect(urls).toContain('https://nicelydone.club/apps/magnific/flows');
    // Second call serves the catalog from sqlite — no second /api/content/apps.
    await adapter.getOnboarding!({ app: 'Magnific' });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/content/apps')).length).toBe(1);
  });

  it('unknown app → SourceError naming the product', async () => {
    stubFetch([['/api/content/apps', () => jsonResponse(contentApps)]]);
    await expect(adapter.getOnboarding!({ app: 'Wibble Wobble' })).rejects.toThrow(
      /no Nicely Done product matching "Wibble Wobble"/,
    );
  });

  it('falls back to taxonomy sample flows when the SSR page has no flows node', async () => {
    // Valid Nuxt envelope whose data has no flows array at all.
    const noFlowsHtml =
      '<html><script id="__NUXT_DATA__">' +
      JSON.stringify([
        ['null', 'data', 1, 'path', 3],
        ['null', 'x', 2],
        'x',
        '/flows/signing-up',
      ]) +
      '</script></html>';
    stubFetch([
      ['/api/content/meta', () => jsonResponse(contentMeta)],
      ['/flows/', () => htmlResponse(noFlowsHtml)],
    ]);
    const out = await adapter.getOnboarding!({ category: 'signing-up' });
    expect(out.length).toBe(6);
    // Sample flows carry no flow uuid (and their numeric ids collide within a
    // category) → the adapter synthesizes a unique one.
    expect(out[0]!.id).toMatch(/^nicelydone:flow:sample-signing-up-\d+-\d+$/);
    // And no two returned flows share an id (duplicate numeric flow ids don't
    // collapse under interleaveMerge's id dedupe).
    expect(new Set(out.map((f) => f.id)).size).toBe(out.length);
  });

  it('category path survives an empty taxonomy (live 2026-09-25 shape)', async () => {
    // The endpoint is observed returning populated counts but empty category arrays.
    stubFetch([
      ['/api/content/meta', () => jsonResponse({ count: { flows_raw: 13081 }, flowCategories: [] })],
      ['/flows/', () => htmlResponse(flowHtml)],
    ]);
    const out = await adapter.getOnboarding!({ category: 'signing-up' });
    expect(out.length).toBe(6);
    expect(out.every((f) => f.source === 'nicelydone')).toBe(true);
  });

  it('query trusts the site\'s chip ranking ("signup" → "Signing up" page)', async () => {
    const urls: string[] = [];
    const fn = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/api/search/global/refinements')) {
        return jsonResponse({
          suggestions: [],
          chips: [
            { label: 'Signing up', count: 214 },
            { label: 'Signing in', count: 35 },
          ],
        });
      }
      if (u.includes('/flows/')) return htmlResponse(flowHtml);
      return new Response('not stubbed: ' + u, { status: 404 });
    });
    vi.stubGlobal('fetch', fn);
    const out = await adapter.getOnboarding!({ query: 'signup' });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.title).toBe('Signing up');
    const refinements = urls.find((u) => u.includes('/api/search/global/refinements'))!;
    expect(refinements).toContain('q=signup');
    expect(refinements).toContain('contentType=flows');
    // The chip won the slug race — no raw-slug page was requested.
    expect(urls.some((u) => u.includes('/flows/signup'))).toBe(false);
  });

  it('no selector → top flows from the /flows listing', async () => {
    stubFetch([['/flows', () => htmlResponse(flowHtml)]]);
    const out = await adapter.getOnboarding!({});
    expect(out.length).toBe(6);
    expect(out[0]!.title).toBe('Signing up');
  });

  it('platform filter: ios asks exclude the web corpus', async () => {
    stubFetch([
      ['/api/content/meta', () => jsonResponse(contentMeta)],
      ['/flows/', () => htmlResponse(flowHtml)],
    ]);
    const out = await adapter.getOnboarding!({ category: 'signing-up', platform: 'ios' });
    expect(out).toEqual([]);
  });

  it('healthCheck warms the product catalog', async () => {
    const fetchMock = stubFetch([['/api/content/apps', () => jsonResponse(contentApps)]]);
    const h1 = await adapter.healthCheck();
    expect(h1.ok).toBe(true);
    await adapter.healthCheck();
    expect(fetchMock.mock.calls.length).toBe(1); // second call from sqlite
    expect(store.ndProductCount()).toBe(669);
  });
});
