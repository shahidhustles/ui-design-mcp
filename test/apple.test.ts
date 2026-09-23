import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLookupUrl, mapLookupResult, type ItunesLookupResponse } from '../src/adapters/apple-itunes.js';

const spotify = JSON.parse(readFileSync('test/fixtures/apple-lookup-spotify.json', 'utf8')) as ItunesLookupResponse;

describe('buildLookupUrl', () => {
  it('defaults to country=us and encodes the id', () => {
    expect(buildLookupUrl('324684580')).toBe('https://itunes.apple.com/lookup?id=324684580&country=us');
    expect(buildLookupUrl('1 2', 'gb')).toBe('https://itunes.apple.com/lookup?id=1%202&country=gb');
  });
});

describe('mapLookupResult', () => {
  it('maps the live Spotify response', () => {
    const out = mapLookupResult(spotify);
    expect(out).not.toBeNull();
    expect(out?.app.storeId).toBe('324684580');
    expect(out?.app.name).toBe('Spotify: Music and Podcasts');
    expect(out?.app.category).toBe(spotify.results[0]!.primaryGenreName);
    expect(out?.screens.length).toBe(spotify.results[0]!.screenshotUrls!.length);
    expect(out?.screens.length).toBeGreaterThanOrEqual(1);
    const s = out?.screens[0]!;
    expect(s.kind).toBe('store-listing');
    expect(s.source).toBe('apple');
    expect(s.imageUrls[0]).toBe(spotify.results[0]!.screenshotUrls![0]);
    expect(s.app?.name).toBe(out?.app.name);
  });

  it('returns null on empty results', () => {
    expect(mapLookupResult({ resultCount: 0, results: [] })).toBeNull();
  });
});
