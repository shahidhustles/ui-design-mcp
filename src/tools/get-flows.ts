import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { adaptersWith } from '../adapters/adapter.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import type { Platform, UIFlow } from '../types.js';
import { UI_META } from '../ui.js';
import { cacheFullRes, errorResult, fanOut, interleaveMerge, toolResult, withImages } from './common.js';

export function registerGetFlowsTool(server: McpServer, store: MetadataStore, cfg: Config): void {
  void store;
  registerAppTool(
    server,
    'get_flows',
    {
      title: 'Get flows',
      description:
        'Named ordered user flows from Refero — multi-step screenshot sequences like "Signing Up & Onboarding". ' +
        'For a whole app\'s recorded session use get_app instead. ' +
        'MCP Apps hosts render each flow as a scrollable step strip.',
      _meta: UI_META,
      inputSchema: {
        query: z.string().optional().describe('Flow search text, e.g. "onboarding"'),
        platform: z.enum(['ios', 'android', 'web', 'desktop', 'unknown']).optional(),
        limit: z.number().int().min(1).max(20).default(6),
      },
    },
    async ({ query, platform, limit }: { query?: string; platform?: Platform; limit: number }) => {
      try {
        if (!query) {
          return errorResult('provide query (or use get_app for a whole app session)');
        }
        const notes: string[] = [];
        const adapters = adaptersWith('flows');
        const perAdapter = await fanOut(
          adapters,
          (a) => a.getFlows!({ query, platform, limit }),
          notes,
        );
        const merged = interleaveMerge(perAdapter, limit, (f: UIFlow) => f.id);
        if (merged.length === 0) notes.push('no flows found');
        // Cache the first step image of each flow (not every step).
        // cacheFullRes mutates cachedUrls on the objects it is given —
        // keep the copies so the results can be written back onto both the
        // flow and its first step.
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
