import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { adaptersWith } from '../adapters/adapter.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import type { Platform, UIFlow } from '../types.js';
import { cacheFullRes, errorResult, fanOut, interleaveMerge, toolResult, withImages } from './common.js';

/**
 * Product onboarding flows (Nicely Done). A dedicated tool — onboarding is a
 * design task, not a generic search: the corpus is organized per product and
 * per flow category, and the agent asks for "the onboarding of X" or
 * "onboarding in category Y".
 */
export function registerGetOnboardingTool(server: McpServer, store: MetadataStore, cfg: Config): void {
  void store;
  server.registerTool(
    'get_onboarding',
    {
      title: 'Get onboarding',
      description:
        'Real product onboarding flows (Nicely Done: 12k+ curated web-product flows, 669 products) — ' +
        'ordered step captures with pattern tags. Give app (all of a product\'s flows), category ' +
        '("signing-up", "onboarding", "verifying-identity", …), or query. Images are 900px; use get_image for more.',
      inputSchema: {
        app: z.string().optional().describe('Product name, e.g. "Dovetail" — returns all of its onboarding flows'),
        category: z
          .string()
          .optional()
          .describe('Flow category, by slug or title: "signing-up", "sign-in", "onboarding", "requesting-early-access", …'),
        query: z.string().optional().describe('Free text, e.g. "signup" — matched against flow categories'),
        platform: z.enum(['ios', 'android', 'web', 'desktop', 'unknown']).optional(),
        limit: z.number().int().min(1).max(20).default(6),
      },
    },
    async ({ app, category, query, platform, limit }: { app?: string; category?: string; query?: string; platform?: Platform; limit: number }) => {
      try {
        const notes: string[] = [];
        if (!app && !category && !query) {
          notes.push('no app/category/query — returning top onboarding flows');
        }
        const adapters = adaptersWith('onboarding');
        const perAdapter = await fanOut(
          adapters,
          (a) => a.getOnboarding!({ app, category, query, platform, limit }),
          notes,
        );
        const merged = interleaveMerge(perAdapter, limit, (f: UIFlow) => f.id);
        if (merged.length === 0) notes.push('no onboarding flows found');
        // Cache the first step image of each flow (not every step) — same
        // pattern as get_flows; cacheFullRes mutates the copies it is given.
        const cacheTargets = merged.map((f) => ({
          ...f,
          imageUrls: f.steps[0]?.imageUrls ?? f.imageUrls,
          cachedUrls: [] as string[],
        }));
        await cacheFullRes(cacheTargets, merged.length, cfg, notes);
        merged.forEach((f, i) => {
          const urls = cacheTargets[i]!.cachedUrls;
          f.cachedUrls = urls;
          const first = f.steps[0];
          if (first) first.cachedUrls = urls;
        });
        const blocks = await withImages(merged, 8, cfg, notes);
        return toolResult({ count: merged.length, flows: merged, notes }, blocks);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
