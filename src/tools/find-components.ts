import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { adaptersWith } from '../adapters/adapter.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import type { Platform, UIScreen } from '../types.js';
import { cacheFullRes, errorResult, fanOut, interleaveMerge, toolResult, withImages } from './common.js';

/**
 * Component-level UI design patterns (Simple App Shipper library): buttons,
 * cards, lists, charts, tabs, navigation bars — one captured screen per
 * component example, with a description. The only source with component-grain
 * records (Phase 3 may add Pttrns here).
 */
export function registerFindComponentsTool(server: McpServer, store: MetadataStore, cfg: Config): void {
  void store;
  server.registerTool(
    'find_components',
    {
      title: 'Find components',
      description:
        'Component-level UI design examples (Simple App Shipper library: buttons, cards, lists, charts, tabs, ' +
        'navigation bars) — one captured screen per component, with description. For whole screens use search, ' +
        'for onboarding flows use get_onboarding.',
      inputSchema: {
        component: z.string().describe('Component to look up: "button", "card", "list", "chart", "tab", "navigation"'),
        platform: z.enum(['ios', 'android', 'web', 'desktop', 'unknown']).optional(),
        limit: z.number().int().min(1).max(30).default(12),
      },
    },
    async ({ component, platform, limit }: { component: string; platform?: Platform; limit: number }) => {
      try {
        if (!component.trim()) return errorResult('provide component');
        const notes: string[] = [];
        if (platform && platform !== 'unknown') {
          notes.push('the component library is OS-agnostic — platform was not filtered');
        }
        const perAdapter = await fanOut(
          adaptersWith('components'),
          (a) => a.searchComponents!({ query: component, platform, limit }),
          notes,
        );
        const merged = interleaveMerge(perAdapter, limit, (r: UIScreen) => r.id);
        if (merged.length === 0) notes.push('no components matched — try "button", "card", "list", "chart", "tab", "navigation"');
        await cacheFullRes(merged, Math.min(limit, 10), cfg, notes);
        // No thumbnail transform exists on this CDN — full-size PNGs are
        // hundreds of KB each, so keep the inline set small (get_image for more).
        const blocks = await withImages(merged, 4, cfg, notes);
        return toolResult({ count: merged.length, components: merged, notes }, blocks);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
