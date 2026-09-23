import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DecodeError,
  extractAppPage,
  extractEnqueued,
  extractVideoUrl,
  mapFrames,
  resolveTurbo,
  unescapeJsString,
} from '../src/adapters/screensdesign/decode.js';
import { syncCatalog } from '../src/adapters/screensdesign/catalog.js';
import { MetadataStore } from '../src/cache/metadata.js';
import { fetchJson } from '../src/http.js';
import type { Config } from '../src/config.js';

// The catalog tests drive syncCatalog with a mocked fetchJson; the decode
// tests never touch the network.
vi.mock('../src/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/http.js')>();
  return { ...actual, fetchJson: vi.fn() };
});

// ── synthetic turbo-stream v2 payloads ────────────────────────────────────
//
// Flat-array format: values[0] holds the root's encoded form.
//   object: { "_<keyIdx>": <valueIdx>, … }
//   array:  [elemIdx, …]
//   number entries are LITERALS; references only occur as array elements,
//   object values, or the root position.

describe('resolveTurbo', () => {
  it('resolves objects, arrays, literals and key/value refs', () => {
    const flat: unknown[] = [
      // 0: root { "name": <2>, "arr": <4>, "n": <6> }
      { _1: 2, _3: 4, _5: 6 },
      // 1: key "name"
      'name',
      // 2: value "hello"
      'hello',
      // 3: key "arr"
      'arr',
      // 4: array ["x", null, <6>, <7>]
      [8, -5, 6, 7],
      // 5: key "n"
      'n',
      // 6: literal number 42
      42,
      // 7: Date tag
      ['D', 1_700_000_000_000],
      // 8: "x"
      'x',
    ];
    const out = resolveTurbo<Record<string, unknown>>(flat);
    expect(out['name']).toBe('hello');
    expect(out['n']).toBe(42);
    const arr = out['arr'] as unknown[];
    expect(arr[0]).toBe('x');
    expect(arr[1]).toBeNull();
    expect(arr[2]).toBe(42); // number as ARRAY element = reference → literal 42
    expect(arr[3]).toBeInstanceOf(Date);
    expect((arr[3] as Date).getTime()).toBe(1_700_000_000_000);
  });

  it('resolves sentinels', () => {
    const flat: unknown[] = [
      // 0: { "nan": <1>, "negInf": <2>, "negZero": <3>, "inf": <4>, "undef": <5>, "nul": <6> }
      { _7: 1, _8: 2, _9: 3, _10: 4, _11: 5, _12: 6 },
      -2, -3, -4, -6, -7, -5,
      'nan', 'negInf', 'negZero', 'inf', 'undef', 'nul',
    ];
    const out = resolveTurbo<Record<string, unknown>>(flat);
    expect(Number.isNaN(out['nan'] as number)).toBe(true);
    expect(out['negInf']).toBe(-Infinity);
    expect(Object.is(out['negZero'] as number, -0)).toBe(true);
    expect(out['inf']).toBe(Infinity);
    expect(out['undef']).toBeUndefined();
    expect(out['nul']).toBeNull();
  });

  it('resolves -5 (null) sentinels routed through object values, N and Z paths', () => {
    const flat: unknown[] = [
      // 0: { "direct": <1>, "np": <2>, "alias": <3> }
      { _4: 1, _5: 2, _6: 3 },
      // 1: plain object whose value is the raw -5 sentinel
      { _7: -5 },
      // 2: null-prototype object (N tag) with a -5 value
      ['N', { _8: -5 }],
      // 3: alias (Z tag) to the -5 sentinel
      ['Z', -5],
      // 4..6: keys
      'direct', 'np', 'alias',
      // 7..8: inner keys
      'a', 'b',
    ];
    const out = resolveTurbo<Record<string, unknown>>(flat);
    const direct = out['direct'] as Record<string, unknown>;
    expect('a' in direct).toBe(true);
    expect(direct['a']).toBeNull(); // was undefined before the sign check
    const np = out['np'] as Record<string, unknown>;
    expect(Object.getPrototypeOf(np)).toBeNull();
    expect(np['b']).toBeNull();
    expect(out['alias']).toBeNull();
  });

  it('resolves typed values: BigInt, RegExp, Set, Map, Symbol', () => {
    const flat: unknown[] = [
      // 0: { "bi": <1>, "re": <2>, "sym": <3>, "set": <4>, "map": <5> }
      { _6: 1, _7: 2, _8: 3, _9: 4, _10: 5 },
      ['B', '123456789012345678901'],
      ['R', '^a+$', 'i'],
      ['Y', 'my-symbol'],
      ['S', [11, 12]],
      ['M', [13, 14, 15, 16]],
      'bi', 're', 'sym', 'set', 'map',
      'one', 'two', 'k1', 'v1', 'k2', 'v2',
    ];
    const out = resolveTurbo<Record<string, unknown>>(flat);
    expect(out['bi']).toBe(123456789012345678901n);
    expect(out['re']).toEqual(/^a+$/i);
    expect(out['sym']).toBe(Symbol.for('my-symbol'));
    expect(out['set']).toEqual(new Set(['one', 'two']));
    expect(out['map']).toEqual(new Map([['k1', 'v1'], ['k2', 'v2']]));
  });

  it('resolves aliases and null-prototype objects', () => {
    const flat: unknown[] = [
      // 0: { "alias": <1>, "np": <2> }
      { _3: 1, _4: 2 },
      ['Z', 5],
      ['N', { _6: 7 }],
      'alias', 'np',
      'hello',
      'npkey',
      'npval',
    ];
    const out = resolveTurbo<Record<string, unknown>>(flat);
    expect(out['alias']).toBe('hello');
    const np = out['np'] as Record<string, unknown>;
    expect(np['npkey']).toBe('npval');
    expect(Object.getPrototypeOf(np)).toBeNull();
  });

  it('handles deferred promises and unknown tags without throwing', () => {
    const flat: unknown[] = [
      // 0: root array [<1>, <2>, <3>]
      [1, 2, 3],
      // 1: P tag → undefined
      ['P', 4],
      // 2: "x"
      'x',
      // 3: unknown tag
      ['Q', 5],
      // 4/5: args
      2, 2,
    ];
    const out = resolveTurbo<unknown[]>(flat);
    expect(out[0]).toBeUndefined(); // P → undefined
    expect(out[1]).toBe('x');
    expect(out[2]).toEqual({ __turboTag: 'Q', args: [5] });
  });
});

describe('extractEnqueued / unescapeJsString', () => {
  it('extracts and unescapes enqueue bodies', () => {
    // As in real pages: inner quotes/backslashes are JS-escaped. The
    // unescaped result must be valid JSON, so inner backslashes appear
    // doubled (4 in the wire literal → 2 after JS-unescape → 1 final).
    const body = String.raw`[\"a\",\"b\\\\c\",true]`;
    const html = `<script>streamController.enqueue("${body}");streamController.close();</script>`;
    const bodies = extractEnqueued(html);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(unescapeJsString(bodies[0]!))).toEqual(['a', 'b\\c', true]);
  });

  it('throws DecodeError when no payload is present', () => {
    expect(() => extractEnqueued('<html>nope</html>')).toThrow(DecodeError);
  });
});

describe('mapFrames', () => {
  it('maps pinned frame shape (screen/preview/labels/timestamp)', () => {
    const frames = mapFrames([
      {
        id: 109193,
        screen: 'https://media.screensdesign.com/avs-pp/0d62.webp',
        preview: 'https://media.screensdesign.com/avs-pr/f210.webp',
        width: 1080,
        height: 2336,
        timestamp: '2.600',
        description_short: 'Welcome screen',
        labels: ['onboarding'],
        created_at: '2025-02-24T23:16:19Z',
      },
    ]);
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    expect(f.hash).toBe('0d62');
    expect(f.imageUrl).toBe('https://media.screensdesign.com/avs-pp/0d62.webp');
    expect(f.thumbnailUrl).toBe('https://media.screensdesign.com/avs-pr/f210.webp');
    expect(f.descriptionShort).toBe('Welcome screen');
    expect(f.labels).toEqual(['onboarding']);
    expect(f.timestamp).toBe('2.600');
  });

  it('derives CDN urls from a bare hash when only that is available', () => {
    const frames = mapFrames([{ hash: 'abc123' }]);
    expect(frames[0]?.imageUrl).toBe('https://media.screensdesign.com/avs-pp/abc123.webp');
    expect(frames[0]?.thumbnailUrl).toBe('https://media.screensdesign.com/avs-thumbs/abc123.webp');
  });

  it('skips non-frame entries', () => {
    expect(mapFrames([null, 42, 'x', {}])).toEqual([]);
  });
});

// ── real captured page (Spotify) ──────────────────────────────────────────

describe('extractAppPage (live fixture)', () => {
  const html = readFileSync('test/fixtures/screensdesign-app-detail.html', 'utf8');
  const page = extractAppPage(html);

  it('decodes the app object', () => {
    expect(page.app['name']).toBe('Spotify: Music and Podcasts');
    expect(page.app['store_id']).toBe('324684580');
    expect(page.app['slug']).toBe('spotify-music-and-podcasts');
  });

  it('decodes ordered session frames with captions and labels', () => {
    expect(page.frames.length).toBeGreaterThanOrEqual(5);
    for (const f of page.frames.slice(0, 10)) {
      // full-res (avs-pp) normally; blurry frames fall back to avs-pr
      expect(f.imageUrl).toMatch(/^https:\/\/media\.screensdesign\.com\/avs-(pp|pr)\/[a-f0-9]+\.webp$/);
    }
    const fullRes = page.frames.filter((f) => f.imageUrl.includes('/avs-pp/')).length;
    expect(fullRes).toBeGreaterThanOrEqual(5);
    // frames are in recording order: timestamps non-decreasing where present
    const ts = page.frames
      .map((f) => Number(f.timestamp))
      .filter((n) => Number.isFinite(n));
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]! - 0.001);
    }
  });

  it('extracts the 720p session recording URL', () => {
    expect(page.videoUrl).toMatch(/^https:\/\/vz-[^/]+\.b-cdn\.net\/[a-f0-9-]+\/play_720p\.mp4$/);
    expect(extractVideoUrl(html)).toBe(page.videoUrl);
  });

  it('exposes the detail holder with replay_screens', () => {
    expect(Array.isArray(page.detail['replay_screens'])).toBe(true);
  });
});

// ── syncCatalog resume (livelock guard) ───────────────────────────────────

const CFG: Config = {
  cacheDir: '/tmp/uimcp-test',
  rateLimitMs: 0,
  maxResults: 24,
  timeoutMs: 15_000,
  retryBaseMs: 500,
  fakeOffline: false,
  catalogTtlDays: 7,
  facetTtlDays: 7,
};

describe('syncCatalog resume', () => {
  let dir: string;
  let store: MetadataStore;
  const requested: number[] = [];
  const LAST_PAGE = 3;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'uimcp-catalog-'));
    store = new MetadataStore(path.join(dir, 'meta.sqlite'));
    requested.length = 0;
    vi.mocked(fetchJson).mockImplementation(
      async function <T>(_source: string, url: string): Promise<T> {
        const page = Number(new URL(url).searchParams.get('page'));
        requested.push(page);
        return {
          count: LAST_PAGE,
          next: page < LAST_PAGE ? `https://api.screensdesign.com/v1/apps/?page=${page + 1}` : null,
          previous: null,
          results: [{ id: page, slug: `app-${page}`, name: `App ${page}` }],
        } as T;
      },
    );
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to a full resync from page 1 when the resume point passed the cap', async () => {
    // Previous pass died exactly at the cap (550): resume would be page 551,
    // which executes zero pages and re-marks partial forever without the guard.
    store.setMeta('catalog_last_page', '550');
    store.setCatalogSyncedAt(new Date().toISOString(), true);
    const res = await syncCatalog(store, CFG);
    expect(requested[0]).toBe(1);
    expect(requested).toEqual([1, 2, 3]);
    expect(res.partial).toBe(false);
    expect(store.catalogPartial()).toBe(false);
    expect(store.appCount()).toBe(LAST_PAGE);
  });

  it('resumes mid-catalog from last_page + 1 while under the cap', async () => {
    store.setMeta('catalog_last_page', '1');
    store.setCatalogSyncedAt(new Date().toISOString(), true);
    const res = await syncCatalog(store, CFG);
    expect(requested[0]).toBe(2);
    expect(res.partial).toBe(false);
  });
});
