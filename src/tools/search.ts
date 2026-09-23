import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { adaptersWith } from '../adapters/adapter.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import type { CatalogApp, Platform } from '../types.js';
import { cacheFullRes, errorResult, fanOut, interleaveMerge, toolResult, withImages } from './common.js';

/**
 * The single entry-point search tool. `type: "screens"` searches real-world
 * UI screens (Refero) — the design-reference backbone; `type: "apps"` searches
 * per-app catalogs (ScreensDesign) to pick an app before get_app. One tool
 * instead of two search tools that confused agents about which to call.
 */
export function registerSearchTool(server: McpServer, store: MetadataStore, cfg: Config): void {
  void store;
  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'The entry point for finding design references. ' +
        'type "screens": real-world UI screens (Refero: 74k+ web + iOS, faceted by page type / pattern / element) — ' +
        'returns colors[] hex, fonts, tags and inline thumbnails; use get_image for full-res views. ' +
        'type "apps": per-app catalogs (ScreensDesign: 2,711 top-grossing iOS apps, live name search) — ' +
        'use this to CHOOSE an app before get_app. Screens take query/platform/tags; apps take query/category.',
      inputSchema: {
        type: z.enum(['screens', 'apps']).describe('"screens" = UI screens to study; "apps" = whole apps to pick one'),
        query: z.string().optional().describe('Free text: "checkout", "onboarding", "journal", "spotify"'),
        platform: z.enum(['ios', 'android', 'web', 'desktop', 'unknown']).optional().describe('screens only'),
        tags: z.array(z.string()).optional().describe('screens only — facets, e.g. ["dashboard", "landing page"]'),
        category: z.string().optional().describe('apps only — App Store category, e.g. "Music"'),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({
      type,
      query,
      platform,
      tags,
      category,
      limit,
    }: {
      type: 'screens' | 'apps';
      query?: string;
      platform?: Platform;
      tags?: string[];
      category?: string;
      limit: number;
    }) => {
      try {
        const notes: string[] = [];
        if (type === 'screens') {
          const adapters = adaptersWith('search');
          const perAdapter = await fanOut(
            adapters,
            (a) => a.searchScreens!({ query, platform, tags, limit }),
            notes,
          );
          let merged = interleaveMerge(perAdapter, limit);
          if (platform && platform !== 'unknown' && merged.length < 2) {
            const unfiltered = await fanOut(
              adapters,
              (a) => a.searchScreens!({ query, tags, limit }),
              notes,
            );
            const alt = interleaveMerge(unfiltered, limit);
            if (alt.length > merged.length) {
              notes.push(`no ${platform} results — showing unfiltered`);
              merged = alt;
            }
          }
          if (merged.length === 0) notes.push('no results across any source');
          await cacheFullRes(merged, Math.min(limit, 10), cfg, notes);
          const blocks = await withImages(merged, 8, cfg, notes);
          return toolResult(
            { type: 'screens', count: merged.length, results: merged, notes },
            blocks,
          );
        }

        // type === 'apps'
        if (!query && !category) notes.push('no query or category — returning top-rated apps in the catalog');
        const perAdapter = await fanOut(
          adaptersWith('appSearch'),
          (a) => a.searchApps!({ query, category, limit }),
          notes,
        );
        const seen = new Set<string>();
        const apps: CatalogApp[] = [];
        for (const list of perAdapter) {
          for (const app of list) {
            if (seen.has(app.name)) continue;
            seen.add(app.name);
            apps.push(app);
            if (apps.length >= limit) break;
          }
          if (apps.length >= limit) break;
        }
        if (apps.length === 0) notes.push('no apps matched — try a shorter query (live search is substring-based)');
        return toolResult({ type: 'apps', count: apps.length, apps, notes });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
