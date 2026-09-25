import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createScreensDesignAdapter } from '../src/adapters/screensdesign/index.js';
import { MetadataStore } from '../src/cache/metadata.js';
import type { Config } from '../src/config.js';

const appPageHtml = readFileSync('test/fixtures/screensdesign-app-detail.html', 'utf8');

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

const spotifyRow = {
  id: 100,
  slug: 'spotify-music-and-podcasts',
  name: 'Spotify: Music and Podcasts',
  shortname: 'Music',
  icon: 'https://media.screensdesign.com/appicon-thumbs/spotify.webp',
  developer: { id: 1, name: 'Spotify AB' },
  rating_value: '4.8',
  store_id: '301527417',
  category_primary: 'Music',
};
const otherRow = {
  id: 101,
  slug: 'mustfm-for-spotify-stats',
  name: 'must.fm for Spotify Stats',
  icon: 'https://media.screensdesign.com/appicon-thumbs/mustfm.webp',
  developer: { id: 2, name: 'Other' },
  rating_value: '4.5',
};
const wibbleRow = {
  id: 200,
  slug: 'wibble-wobble',
  name: 'Wibble Wobble',
  icon: 'https://media.screensdesign.com/appicon-thumbs/wibble.webp',
  developer: { id: 3, name: 'W' },
  rating_value: '4.2',
};

function catalogPage(results: unknown[], next: string | null): Response {
  return new Response(JSON.stringify({ count: results.length, next, previous: null, results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createScreensDesignAdapter — cold-start name resolution', () => {
  let dir: string;
  let store: MetadataStore;
  let adapter: ReturnType<typeof createScreensDesignAdapter>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'uimcp-sd-'));
    store = new MetadataStore(path.join(dir, 'meta.sqlite'));
    adapter = createScreensDesignAdapter(store, cfg);
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

  it('cold get_app resolves via ONE live name-search request — no catalog sync', async () => {
    const fetchMock = stubFetch([
      ['?name=', () => catalogPage([spotifyRow, otherRow], null)],
      ['screensdesign.com/apps/', () => new Response(appPageHtml, { status: 200 })],
    ]);
    const out = await adapter.getApp!({ name: 'Spotify' });
    expect(out.app.name).toBe('Spotify: Music and Podcasts');
    expect(out.screens.length).toBeGreaterThan(0);
    // Live lookup (1) + app page (1) — nothing else. No pagination, no sync.
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('v1/apps/?page='))).toBe(false);

    // The SSR fold must survive: category_primary is an {id, name} object in
    // the payload, and the catalog row ends up with its `name` string.
    const folded = store.findAppBySlug('spotify-music-and-podcasts');
    expect(folded?.category).toBe('MUSIC');
    expect(folded?.storeId).toBe('324684580');

    // Second call: row upserted locally, app page cached → zero network.
    await adapter.getApp!({ name: 'Spotify' });
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('live lookup finds nothing → full (resumable) catalog sync as last resort', async () => {
    const fetchMock = stubFetch([
      ['?name=', () => catalogPage([], null)],
      ['v1/apps/?page=2', () => catalogPage([], null)],
      ['v1/apps/?page=1', () => catalogPage([wibbleRow], 'https://api.screensdesign.com/v1/apps/?page=2')],
      ['screensdesign.com/apps/', () => new Response(appPageHtml, { status: 200 })],
    ]);
    const out = await adapter.getApp!({ name: 'Wibble Wobble' });
    expect(out.app.name).toBe('Wibble Wobble');
    // Live lookup missed → sync ran page 1 → followed `next` → page 2.
    const pages = fetchMock.mock.calls.filter((c) => String(c[0]).includes('v1/apps/?page='));
    expect(pages.length).toBe(2);
  });

  it('live lookup errors (500) → sync fallback still resolves', async () => {
    const fetchMock = stubFetch([
      ['?name=', () => new Response('boom', { status: 500 })],
      ['v1/apps/?page=1', () => catalogPage([wibbleRow], null)],
      ['screensdesign.com/apps/', () => new Response(appPageHtml, { status: 200 })],
    ]);
    const out = await adapter.getApp!({ name: 'Wibble Wobble' });
    expect(out.app.name).toBe('Wibble Wobble');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('v1/apps/?page=1'))).toBe(true);
  });

  it('app in neither live results nor synced catalog → SourceError naming the app', async () => {
    stubFetch([
      ['?name=', () => catalogPage([], null)],
      ['v1/apps/?page=1', () => catalogPage([wibbleRow], null)],
    ]);
    await expect(adapter.getApp!({ name: 'Zorblatt' })).rejects.toThrow(/Zorblatt/);
  });
});
