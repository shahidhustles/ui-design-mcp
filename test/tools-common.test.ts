import { describe, expect, it, vi } from 'vitest';
import { interleaveMerge, mapPool } from '../src/tools/common.js';
import type { UIScreen } from '../src/types.js';

describe('mapPool', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      await new Promise((r) => setTimeout(r, 10 / n)); // later items finish faster
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('runs at most `limit` items concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    await mapPool([1, 2, 3, 4, 5, 6], 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('rejects when an item fails', async () => {
    const fn = vi.fn(async (n: number) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    await expect(mapPool([1, 2, 3], 2, fn)).rejects.toThrow('boom');
  });
});

function screen(id: string, url?: string): UIScreen {
  return {
    id,
    source: 'refero',
    kind: 'screen',
    platform: 'web',
    tags: [],
    imageUrls: url ? [url] : [],
    cachedUrls: [],
    sourceUrl: url ?? `https://example.com/${id}`,
  };
}

describe('interleaveMerge', () => {
  it('round-robins adapters, dedupes by id, caps at limit', () => {
    const a = [screen('a:1'), screen('a:2')];
    const b = [screen('a:1'), screen('b:1'), screen('b:2')]; // a:1 duplicated across adapters
    // Row 0: a:1, then b's a:1 is a dup. Row 1: a:2, b:1. Cap at 3 stops here.
    const out = interleaveMerge([a, b], 3);
    expect(out.map((r) => r.id)).toEqual(['a:1', 'a:2', 'b:1']);
  });

  it('returns [] for empty inputs', () => {
    expect(interleaveMerge([[], []], 5)).toEqual([]);
  });
});
