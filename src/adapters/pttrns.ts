import type { Adapter, ComponentQuery, Health } from './adapter.js';
import { fetchJson, fetchText } from '../http.js';
import type { Config } from '../config.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { Kind, Platform, UIScreen } from '../types.js';

export const SOURCE = 'pttrns';

const BASE = 'https://app.pttrns.com';
/**
 * Jetboost LIST_FILTER booster over the site's unified CMS collection.
 * `?q={category-slug}` → `{ "<pattern-id>": true, … }` — every pattern
 * carrying that category (UX pattern, UI element, or business vertical).
 * Verified live 2026-09-25: loading /patterns?categories=login in a
 * browser fires exactly this call and hides all other pattern cards.
 * (Response keys are pattern ids 12…10172; app list items are keyed by
 * slug, so there is no id-space collision.)
 */
const FILTER_BOOSTER = 'ckif2du7qfmz607153hgl2o8b';
const FILTER_API = `https://api.jetboost.io/filter?boosterId=${FILTER_BOOSTER}`;

// ── Source shapes ────────────────────────────────────────────────────────

export interface PttrnsCategory {
  slug: string;
  title: string;
}

export interface PttrnsDetail {
  appName: string;
  appTagline?: string;
  appSlug?: string;
  appIconUrl?: string;
  uxCategories: string[];
  uiElements: string[];
  /** The app's business vertical ("Shopping", …) — the third metadata block. */
  appCategory: string[];
  imageUrl: string;
  /** `-p-500` variant — only present on recent uploads (older ones have no srcset). */
  thumbnailUrl?: string;
}

export interface PttrnsAppPattern {
  id: string;
  imageUrl: string;
  thumbnailUrl?: string;
  appName?: string;
}

// ── Pure mappers (exported for tests) ────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Near-synonyms users type that the 100-category taxonomy labels differently.
 * (The site's own search box resolves these too — via the app/category
 * cross-match, which we don't reproduce; the map is cheaper.)
 */
export const CATEGORY_SYNONYMS: Record<string, string> = {
  onboarding: 'guided-tour',
  'sign up': 'signup',
  'log in': 'login',
  'tab bar': 'bottom-bar',
  'bottom navigation': 'bottom-bar',
  'loading screen': 'loading-bar',
};

/** "Signing up" → "signing-up" (site category/app slug normalization). */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The /patterns "Categories" sidebar (100 items, SSR) → category taxonomy. */
export function parseCategoryTaxonomy(html: string): PttrnsCategory[] {
  const out: PttrnsCategory[] = [];
  for (const chunk of html.split('category-search-item').slice(1)) {
    const slug = chunk.match(/jetboost-list-item" value="([^"]+)"/)?.[1];
    const title = chunk.match(/class="search-result category-search-result[^"]*"[^>]*>([^<]+)</)?.[1];
    if (slug && title) out.push({ slug, title: decodeEntities(title.trim()) });
  }
  return out;
}

/**
 * Visible labels of one metadata block on a pattern detail page. Webflow
 * renders the full label list in each block and marks non-applicable ones
 * with `w-condition-invisible`, so visible = the pattern's actual labels.
 */
function blockLabels(html: string, header: RegExp): string[] {
  const i = html.search(header);
  if (i < 0) return [];
  const next = html.indexOf('metadata-header', i + 10);
  const seg = html.slice(i, next > 0 ? next : i + 4000);
  const labels: string[] = [];
  const re = /class="metadata-text-link([^"]*)"[^>]*>([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) {
    if (!m[1]!.includes('w-condition-invisible')) labels.push(decodeEntities(m[2]!).trim());
  }
  return labels;
}

/** Pattern detail page → app + categories + main screenshot. null if the layout changed. */
export function parsePatternDetail(html: string): PttrnsDetail | null {
  const imgTag = html.match(/<img[^>]*class="pattern-screenshot-image"[^>]*>/)?.[0];
  const src = imgTag?.match(/src="([^"]+)"/)?.[1];
  const appName = html.match(/<div class="app-name">([^<]+)<\/div>/)?.[1];
  if (!src || !appName) return null;
  const p500 = imgTag?.match(/https:[^"\s]+-p-500\.(?:jpe?g|png|webp)/i)?.[0];
  return {
    appName: decodeEntities(appName.trim()),
    appTagline: decodeEntities((html.match(/<div class="app-tagline">([^<]*)<\/div>/)?.[1] ?? '').trim()),
    appSlug: html.match(/href="(\/applications\/[^"]+)" class="pattern-info-app-name/)?.[1],
    appIconUrl: html.match(/<img[^>]*class="app-icon"[^>]*>/)?.[0]?.match(/src="([^"]+)"/)?.[1],
    uxCategories: blockLabels(html, /metadata-header">UX[\s ]+Patterns</),
    uiElements: blockLabels(html, /metadata-header">UI[\s ]+Elements</),
    // The block's wrapper class says "hidden" even when populated — the
    // per-item w-condition-invisible flag is the real signal.
    appCategory: blockLabels(html, /metadata-header">app category</),
    imageUrl: src,
    thumbnailUrl: p500,
  };
}

/**
 * /applications/{slug} page → that app's pattern cards (id + screenshot).
 * Cards carry the app name in the hover title; older layouts fall back to
 * undefined and the caller derives it from the slug.
 */
export function parseAppPagePatterns(html: string): PttrnsAppPattern[] {
  const out: PttrnsAppPattern[] = [];
  for (const chunk of html.split('patterns-collection-item').slice(1)) {
    const id = chunk.match(/jetboost-list-item" value="(\d+)"/)?.[1];
    const src = chunk.match(/src="(https:\/\/cdn\.prod\.website-files\.com\/[^"]+\.(?:jpe?g|png|webp))"/)?.[1];
    if (!id || !src) continue;
    const p500 = src.replace(/(\.(?:jpe?g|png|webp))$/, '-p-500$1');
    const has500 = /https:[^"\s]+-p-500\.(?:jpe?g|png|webp)/i.test(chunk);
    out.push({
      id,
      imageUrl: src,
      thumbnailUrl: has500 ? p500 : undefined,
      appName: decodeEntities((chunk.match(/class="hover-description-title">([^<]+)</)?.[1] ?? '').trim()),
    });
  }
  return out;
}

/** One pattern → unified component record. */
export function mapPatternRecord(
  id: string,
  d: {
    appName?: string;
    appSlug?: string;
    appIconUrl?: string;
    categories: string[];
    imageUrl: string;
    thumbnailUrl?: string;
  },
): UIScreen {
  const tags = new Set<string>();
  for (const c of d.categories) {
    const t = c.toLowerCase();
    if (t) tags.add(t);
  }
  if (d.appName) tags.add(d.appName.toLowerCase());
  const primary = d.categories[0] ?? 'UI pattern';
  return {
    id: `${SOURCE}:pattern:${id}`,
    source: SOURCE,
    kind: 'component' as Kind,
    // Pttrns is an iOS pattern corpus (the site has no device toggle).
    platform: 'ios',
    app: d.appName ? { name: d.appName, slug: d.appSlug, logoUrl: d.appIconUrl } : undefined,
    title: d.appName ? `${d.appName} — ${primary}` : primary,
    tags: [...tags],
    imageUrls: [d.imageUrl],
    thumbnailUrl: d.thumbnailUrl,
    cachedUrls: [],
    sourceUrl: `${BASE}/patterns/${id}`,
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────

/** Bounded-concurrency map preserving input order (nulls pass through). */
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R | null>): Promise<(R | null)[]> {
  const results = new Array<R | null>(items.length);
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

export function createPttrnsAdapter(store: MetadataStore, cfg: Config): Adapter {
  /** Category taxonomy (100 categories, one page) — cached in meta. */
  async function taxonomy(): Promise<PttrnsCategory[]> {
    const key = 'pttrns_categories';
    const cached = store.getMeta(key);
    if (cached) {
      try {
        return JSON.parse(cached) as PttrnsCategory[];
      } catch {
        // corrupted cache — refetch below
      }
    }
    const html = await fetchText(SOURCE, `${BASE}/patterns`, cfg);
    const cats = parseCategoryTaxonomy(html);
    if (cats.length > 0) store.setMeta(key, JSON.stringify(cats));
    return cats;
  }

  /** Category → pattern ids, newest first (the site's grid order). */
  async function categoryPatternIds(slug: string): Promise<string[]> {
    const body = await fetchJson<Record<string, unknown>>(SOURCE, `${FILTER_API}&q=${encodeURIComponent(slug)}`, cfg);
    return Object.keys(body)
      .filter((k) => k !== 'message' && /^\d+$/.test(k))
      .sort((a, b) => Number(b) - Number(a));
  }

  /** Detail page for the app/categories of one pattern. */
  async function detail(id: string): Promise<PttrnsDetail | null> {
    const html = await fetchText(SOURCE, `${BASE}/patterns/${id}`, cfg);
    return parsePatternDetail(html);
  }

  function recordCounts(records: UIScreen[]): void {
    const now = new Date().toISOString();
    for (const r of records) {
      store.upsertRecord({ id: r.id, source: SOURCE, kind: r.kind, platform: r.platform, payloadJson: r.title ?? '', createdAt: now });
    }
  }

  async function searchComponents(q: ComponentQuery): Promise<UIScreen[]> {
    const limit = q.limit ?? 12;
    const query = (q.query ?? '').trim();
    // iOS-only corpus — a web/android request matches nothing.
    if (!query || (q.platform && q.platform !== 'ios' && q.platform !== 'unknown')) return [];

    // 1) Category axis: match in the taxonomy (synonym → slug → title).
    const cats = await taxonomy();
    const norm = query.toLowerCase();
    const wantSlug = CATEGORY_SYNONYMS[norm] ?? slugify(query);
    const cat =
      cats.find((c) => c.slug === wantSlug) ??
      cats.find((c) => c.title.toLowerCase() === norm);
    if (cat) {
      const ids = (await categoryPatternIds(cat.slug)).slice(0, limit);
      const details = await mapPool(ids, 4, async (id) => {
        try {
          return await detail(id);
        } catch {
          return null;
        }
      });
      const records: UIScreen[] = [];
      details.forEach((d, i) => {
        if (!d) return;
        records.push(
          mapPatternRecord(ids[i]!, {
            appName: d.appName,
            appSlug: d.appSlug,
            appIconUrl: d.appIconUrl,
            categories: [...d.uxCategories, ...d.uiElements, ...d.appCategory],
            imageUrl: d.imageUrl,
            thumbnailUrl: d.thumbnailUrl,
          }),
        );
      });
      recordCounts(records);
      return records;
    }

    // 2) App axis: the query looks like an app name — try its /applications page.
    const words = query.split(/\s+/);
    const slugs = [slugify(query), ...words.map(slugify)].filter((s, i, a) => s && a.indexOf(s) === i);
    for (const slug of slugs) {
      let html: string;
      try {
        // Unknown slugs 500 — single shot, no retry wait.
        html = await fetchText(SOURCE, `${BASE}/applications/${slug}`, cfg, { noRetry: true });
      } catch {
        continue;
      }
      const patterns = parseAppPagePatterns(html);
      if (patterns.length === 0) continue;
      const appName = patterns[0]!.appName || slug;
      const records = patterns
        .slice(0, limit)
        .map((p) =>
          mapPatternRecord(p.id, {
            appName,
            appSlug: slug,
            categories: [],
            imageUrl: p.imageUrl,
            thumbnailUrl: p.thumbnailUrl,
          }),
        );
      recordCounts(records);
      return records;
    }

    return [];
  }

  return {
    name: SOURCE,
    capabilities: {
      platforms: ['ios'],
      kinds: ['component'],
      components: true,
    },
    async healthCheck(): Promise<Health> {
      try {
        const cats = await taxonomy();
        return cats.length > 0 ? { ok: true } : { ok: false, note: 'category taxonomy empty' };
      } catch (e) {
        return { ok: false, note: e instanceof Error ? e.message : String(e) };
      }
    },
    searchComponents,
  };
}
