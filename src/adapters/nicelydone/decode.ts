/**
 * Decoder for nicelydone.club's SSR payload — the `<script id="__NUXT_DATA__">`
 * tag (Nuxt 3). The payload is a flat JSON array of values plus reference
 * indices ("devalue" encoding, @nuxt/devalue). Verified against the site's own
 * runtime decoder (extracted from its JS bundle, 2026-09-23).
 *
 * Encoding rules (mirrored 1:1 from the site's `GC`/`s` functions):
 * - every number is a reference into the flat array (out-of-range → undefined);
 * - sentinels: -1 undefined, -2 array hole, -3 NaN, -4 Infinity,
 *   -5 -Infinity, -6 -0, -7 sparse-array tag;
 * - `["Tag", …]` arrays are tagged values; known tags are decoded below and
 *   Nuxt revivers (ShallowReactive/Reactive/NuxtError) unwrap to their payload;
 * - `["null", k1, v1, …]` = plain object (null prototype);
 * - `[-7, length, idx, ref, …]` = sparse array;
 * - plain arrays are lists of references (-2 = hole);
 * - raw JSON objects may appear inline in the flat array (hybrid payloads) —
 *   their values are decoded recursively; non-number values are taken as
 *   literals (the reference case is the only one the strict encoder emits).
 *
 * Decoding is memoized per reference index — shared references are otherwise
 * re-decoded exponentially on large payloads.
 */

const UNDEFINED = -1;
const HOLE = -2;
const NAN = -3;
const INFINITY = -4;
const NEG_INFINITY = -5;
const NEG_ZERO = -6;
const SPARSE = -7;

type Revivers = Record<string, (value: unknown) => unknown>;

/** Nuxt wraps reactive state; the data content is the payload itself. */
export const NUXT_REVIVERS: Revivers = {
  ShallowReactive: (v) => v,
  Reactive: (v) => v,
  NuxtError: (v) => v,
};

interface Ctx {
  flat: unknown[];
  revivers: Revivers;
  memo: Map<number, unknown>;
  inProgress: Set<number>;
}

export function parseNuxtPayload(text: string): unknown {
  const root: unknown = JSON.parse(text);
  const flat = Array.isArray(root) ? root : [root];
  if (!Array.isArray(root) || root.length === 0) throw new Error('invalid nuxt payload');
  const ctx: Ctx = { flat, revivers: NUXT_REVIVERS, memo: new Map(), inProgress: new Set() };
  return decode(ctx, 0);
}

function decode(ctx: Ctx, o: unknown): unknown {
  // Sentinels first — they are negative, so they never collide with indices.
  if (o === UNDEFINED) return undefined;
  if (o === NAN) return Number.NaN;
  if (o === INFINITY) return Number.POSITIVE_INFINITY;
  if (o === NEG_INFINITY) return Number.NEGATIVE_INFINITY;
  if (o === NEG_ZERO) return -0;

  if (typeof o !== 'number') return o; // literal (strict encoder emits refs only)
  if (ctx.memo.has(o)) return ctx.memo.get(o);

  const value = ctx.flat[o]; // out-of-range → undefined, like the site's n[o]
  if (value === null || value === undefined || typeof value !== 'object') {
    ctx.memo.set(o, value);
    return value;
  }

  if (Array.isArray(value)) {
    const decoded = decodeArray(ctx, o, value);
    ctx.memo.set(o, decoded);
    return decoded;
  }

  // Raw JSON object inlined in the flat array (Nuxt hybrid payloads).
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    obj[k] = decode(ctx, v);
  }
  ctx.memo.set(o, obj);
  return obj;
}

function decodeArray(ctx: Ctx, idx: number, value: unknown[]): unknown {
  if (value.length === 0) return [];
  const first = value[0];

  if (typeof first === 'string') {
    // Tagged value — Nuxt revivers first (ShallowReactive & co. wrap payloads
    // that may be non-numeric; the site pushes those into the flat array and
    // follows the new reference, with a circular-reference guard).
    const reviver = ctx.revivers[first];
    if (reviver) {
      let d: unknown = value[1];
      if (typeof d !== 'number') d = ctx.flat.push(d as never) - 1;
      const di = d as number;
      if (ctx.inProgress.has(di)) throw new Error('invalid circular reference');
      ctx.inProgress.add(di);
      try {
        return reviver(decode(ctx, di));
      } finally {
        ctx.inProgress.delete(di);
      }
    }
    switch (first) {
      case 'Date':
        return new Date(value[1] as string);
      case 'Set': {
        const set = new Set<unknown>();
        for (let h = 1; h < value.length; h += 1) set.add(decode(ctx, value[h]));
        return set;
      }
      case 'Map': {
        const map = new Map<unknown, unknown>();
        for (let h = 1; h < value.length; h += 2) {
          map.set(decode(ctx, value[h]), decode(ctx, value[h + 1]));
        }
        return map;
      }
      case 'RegExp':
        return new RegExp(value[1] as string, (value[2] as string | undefined) ?? '');
      case 'Object':
        // Class instances: the site's decoder does `Object(l[1])` — faithful.
        return Object(value[1]);
      case 'BigInt':
        return BigInt(value[1] as string);
      case 'null': {
        const obj: Record<string, unknown> = Object.create(null);
        for (let h = 1; h < value.length; h += 2) {
          obj[value[h] as string] = decode(ctx, value[h + 1]);
        }
        return obj;
      }
      case 'URL':
        return new URL(value[1] as string);
      case 'URLSearchParams':
        return new URLSearchParams(value[1] as string);
      default:
        throw new Error(`unknown nuxt payload tag: ${first}`);
    }
  }

  if (first === SPARSE) {
    const length = value[1] as number;
    if (!Number.isInteger(length) || length < 0) throw new Error('invalid sparse array');
    const arr: unknown[] = new Array(length);
    for (let d = 2; d < value.length; d += 2) {
      const pos = value[d] as number;
      if (!Number.isInteger(pos) || pos < 0 || pos >= length) throw new Error('invalid sparse index');
      arr[pos] = decode(ctx, value[d + 1]);
    }
    return arr;
  }

  const arr: unknown[] = new Array(value.length);
  for (let c = 0; c < value.length; c += 1) {
    const d = value[c];
    if (d !== HOLE) arr[c] = decode(ctx, d);
  }
  return arr;
}

const PAYLOAD_RE = /<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)<\/script>/s;

/**
 * Extract + decode the `__NUXT_DATA__` payload from an ND SSR page.
 * Normal envelope: { data, state, once, _errors, serverRendered, path, isCached }.
 */
export function extractNuxtPayload(html: string): Record<string, unknown> {
  const m = html.match(PAYLOAD_RE);
  if (!m) throw new Error('no __NUXT_DATA__ script tag — page layout changed?');
  const parsed = parseNuxtPayload(m[1]!);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('unexpected nuxt payload root');
  return parsed as Record<string, unknown>;
}

/**
 * The decoded payload's `data` object holds one entry per SSR route loader,
 * keyed by a Nuxt-generated hash. Find the entry that carries a `flows`
 * array (app/category pages embed the flow list there) — largest list wins
 * when a page carries several.
 */
export function findFlowsNode(payload: Record<string, unknown>): { flows: unknown[]; count: unknown } | null {
  const data = payload['data'];
  if (typeof data !== 'object' || data === null) return null;
  let best: { flows: unknown[]; count: unknown } | null = null;
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    if (Array.isArray(v['flows']) && (v['flows'] as unknown[]).length > 0) {
      if (!best || (v['flows'] as unknown[]).length > (best.flows as unknown[]).length) {
        best = { flows: v['flows'] as unknown[], count: v['count'] };
      }
    }
  }
  return best;
}
