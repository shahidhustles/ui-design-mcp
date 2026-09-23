import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { adaptersWith } from '../adapters/adapter.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import type { CatalogApp } from '../types.js';
import { errorResult, fanOut, toolResult } from './common.js';

export function registerSearchAppsTool(server: McpServer, store: MetadataStore, cfg: Config): void {
  void store;
  void cfg;
  server.registerTool(
    'search_apps',
    {
      title: 'Search apps',
      description:
        'Browse the per-app catalogs (ScreensDesign: 2,711 top-grossing iOS apps) to CHOOSE an app before ' +
        'calling get_app. query does a live name-substring search with a match count (e.g. "music" → 48 apps: ' +
        'Spotify, Deezer, …); category filters the locally-synced catalog. Each result has what get_app will ' +
        'deliver: rating, revenue, paywall type, downloads — and a full ordered screen session behind it.',
      inputSchema: {
        query: z.string().optional().describe('Name substring, e.g. "spotify" or "music"'),
        category: z.string().optional().describe('App Store category, e.g. "Music" (local catalog only)'),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, category, limit }: { query?: string; category?: string; limit: number }) => {
      try {
        const notes: string[] = [];
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
        return toolResult({ count: apps.length, apps, notes });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
