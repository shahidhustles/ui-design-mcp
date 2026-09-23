import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { getAdapters } from '../adapters/adapter.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Config } from '../config.js';
import { errorResult, toolResult } from './common.js';

export function registerListSourcesTool(server: McpServer, store: MetadataStore, cfg: Config): void {
  server.registerTool(
    'list_sources',
    {
      title: 'List sources',
      description:
        'Health + capabilities of every source (1 cheap live request each), local record counts, catalog progress.',
      inputSchema: z.object({}).shape,
    },
    async () => {
      try {
        const results = await Promise.allSettled(
          getAdapters().map(async (a) => {
            const health = await a.healthCheck();
            store.setSourceStatus(a.name, health.ok, health.note);
            return {
              name: a.name,
              ok: health.ok,
              note: health.note ?? null,
              capabilities: a.capabilities,
            };
          }),
        );
        const sources = results.map((r) =>
          r.status === 'fulfilled'
            ? r.value
            : {
                name: 'unknown',
                ok: false,
                note: r.reason instanceof Error ? r.reason.message : String(r.reason),
                capabilities: {},
              },
        );
        return toolResult({
          sources,
          recordCounts: store.recordCounts(),
          catalog: {
            apps: store.appCount(),
            partial: store.catalogPartial(),
            syncedAt: store.catalogSyncedAt(),
          },
          cacheDir: cfg.cacheDir,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
