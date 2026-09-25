import type { Adapter, Health, OnboardingQuery } from '../adapter.js';
import { fetchJson, fetchText } from '../../http.js';
import type { Config } from '../../config.js';
import type { MetadataStore } from '../../cache/metadata.js';
import type { AppRef, Platform, UIFlow, UIScreen } from '../../types.js';
import { SourceError } from '../../types.js';
import { extractNuxtPayload, findFlowsNode } from './decode.js';

export const SOURCE = 'nicelydone';

const BASE = 'https://nicelydone.club';
const ASSETS = 'https://assets.nicelydone.club';
/** Only public image transform (verified 2026-09-23: `.jpg` under /t/900x484/, png 404s). */
const IMAGE_PATH = 't/900x484';

// ── Source shapes (verified 2026-09-23) ───────────────────────────────────

interface NdTag {
  tag: { id: number; name: string; slug: string };
}

interface NdPattern {
  id: number;
  uuid: string;
  image: string;
  tags_keywords?: NdTag[] | null;
  width?: number | null;
  height?: number | null;
  html_path?: string | null;
  type?: string | null;
  is_restricted?: boolean;
}

interface NdCategory {
  id: number;
  slug: string;
  title: string;
  main_category?: string | null;
}

interface NdProductRef {
  id: number;
  title: string;
  slug: string;
  baseline?: string | null;
  logo?: string | null;
}

export interface NdFlow {
  id: number;
  title: string;
  /** Absent on taxonomy sample flows (content/meta) — mapFlow falls back to id. */
  uuid?: string;
  patterns: NdPattern[];
  categories?: NdCategory[];
  product?: NdProductRef;
}

interface NdCategoryMeta {
  id: number;
  title: string;
  slug: string;
  alt_keywords?: string | null;
  description?: string | null;
  main_category?: string | null;
  flows?: NdFlow[];
  _count?: { flows?: number };
}

interface NdContentApps {
  products: {
    id: number;
    title: string;
    slug: string;
    baseline?: string | null;
    logo?: string | null;
    _count?: { flows?: number };
  }[];
}

interface NdContentMeta {
  flowCategories: NdCategoryMeta[];
}

interface NdRefinements {
  suggestions?: string[];
  chips?: { label: string; count: number }[];
}

// ── Pure mappers (exported for tests) ─────────────────────────────────────

/** Only public transform: `t/900x484/<uuid>.jpg` (the API's `.png` names 404). */
export function patternImageUrl(pattern: Pick<NdPattern, 'uuid'>): string {
  return `${ASSETS}/${IMAGE_PATH}/${pattern.uuid}.jpg`;
}

export function productLogoUrl(logo: string | null | undefined): string | undefined {
  return logo ? `${ASSETS}/logos/${logo}` : undefined;
}

function tagNames(pattern: NdPattern): string[] {
  return (pattern.tags_keywords ?? [])
    .map((t) => t?.tag?.name?.toLowerCase().trim())
    .filter((s): s is string => Boolean(s));
}

function appRef(product: NdProductRef | undefined): AppRef | undefined {
  if (!product) return undefined;
  return {
    name: product.title,
    slug: product.slug,
    logoUrl: productLogoUrl(product.logo),
  };
}

/** One onboarding step (a full-page capture) → unified screen record. */
export function mapPatternStep(
  pattern: NdPattern,
  product: NdProductRef | undefined,
  sourceUrl: string,
): UIScreen {
  return {
    id: `${SOURCE}:pattern:${pattern.uuid}`,
    source: SOURCE,
    kind: 'screen',
    platform: 'web',
    app: appRef(product),
    tags: tagNames(pattern),
    imageUrls: [patternImageUrl(pattern)],
    cachedUrls: [],
    sourceUrl,
  };
}

/** ND flow (named, ordered patterns + categories + product) → unified flow. */
export function mapFlow(flow: NdFlow, sourceUrl: string): UIFlow {
  const app = appRef(flow.product);
  const steps = (flow.patterns ?? []).map((p) => mapPatternStep(p, flow.product, sourceUrl));
  const categoryTags = (flow.categories ?? [])
    .flatMap((c) => [c.title.toLowerCase(), c.slug])
    .filter(Boolean);
  const stepTags = steps.flatMap((s) => s.tags);
  const tags = [...new Set([...categoryTags, ...stepTags])];
  // Taxonomy sample flows (content/meta) carry a numeric id instead of a
  // uuid — categoryFlows synthesizes a unique one for them before mapping.
  const flowId = flow.uuid ?? String(flow.id);
  return {
    id: `${SOURCE}:flow:${flowId}`,
    source: SOURCE,
    kind: 'flow',
    platform: 'web',
    app,
    title: flow.title,
    tags,
    imageUrls: steps[0]?.imageUrls ?? [],
    cachedUrls: [],
    sourceUrl,
    steps,
  };
}

/** Category-slug-ish normalization for user input ("Signing up" → "signing-up"). */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function asFlows(value: unknown): NdFlow[] {
  return Array.isArray(value) ? (value as NdFlow[]) : [];
}

/** A decoded flows node must look like ND flows (uuid + patterns). */
function isNdFlowList(flows: unknown[]): flows is NdFlow[] {
  return flows.every(
    (f) =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as NdFlow).uuid === 'string' &&
      Array.isArray((f as NdFlow).patterns),
  );
}

function platformOk(platform: Platform | undefined, recordPlatform: Platform): boolean {
  return !platform || platform === 'unknown' || platform === recordPlatform;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export function createNicelyDoneAdapter(store: MetadataStore, cfg: Config): Adapter {
  /**
   * Product catalog (669 products, one call). healthCheck uses the same
   * endpoint, so `list_sources` warms the cache.
   */
  async function ensureProducts(): Promise<void> {
    if (store.ndProductCount() > 0 && store.catalogFresh(SOURCE, cfg.catalogTtlDays)) return;
    const body = await fetchJson<NdContentApps>(SOURCE, `${BASE}/api/content/apps`, cfg);
    store.upsertNdProducts(
      (body.products ?? []).map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.title,
        baseline: p.baseline ?? null,
        logoUrl: p.logo ?? null,
        flowCount: p._count?.flows ?? null,
      })),
      new Date().toISOString(),
    );
  }

  /**
   * Flow-category taxonomy (93 categories + 12 sample flows each, one call).
   * Best-effort: the endpoint has been observed returning empty category
   * arrays (2026-09-25) while its counts stay populated, so callers must
   * work without it — it only improves resolution and error hints.
   */
  async function ensureCategories(): Promise<void> {
    if (store.ndCategoryCount() > 0 && store.catalogFresh(`${SOURCE}-categories`, cfg.catalogTtlDays)) return;
    const body = await fetchJson<NdContentMeta>(SOURCE, `${BASE}/api/content/meta`, cfg);
    store.setNdFlowCategories(
      (body.flowCategories ?? []).map((c) => ({
        slug: c.slug,
        title: c.title,
        mainCategory: c.main_category ?? null,
        altKeywords: c.alt_keywords ?? null,
        description: c.description ?? null,
        sampleFlowsJson: JSON.stringify(c.flows ?? []),
        flowCount: c._count?.flows ?? null,
      })),
      new Date().toISOString(),
    );
  }

  /** SSR page → decoded flows node → ND flows. */
  async function flowsFromPage(path: string): Promise<NdFlow[]> {
    const html = await fetchText(SOURCE, `${BASE}${path}`, cfg);
    const payload = extractNuxtPayload(html);
    const node = findFlowsNode(payload);
    const flows = node ? asFlows(node.flows) : [];
    if (!isNdFlowList(flows)) return [];
    return flows;
  }

  async function categoryFlows(slug: string): Promise<NdFlow[]> {
    let flows: NdFlow[] = [];
    try {
      flows = await flowsFromPage(`/flows/${slug}`);
    } catch {
      // Unknown slug → the SSR route answers 500; fall through to the samples.
    }
    if (flows.length > 0) return flows;
    // Fallback: the sample flows cached with the taxonomy. Two quirks of
    // that data (observed 2026-09-25): exact-duplicate entries share a
    // numeric id, and *different* flows can share a first-pattern uuid —
    // neither is a safe id on its own. So dedupe on the full pattern-uuid
    // set, then synthesize a unique uuid (mapFlow's `flow.uuid ?? …` id
    // then collides with nothing).
    const row = store.allNdFlowCategories().find((c) => c.slug === slug);
    if (row?.sample_flows_json) {
      const samples: NdFlow[] = JSON.parse(row.sample_flows_json);
      const seen = new Set<string>();
      const unique = samples.filter((f) => {
        const key = (f.patterns ?? []).map((p) => p.uuid).join(',');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (unique.length > 0) {
        return unique.map((f, i) => (f.uuid ? f : { ...f, uuid: `sample-${slug}-${f.id}-${i}` }));
      }
    }
    return [];
  }

  /** First category slug (in order) whose SSR page carries flows. */
  async function flowsForSlugs(slugs: string[]): Promise<{ slug: string; flows: NdFlow[] } | null> {
    const seen = new Set<string>();
    for (const slug of slugs) {
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const flows = await categoryFlows(slug);
      if (flows.length > 0) return { slug, flows };
    }
    return null;
  }

  async function getOnboarding(q: OnboardingQuery): Promise<UIFlow[]> {
    const limit = q.limit ?? 6;
    if (q.app) {
      await ensureProducts();
      const product = store.findNdProduct(q.app);
      if (!product) throw new SourceError(`no Nicely Done product matching "${q.app}"`, SOURCE);
      let flows: NdFlow[] = [];
      try {
        flows = await flowsFromPage(`/apps/${product.slug}/flows`);
      } catch {
        // Page dead (500 for unknown-ish slugs) or layout changed → "no flows",
        // same as the category path; the tool surfaces a note.
      }
      return flows
        .filter((f) => platformOk(q.platform, 'web'))
        .slice(0, limit)
        .map((f) => mapFlow(f, `${BASE}/apps/${product.slug}/flows`));
    }

    if (q.category) {
      const wanted = q.category.toLowerCase().trim();
      const slugs: string[] = [slugify(wanted)];
      // The taxonomy (when populated) maps titles / alt-keywords to canonical slugs.
      try {
        await ensureCategories();
      } catch {
        // best-effort — the slugified input below still works
      }
      const cat = store.findNdFlowCategory(wanted) ?? store.findNdFlowCategory(slugify(wanted));
      if (cat) slugs.unshift(cat.slug);
      const hit = await flowsForSlugs(slugs);
      if (!hit) {
        const known = store
          .allNdFlowCategories()
          .slice(0, 8)
          .map((c) => c.title)
          .join(', ');
        const hint = known ? ` (known categories: ${known})` : '';
        throw new SourceError(`no onboarding flows for category "${q.category}"${hint}`, SOURCE);
      }
      return hit.flows
        .filter((f) => platformOk(q.platform, 'web'))
        .slice(0, limit)
        .map((f) => mapFlow(f, `${BASE}/flows/${hit.slug}`));
    }

    if (q.query) {
      const slugs: string[] = [];
      // 1) The site's own anonymous search facets: chips = flow categories the
      // site's backend associates with this query, ranked by corpus size.
      // Nonsense queries return an empty chip list — the built-in guard.
      // (Substring-matching labels ourselves can't bridge "signup" ↔ "Signing up".)
      try {
        const ref = await fetchJson<NdRefinements>(
          SOURCE,
          `${BASE}/api/search/global/refinements?q=${encodeURIComponent(q.query)}&contentType=flows`,
          cfg,
        );
        const chips = [...(ref.chips ?? [])].sort((a, b) => b.count - a.count);
        for (const c of chips.slice(0, 3)) slugs.push(slugify(c.label));
      } catch {
        // facet lookup is best-effort — the raw slug below still works
      }
      // 2) Taxonomy match (title / alt_keywords), when populated.
      try {
        await ensureCategories();
      } catch {
        // best-effort
      }
      const cat =
        store.findNdFlowCategory(q.query.toLowerCase().trim()) ??
        store.findNdFlowCategory(slugify(q.query));
      if (cat) slugs.unshift(cat.slug);
      // 3) The raw query, slugified — the category page may exist anyway.
      slugs.push(slugify(q.query));
      const hit = await flowsForSlugs(slugs);
      if (!hit) {
        throw new SourceError(
          `no onboarding flows match "${q.query}" — try a category like "signing-up" or "onboarding"`,
          SOURCE,
        );
      }
      return hit.flows
        .filter((f) => platformOk(q.platform, 'web'))
        .slice(0, limit)
        .map((f) => mapFlow(f, `${BASE}/flows/${hit.slug}`));
    }

    // No selector — the site's default flows listing (top of the catalog).
    const flows = await flowsFromPage('/flows');
    return flows
      .filter((f) => platformOk(q.platform, 'web'))
      .slice(0, limit)
      .map((f) => mapFlow(f, `${BASE}/flows`));
  }

  return {
    name: SOURCE,
    capabilities: {
      platforms: ['web'],
      kinds: ['flow', 'screen'],
      onboarding: true,
    },
    async healthCheck(): Promise<Health> {
      try {
        await ensureProducts();
        return { ok: true };
      } catch (e) {
        return { ok: false, note: e instanceof Error ? e.message : String(e) };
      }
    },
    getOnboarding,
  };
}
