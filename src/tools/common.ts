import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { ensureImage, readImage } from '../cache/images.js';
import type { Config } from '../config.js';
import type { Adapter } from '../adapters/adapter.js';
import type { UIScreen } from '../types.js';

/**
 * Text payload (JSON) + optional inline image blocks. The payload is also
 * returned as `structuredContent` so MCP App widgets (and hosts that prefer
 * structured results) get the same data without parsing the text block.
 */
export function toolResult(payload: Record<string, unknown>, imageBlocks: { data: string; mimeType: string }[] = []): CallToolResult {
  const content: (TextContent | ImageContent)[] = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
  for (const img of imageBlocks) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  return { content, structuredContent: payload };
}

/** Tool-level failure: `isError` so the agent sees it, not a protocol crash. */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}

/**
 * Fan a call out to several adapters concurrently. A failing adapter
 * becomes a note — the server never crashes because of one source.
 */
export async function fanOut<T>(
  adapters: Adapter[],
  call: (a: Adapter) => Promise<T>,
  notes: string[] = [],
): Promise<T[]> {
  const settled = await Promise.allSettled(adapters.map((a) => call(a)));
  const out: T[] = [];
  settled.forEach((s, i) => {
    const name = adapters[i]?.name ?? 'adapter';
    if (s.status === 'fulfilled') {
      out.push(s.value);
    } else {
      notes.push(`${name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
    }
  });
  return out;
}

/** Round-robin interleave of per-adapter result lists, dedupe, cap. */
export function interleaveMerge<T extends { sourceUrl?: string; id: string }>(
  perAdapter: T[][],
  limit: number,
  dedupKey: (t: T) => string = (t) => t.id,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const maxLen = Math.max(0, ...perAdapter.map((l) => l.length));
  for (let i = 0; i < maxLen && out.length < limit; i++) {
    for (const list of perAdapter) {
      const item = list[i];
      if (!item) continue;
      const key = dedupKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= limit) break;
    }
  }
  return out;
}

const IMAGE_POOL = 4;

/**
 * Bounded-concurrency map that preserves input order. The per-source
 * RateLimiter (src/http.ts) reserves slots, so concurrent workers pace
 * themselves instead of bursting.
 */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Download each record's FULL-RES primary image once into the local cache
 * and fill `cachedUrls` with file:// paths. Failures → notes.
 */
export async function cacheFullRes(records: UIScreen[], max: number, cfg: Config, notes: string[]): Promise<void> {
  const targets = records
    .slice(0, max)
    .map((rec) => ({ rec, url: rec.imageUrls[0] }))
    .filter((t): t is { rec: UIScreen; url: string } => Boolean(t.url));
  await mapPool(targets, IMAGE_POOL, async ({ rec, url }) => {
    try {
      const file = await ensureImage(rec.source, url, cfg);
      rec.cachedUrls = [`file://${file}`];
    } catch (e) {
      notes.push(`cache miss ${rec.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

/** Inline base64 image blocks from thumbnails (small by design). */
export async function withImages(records: UIScreen[], maxBlocks: number, cfg: Config, notes: string[]): Promise<{ data: string; mimeType: string }[]> {
  const targets = records
    .slice(0, maxBlocks)
    .map((rec) => ({ rec, url: rec.thumbnailUrl ?? rec.imageUrls[0] }))
    .filter((t): t is { rec: UIScreen; url: string } => Boolean(t.url));
  const results = await mapPool(targets, IMAGE_POOL, async ({ rec, url }) => {
    try {
      const file = await ensureImage(rec.source, url, cfg);
      return readImage(file);
    } catch (e) {
      notes.push(`thumb ${rec.id}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  });
  return results.filter((b): b is { data: string; mimeType: string } => b !== null);
}
