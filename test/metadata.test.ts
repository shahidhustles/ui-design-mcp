import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MetadataStore } from '../src/cache/metadata.js';
import type { CatalogApp } from '../src/types.js';

let dir: string;
let store: MetadataStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'uimcp-meta-'));
  store = new MetadataStore(path.join(dir, 'meta.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const apps: CatalogApp[] = [
  {
    id: 1,
    slug: 'spotify-music-and-podcasts',
    name: 'Spotify: Music and Podcasts',
    storeId: '324684580',
    rating: 4.8,
    category: 'Music',
  },
  { id: 2, slug: 'airbnb', name: 'Airbnb', storeId: '401626263', rating: 4.6 },
  { id: 3, slug: 'x-social', name: 'X (Twitter)' },
];

describe('MetadataStore', () => {
  it('upserts and finds apps by exact/prefix/substring, case-insensitive', () => {
    store.upsertApps(apps, '2026-09-23T00:00:00Z');
    expect(store.appCount()).toBe(3);
    expect(store.findApp('Spotify')?.slug).toBe('spotify-music-and-podcasts');
    expect(store.findApp('spotify')?.slug).toBe('spotify-music-and-podcasts');
    expect(store.findApp('spot')?.slug).toBe('spotify-music-and-podcasts');
    expect(store.findApp('air')?.slug).toBe('airbnb');
    expect(store.findApp('nope-nothing')).toBeNull();
  });

  it('ranks substring matches by rating desc, nulls last', () => {
    store.upsertApps(
      [
        { id: 10, slug: 'a-low', name: 'Zebra', rating: 3.0 },
        { id: 11, slug: 'b-high', name: 'Zebra Club', rating: 4.9 },
        { id: 12, slug: 'c-none', name: 'Zebra Crossing' },
      ],
      '2026-09-23T00:00:00Z',
    );
    // 'ebra' matches all three only via substring → best rating wins
    expect(store.findApp('ebra')?.slug).toBe('b-high');
    // exact match beats rating ordering
    expect(store.findApp('Zebra')?.slug).toBe('a-low');
  });

  it('upsert updates existing rows on re-sync', () => {
    store.upsertApps(apps, 't1');
    store.upsertApps([{ ...apps[0]!, rating: 4.9 }], 't2');
    expect(store.appCount()).toBe(3);
    expect(store.findApp('Spotify')?.rating).toBe(4.9);

    expect(store.catalogSyncedAt()).toBeNull();
    store.setCatalogSyncedAt('t2', false);
    expect(store.catalogSyncedAt()).toBe('t2');
    expect(store.catalogPartial()).toBe(false);
    store.setCatalogSyncedAt('t2', true);
    expect(store.catalogPartial()).toBe(true);
  });

  it('replaces facet dictionaries per kind', () => {
    store.setFacets('page_types', [{ id: '1', name: 'landing' }, { id: '2', name: 'checkout' }], 'f1');
    store.setFacets('page_types', [{ id: '2', name: 'checkout' }], 'f2');
    expect(store.getFacets('page_types')).toEqual([{ id: '2', name: 'checkout' }]);
    expect(store.facetsFetchedAt('page_types')).toBe('f2');
    expect(store.getFacets('design_patterns')).toEqual([]);
  });

  it('stores and returns decoded app pages', () => {
    expect(store.getAppPage('spotify')).toBeNull();
    store.setAppPage('spotify', 'https://vz-x.b-cdn.net/uuid/play_720p.mp4', '[1,2]');
    const page = store.getAppPage('spotify');
    expect(page?.videoUrl).toBe('https://vz-x.b-cdn.net/uuid/play_720p.mp4');
    expect(JSON.parse(page?.framesJson ?? '[]')).toEqual([1, 2]);
  });

  it('tracks record counts per source and source health', () => {
    const now = '2026-09-23T00:00:00Z';
    store.upsertRecord({ id: 'refero:1', source: 'refero', kind: 'screen', platform: 'web', payloadJson: '{}', createdAt: now });
    store.upsertRecord({ id: 'refero:2', source: 'refero', kind: 'screen', platform: 'web', payloadJson: '{}', createdAt: now });
    store.upsertRecord({ id: 'screensdesign:1', source: 'screensdesign', kind: 'screen', platform: 'ios', payloadJson: '{}', createdAt: now });
    expect(store.recordCounts()).toEqual({ refero: 2, screensdesign: 1 });

    store.setSourceStatus('refero', true, undefined);
    store.setSourceStatus('screensdesign', false, 'HTTP 500');
    const status = store.sourceStatus();
    expect(status['refero']?.ok).toBe(true);
    expect(status['screensdesign']?.ok).toBe(false);
    expect(status['screensdesign']?.note).toBe('HTTP 500');
  });
});
