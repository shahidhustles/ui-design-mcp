import { SourceError } from '../../types.js';

/**
 * Pure decoder for ScreensDesign app pages (React Router 7 SSR).
 *
 * The page embeds a turbo-stream v2 payload in `streamController.enqueue("…")`:
 *   1. match the enqueued JS string literal
 *   2. JSON.parse('"…"') to unescape it
 *   3. JSON.parse → flat array `values`
 *   4. resolve from index 0:
 *        - number entry → literal (negative = sentinel, see SENTINELS)
 *        - string/bool entry → literal
 *        - array entry → tagged type ([tag, …]) or list of element indices
 *        - object entry → { [resolve(keyIdx)]: resolve(valueIdx) } per `{"_K": V}`
 *
 * App object lives at `root.loaderData['routes/app-detail'].app`.
 * Semantics pinned against turbo-stream@2.4.1 + live page, 2026-09-23.
 */

export class DecodeError extends SourceError {
  constructor(message: string) {
    super(message, 'screensdesign');
    this.name = 'DecodeError';
  }
}

const SENTINELS: Record<number, unknown> = {
  [-1]: undefined, // HOLE
  [-2]: NaN,
  [-3]: -Infinity,
  [-4]: -0,
  [-5]: null,
  [-6]: Infinity,
  [-7]: undefined,
};

const TYPED_TAGS = new Set(['D', 'B', 'R', 'U', 'Y', 'S', 'M', 'E', 'N', 'Z', 'P']);

/** Extract the raw (still escaped) bodies of every enqueue call. */
export function extractEnqueued(html: string): string[] {
  const out: string[] = [];
  const re = /streamController\.enqueue\("((?:[^"\\]|\\.)*)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1]!);
  }
  if (out.length === 0) throw new DecodeError('no streamController.enqueue payload found');
  return out;
}

/** Unescape a JS string literal body (the enqueue argument). */
export function unescapeJsString(body: string): string {
  try {
    return JSON.parse(`"${body}"`);
  } catch (e) {
    throw new DecodeError(`unescaping enqueue body failed: ${e instanceof Error ? e.message : e}`);
  }
}

function makeTyped(tag: string, args: unknown[], resolve: (index: number) => unknown): unknown {
  const a0 = args[0];
  switch (tag) {
    case 'D':
      return new Date(Number(a0));
    case 'B':
      return BigInt(String(a0));
    case 'R':
      return new RegExp(String(a0), String(args[1] ?? ''));
    case 'U':
      return new URL(String(a0));
    case 'Y':
      return Symbol.for(String(a0));
    case 'S':
      return new Set(asIndexList(a0).map((i) => (i < 0 ? SENTINELS[i] : resolve(i))));
    case 'M': {
      const pairs = asIndexList(a0);
      const m = new Map<string, unknown>();
      for (let n = 0; n + 1 < pairs.length; n += 2) {
        const key = pairs[n]!;
        const val = pairs[n + 1]!;
        m.set(String(key < 0 ? SENTINELS[key] : resolve(key)), val < 0 ? SENTINELS[val] : resolve(val));
      }
      return m;
    }
    case 'E':
      return new Error(String(a0));
    case 'N': {
      // null-prototype object: {"_K": V, …}
      const o = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(a0 as Record<string, unknown>)) {
        if (k.startsWith('_')) o[String(resolve(Number(k.slice(1))))] = resolve(Number(v));
      }
      return o;
    }
    case 'Z':
      return resolve(Number(a0)); // alias
    case 'P':
      return undefined; // deferred promise — payload expected complete
    default:
      return { __turboTag: tag, args };
  }
}

function asIndexList(v: unknown): number[] {
  return Array.isArray(v) ? (v as number[]) : [];
}

/**
 * Resolve a turbo-stream v2 flat array from its root index (0).
 * `values[index]` that is a non-negative number is a LITERAL;
 * references only occur as array elements / object values / root position.
 * A NEGATIVE reference is an inline sentinel (null = -5 etc.), not an
 * array position — the real decoder switch-cases the sign before indexing.
 */
export function resolveTurbo<T = unknown>(values: unknown[]): T {
  const resolveAt = (index: number): unknown => {
    // Sign check FIRST: values[-5] is a missing key → undefined, so a
    // sentinel routed through an object value / N / Z alias would decode
    // as undefined instead of null without it.
    if (index < 0) return SENTINELS[index];
    const v = values[index];
    if (typeof v === 'number') {
      // Note: no `?? undefined` — the -5 sentinel IS null, and `??` would
      // clobber it. Missing keys return undefined naturally.
      return v < 0 ? SENTINELS[v] : v;
    }
    if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean') {
      return v;
    }
    if (Array.isArray(v)) {
      const tag = v[0];
      if (typeof tag === 'string') {
        // plain arrays hold numeric indices only — a string head means tag
        return TYPED_TAGS.has(tag)
          ? makeTyped(tag, v.slice(1), resolveAt)
          : { __turboTag: tag, args: v.slice(1) };
      }
      // elements are indices; NEGATIVES are inline sentinels (null etc.)
      return (v as number[]).map((i) => (i < 0 ? SENTINELS[i] : resolveAt(i)));
    }
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, valIdx] of Object.entries(v as Record<string, unknown>)) {
        if (k.startsWith('_')) {
          const key = String(resolveAt(Number(k.slice(1))));
          out[key] = resolveAt(Number(valIdx));
        } else {
          out[k] = valIdx;
        }
      }
      return out;
    }
    return v;
  };
  return resolveAt(0) as T;
}

/** Full session recording URL from the page's JSON-LD VideoObject. */
export function extractVideoUrl(html: string): string | undefined {
  const jsonLd = html.match(/"contentUrl"\s*:\s*"(https:[^"]+\.mp4)"/);
  if (jsonLd) return jsonLd[1];
  const cdn = html.match(/https:\/\/vz-[a-z0-9-]+\.b-cdn\.net\/[a-f0-9-]+\/[a-z0-9_]+\.mp4/);
  return cdn?.[0];
}

/**
 * Decoded session frame. Field names pinned 2026-09-23 from a live page:
 * `screen` = full-res (avs-pp), `preview` = real preview (avs-pr),
 * `description_short` = AI caption, `labels` = flow labels,
 * `timestamp` = seconds offset in the session recording.
 */
export interface SdFrame {
  id: number | string;
  hash: string;
  imageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  /** Seconds offset within the session video */
  timestamp?: string;
  descriptionShort?: string;
  labels: string[];
  createdAt?: string;
}

export interface SdAppPage {
  app: Record<string, unknown>;
  /** The `routes/app-detail` holder (replay_screens, screenshots, meta, …) */
  detail: Record<string, unknown>;
  frames: SdFrame[];
  videoUrl?: string;
}

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function hashFromUrl(url: string | undefined): string {
  if (!url) return '';
  const name = url.split('/').pop() ?? '';
  return name.replace(/\.[a-z0-9]+$/i, '');
}

/** Map decoded `replay_screens` / `featured_screens` entries to frames. */
export function mapFrames(raw: unknown): SdFrame[] {
  if (!Array.isArray(raw)) return [];
  const out: SdFrame[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const url = pickString(o, ['screen', 'url', 'image_url', 'imageUrl']);
    const preview = pickString(o, ['preview', 'preview_url', 'thumbnail_url']);
    const rawHash = typeof o['hash'] === 'string' ? (o['hash'] as string) : '';
    const h = hashFromUrl(url) || rawHash;
    if (!h && !preview) continue;
    const labels = Array.isArray(o['labels'])
      ? (o['labels'] as unknown[]).filter((l): l is string => typeof l === 'string')
      : [];
    const idRaw = o['id'];
    out.push({
      id: typeof idRaw === 'number' || typeof idRaw === 'string' ? idRaw : h,
      hash: h,
      imageUrl: url ?? (h ? `https://media.screensdesign.com/avs-pp/${h}.webp` : ''),
      thumbnailUrl: preview ?? (h ? `https://media.screensdesign.com/avs-thumbs/${h}.webp` : undefined),
      width: typeof o['width'] === 'number' ? o['width'] : undefined,
      height: typeof o['height'] === 'number' ? o['height'] : undefined,
      timestamp: pickString(o, ['timestamp']),
      descriptionShort: pickString(o, ['description_short', 'descriptionShort', 'caption']),
      labels,
      createdAt: pickString(o, ['created_at']),
    });
  }
  return out;
}

/** Decode one app page: app object + detail holder + ordered frames + video. */
export function extractAppPage(html: string): SdAppPage {
  const bodies = extractEnqueued(html);
  let app: Record<string, unknown> | null = null;
  let detail: Record<string, unknown> | null = null;
  for (const body of bodies) {
    let flat: unknown;
    try {
      flat = JSON.parse(unescapeJsString(body));
    } catch {
      continue;
    }
    if (!Array.isArray(flat)) continue;
    let root: unknown;
    try {
      root = resolveTurbo(flat as unknown[]);
    } catch {
      continue;
    }
    const loaderData = (root as { loaderData?: Record<string, unknown> })?.loaderData;
    const detailCandidate = loaderData?.['routes/app-detail'] as
      | { app?: Record<string, unknown> }
      | undefined;
    if (detailCandidate?.app) {
      app = detailCandidate.app;
      detail = detailCandidate as Record<string, unknown>;
      break;
    }
  }
  if (!app || !detail) throw new DecodeError('app object not found at loaderData["routes/app-detail"].app');
  // replay_screens / featured_screens are SIBLINGS of `app`, not on it
  const frames = mapFrames(detail['replay_screens'] ?? detail['featured_screens']);
  return { app, detail, frames, videoUrl: extractVideoUrl(html) };
}
