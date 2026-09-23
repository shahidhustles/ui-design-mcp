import type { Config } from '../config.js';
import { fetchJson } from '../http.js';
import type { AppRecord, UIScreen } from '../types.js';
import { SourceError } from '../types.js';
import type { Adapter, AppResult, Health } from './adapter.js';

export const SOURCE = 'apple';

/**
 * Official iTunes Search/Lookup API — the fully-legal join channel.
 * ScreensDesign hands us every app's `store_id`, so this adapter only
 * ever runs byStoreId (no name searching).
 */

export function buildLookupUrl(storeId: string, country = 'us'): string {
  return `https://itunes.apple.com/lookup?id=${encodeURIComponent(storeId)}&country=${encodeURIComponent(country)}`;
}

interface ItunesResult {
  trackId: number;
  trackName: string;
  artistName?: string;
  artworkUrl512x512?: string;
  primaryGenreName?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  version?: string;
  price?: number;
  formattedPrice?: string;
  genreIds?: number[];
  screenshotUrls?: string[];
  releaseDate?: string;
  currentVersionReleaseDate?: string;
}

interface ItunesLookupResponse {
  resultCount: number;
  results: ItunesResult[];
}

/** null when the store id is unknown/delisted for the country. */
export function mapLookupResult(body: ItunesLookupResponse): { app: Partial<AppRecord>; screens: UIScreen[] } | null {
  const r = body.results?.[0];
  if (!r) return null;
  const screenshots = (r.screenshotUrls ?? [])
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .map((url, i): UIScreen => ({
      id: `${SOURCE}:${r.trackId}:${i + 1}`,
      source: SOURCE,
      kind: 'store-listing',
      platform: 'ios',
      app: { name: r.trackName, storeId: String(r.trackId), logoUrl: r.artworkUrl512x512 },
      title: `App Store screenshot ${i + 1}`,
      tags: ['app-store'],
      imageUrls: [url],
      cachedUrls: [],
      sourceUrl: `https://apps.apple.com/lookup?id=${r.trackId}`,
      capturedAt: r.currentVersionReleaseDate ?? r.releaseDate,
    }));
  return {
    app: {
      name: r.trackName,
      storeId: String(r.trackId),
      platform: 'ios',
      iconUrl: r.artworkUrl512x512,
      storeUrl: `https://apps.apple.com/lookup?id=${r.trackId}`,
      category: r.primaryGenreName,
      rating: r.averageUserRating,
      version: r.version,
    },
    screens: screenshots,
  };
}

export function createAppleAdapter(cfg: Config): Adapter {
  return {
    name: SOURCE,
    capabilities: {
      platforms: ['ios'],
      kinds: ['store-listing'],
      byStoreId: true,
    },

    async healthCheck(): Promise<Health> {
      // Spotify's id — stable for years, 8 screenshots.
      try {
        const body = await fetchJson<ItunesLookupResponse>(SOURCE, buildLookupUrl('324684580'), cfg);
        return { ok: body.resultCount > 0 };
      } catch (e) {
        return { ok: false, note: e instanceof Error ? e.message : String(e) };
      }
    },

    async byStoreId(storeId: string, country = 'us'): Promise<AppResult> {
      const body = await fetchJson<ItunesLookupResponse>(SOURCE, buildLookupUrl(storeId, country), cfg);
      const mapped = mapLookupResult(body);
      if (!mapped) {
        throw new SourceError(`iTunes lookup empty for store id ${storeId} (country=${country})`, SOURCE);
      }
      return {
        app: { name: mapped.app.name ?? `App ${storeId}`, platform: 'ios', ...mapped.app } as AppRecord,
        screens: mapped.screens,
      };
    },
  };
}
