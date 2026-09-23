import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { adaptersWith } from '../adapters/adapter.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import type { Platform } from '../types.js';
import { cacheFullRes, errorResult, fanOut, interleaveMerge, toolResult, withImages } from './common.js';

export function registerSearchScreensTool(server: McpServer, store: MetadataStore, cfg: Config): void {
  void store;
  server.registerTool(
    'search_screens',
    {
      title: 'Search screens',
      description:
        'Search real-world UI screens across design-reference sources (Refero: 74k+ web + iOS screens, faceted by page type / pattern / element). ' +
        'Returns unified records with remote image URLs, locally-cached paths (cachedUrls, file://), and source URLs. ' +
        'If platform is requested but coverage is thin, falls back to unfiltered results and says so in notes.',
      inputSchema: {
        query: z.string().optional().describe('Free text, e.g. "checkout" or "onboarding"'),
        platform: z.enum(['ios', 'android', 'web', 'desktop', 'unknown']).optional(),
        tags: z.array(z.string()).optional().describe('Facet tags, e.g. ["checkout", "landing page"]'),
        limit: z.number().int().min(1).max(48).default(10).describe('Max records (default 10)'),
      },
    },
    async ({ query, platform, tags, limit }: { query?: string; platform?: Platform; tags?: string[]; limit: number }) => {
      try {
        const notes: string[] = [];
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
        if (merged.length === 0) {
          notes.push('no results across any source');
        }
        await cacheFullRes(merged, Math.min(limit, 10), cfg, notes);
        const blocks = await withImages(merged, 8, cfg, notes);
        return toolResult({ count: merged.length, results: merged, notes }, blocks);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
