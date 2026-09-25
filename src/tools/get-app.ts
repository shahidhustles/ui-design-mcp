import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { adaptersWith } from '../adapters/adapter.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import type { Platform, UIScreen } from '../types.js';
import { cacheFullRes, errorResult, fanOut, toolResult, withImages } from './common.js';

export function registerGetAppTool(server: McpServer, store: MetadataStore, cfg: Config): void {
  void store;
  server.registerTool(
    'get_app',
    {
      title: 'Get app',
      description:
        'One app\'s full profile (rating, revenue, paywall type) + its complete ordered screen session ' +
        'with AI captions per screen + 720p videoUrl, joined with official App Store screenshots. ' +
        'First call per app fetches+decodes the session (~15s); cached after.',
      inputSchema: {
        name: z.string().describe('App name, e.g. "Spotify" (fuzzy match)'),
        platform: z.enum(['ios', 'android', 'web', 'desktop', 'unknown']).optional(),
      },
    },
    async ({ name, platform }: { name: string; platform?: Platform }) => {
      try {
        const notes: string[] = [];
        if (platform && platform !== 'ios' && platform !== 'unknown') {
          notes.push(`per-app depth covers ios only (requested ${platform})`);
        }
        const perApp = adaptersWith('perApp');
        const results = await fanOut(perApp, (a) => a.getApp!({ name, platform }), notes);
        if (results.length === 0) {
          return errorResult(`no per-app source could find "${name}"${notes.length ? ` — ${notes.join('; ')}` : ''}`);
        }
        // Merge screens from any per-app adapters (Phase 1: one, but the
        // surface is built for more) — dedupe by id.
        const screensById = new Map<string, UIScreen>();
        let videoUrl: string | undefined;
        let primaryApp = results[0]!.app;
        for (const res of results) {
          if (!videoUrl && res.videoUrl) videoUrl = res.videoUrl;
          for (const s of res.screens) if (!screensById.has(s.id)) screensById.set(s.id, s);
        }
        const appScreens = [...screensById.values()];
        // Two per-app sources (ScreensDesign + Simple App Shipper) can both carry
        // the same app — the combined list is then not one recorded session.
        const contributing = new Set(appScreens.map((s) => s.source));
        if (contributing.size > 1) {
          notes.push(`screens merged from ${[...contributing].join(' + ')} — a combined set, not a single recorded session`);
        }

        // Official store-screenshot join (Apple) via store_id.
        let storeScreens: UIScreen[] = [];
        if (primaryApp.storeId) {
          const byStoreId = adaptersWith('byStoreId');
          for (const a of byStoreId) {
            try {
              const r = await a.byStoreId!(primaryApp.storeId);
              for (const s of r.screens) if (!screensById.has(s.id)) {
                screensById.set(s.id, s);
                storeScreens.push(s);
              }
            } catch (e) {
              notes.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }

        await cacheFullRes(appScreens.slice(0, 10), 10, cfg, notes);
        await cacheFullRes(storeScreens, Math.min(8, storeScreens.length), cfg, notes);
        const blocks = await withImages(appScreens, 8, cfg, notes);
        return toolResult(
          {
            app: primaryApp,
            screenCount: appScreens.length,
            storeScreenshotCount: storeScreens.length,
            videoUrl: videoUrl ?? null,
            screens: [...appScreens, ...storeScreens],
            notes,
          },
          blocks,
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
