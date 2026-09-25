import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { adaptersWith } from '../adapters/adapter.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import type { Platform, UIScreen } from '../types.js';
import { cacheFullRes, errorResult, fanOut, interleaveMerge, toolResult, withImages } from './common.js';

/**
 * Component-level and screen-type UI design patterns. Two sources:
 * Simple App Shipper (6 widget categories, OS-agnostic) and Pttrns
 * (100 screen-type/app categories across ~1,000 iOS apps — "login",
 * "button", "airbnb", …).
 */
export function registerFindComponentsTool(server: McpServer, store: MetadataStore, cfg: Config): void {
  void store;
  server.registerTool(
    'find_components',
    {
      title: 'Find components',
      description:
        'Component-level and screen-type UI design examples (Pttrns: login/signup/onboarding screens, buttons, ' +
        'navigation — by category or app name, iOS; Simple App Shipper: buttons, cards, lists, charts, tabs). ' +
        'For whole screens use search, for onboarding flows use get_onboarding.',
      inputSchema: {
        component: z
          .string()
          .describe(
            'Component or screen type: "button", "card", "login", "onboarding", "empty states", or an app name like "airbnb"',
          ),
        platform: z.enum(['ios', 'android', 'web', 'desktop', 'unknown']).optional(),
        limit: z.number().int().min(1).max(30).default(12),
      },
    },
    async ({ component, platform, limit }: { component: string; platform?: Platform; limit: number }) => {
      try {
        if (!component.trim()) return errorResult('provide component');
        const notes: string[] = [];
        if (platform && platform !== 'unknown') {
          notes.push('component sources are iOS-only (Pttrns) or OS-agnostic (Simple App Shipper) — platform was not filtered');
        }
        const perAdapter = await fanOut(
          adaptersWith('components'),
          (a) => a.searchComponents!({ query: component, platform, limit }),
          notes,
        );
        const merged = interleaveMerge(perAdapter, limit, (r: UIScreen) => r.id);
        if (merged.length === 0) {
          notes.push('no components matched — try a category ("button", "login", "onboarding") or an app name ("airbnb")');
        }
        await cacheFullRes(merged, Math.min(limit, 10), cfg, notes);
        // Keep the inline set small: SAS full-res PNGs (~645KB) have no
        // thumbnail transform; Pttrns inlines its ~70KB -p-500 variant.
        // get_image serves the rest at full res.
        const blocks = await withImages(merged, 4, cfg, notes);
        return toolResult({ count: merged.length, components: merged, notes }, blocks);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
