import type { Adapter, AppResult, ComponentQuery, Health } from './adapter.js';
import { fetchJson } from '../http.js';
import type { Config } from '../config.js';
import type { MetadataStore } from '../cache/metadata.js';
import type { AppRecord, Platform, UIScreen, Kind } from '../types.js';
import { SourceError } from '../types.js';

export const SOURCE = 'simpleappshipper';

const BASE = 'https://simpleappshipper.com';

// ── Source shapes (verified 2026-09-23) ───────────────────────────────────

interface SasSitemapApp {
  id: string;
  name: string;
  bundle_id?: string | null;
  category?: string | null;
  last_updated_at?: string | null;
  screen_count?: number | null;
}

interface SasSitemap {
  apps: SasSitemapApp[];
  categories?: string[];
}

interface SasScreen {
  id: string;
  app_id?: string;
  image_url: string;
  thumbnail_url?: string | null;
  width?: number;
  height?: number;
  flow_index?: number | null;
  screen_type?: string | null;
  uploaded_at?: string | null;
  view_count?: number;
}

interface SasAppDetail {
  app: {
    id: string;
    name: string;
    bundle_id?: string | null;
    developer?: string | null;
    category?: string | null;
    rating?: number | null;
    rating_count?: number | null;
    price?: string | null;
    icon_url?: string | null;
    store_url?: string | null;
    description?: string | null;
  };
  related?: unknown;
  screens: SasScreen[];
}

interface SasDesignExample {
  slug: string;
  title: string;
  description?: string | null;
  href?: string | null;
  image_url: string;
}

interface SasUiElement {
  slug: string;
  name: string;
  category?: string | null;
  design_count?: number;
  design_examples?: SasDesignExample[];
}

interface SasUiElements {
  count?: number;
  ui_elements: SasUiElement[];
}

// ── Pure mappers (exported for tests) ─────────────────────────────────────

/** App Store id from a store_url like …/app/foo/id1029207872?uo=4. */
export function storeIdFromUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/id(\d+)/);
  return m ? m[1] : undefined;
}

/** App + full screens[] (one call) → unified AppResult, ordered by flow_index. */
export function mapAppDetail(detail: SasAppDetail): AppResult {
  const app: AppRecord = {
    name: detail.app.name,
    platform: 'ios',
    iconUrl: detail.app.icon_url ?? undefined,
    storeUrl: detail.app.store_url ?? undefined,
    storeId: storeIdFromUrl(detail.app.store_url),
    category: detail.app.category ?? undefined,
    rating: detail.app.rating ?? undefined,
  };
  const screens = [...(detail.screens ?? [])]
    .sort((a, b) => (a.flow_index ?? 0) - (b.flow_index ?? 0))
    .map((s): UIScreen => ({
      id: `${SOURCE}:screen:${s.id}`,
      source: SOURCE,
      kind: 'screen',
      platform: 'ios',
      app: { name: detail.app.name, logoUrl: detail.app.icon_url ?? undefined },
      title: s.screen_type ?? undefined,
      tags: [
        ...(s.screen_type ? [s.screen_type.toLowerCase()] : []),
        ...(detail.app.category ? [detail.app.category.toLowerCase()] : []),
      ],
      imageUrls: [s.image_url],
      cachedUrls: [],
      sourceUrl: `${BASE}/library`,
      capturedAt: s.uploaded_at ?? undefined,
    }));
  return { app, screens };
}

/**
 * A ui-element category → its design examples, as component records.
 * Query matching is done by the caller (category name/slug or example text).
 * Platform is 'unknown' — the library doesn't say which OS the designs are
 * for, so callers should not hard-filter components by platform.
 */
export function mapUiElement(element: SasUiElement): UIScreen[] {
  return (element.design_examples ?? []).map(
    (ex): UIScreen => ({
      // Element prefix: example slugs are unique per category only, and the
      // tool dedupes on id — a shared slug across categories would drop a record.
      id: `${SOURCE}:component:${element.slug}/${ex.slug}`,
      source: SOURCE,
      kind: 'component' as Kind,
      platform: 'unknown',
      app: undefined,
      title: ex.title,
      tags: [
        element.name.toLowerCase(),
        element.slug,
        ...(element.category ? [element.category.toLowerCase()] : []),
      ],
      imageUrls: [ex.image_url],
      cachedUrls: [],
      sourceUrl: ex.href ? `${BASE}${ex.href}` : `${BASE}/library`,
    }),
  );
}

/**
 * Filter the element library by a component query: match against category
 * name/slug first (whole category), otherwise individual example
 * title/description text.
 */
export function filterUiElements(elements: SasUiElement[], query: string): SasUiElement[] {
  const q = query.toLowerCase().trim();
  if (!q) return elements;
  const out: SasUiElement[] = [];
  for (const el of elements) {
    const categoryHit =
      el.name.toLowerCase().includes(q) || el.slug.toLowerCase().includes(q);
    if (categoryHit) {
      out.push(el);
      continue;
    }
    const examples = (el.design_examples ?? []).filter(
      (ex) =>
        ex.title.toLowerCase().includes(q) ||
        (ex.description ?? '').toLowerCase().includes(q),
    );
    if (examples.length > 0) out.push({ ...el, design_examples: examples });
  }
  return out;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export function createSimpleAppShipperAdapter(store: MetadataStore, cfg: Config): Adapter {
  /** App catalog (500 apps, one call). */
  async function ensureApps(): Promise<void> {
    if (store.sasAppCount() > 0 && store.catalogFresh(SOURCE, cfg.catalogTtlDays)) return;
    const body = await fetchJson<SasSitemap>(SOURCE, `${BASE}/api/sitemap`, cfg);
    store.upsertSasApps(
      (body.apps ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        bundleId: a.bundle_id ?? null,
        category: a.category ?? null,
        screenCount: a.screen_count ?? null,
      })),
      new Date().toISOString(),
    );
  }

  /** Component library (6 categories, ~20 examples, one call) — cached in meta. */
  async function uiElements(): Promise<SasUiElement[]> {
    const key = 'sas_ui_elements';
    const cached = store.getMeta(key);
    if (cached) {
      try {
        return (JSON.parse(cached) as SasUiElements).ui_elements ?? [];
      } catch {
        // corrupted cache — refetch below
      }
    }
    const body = await fetchJson<SasUiElements>(SOURCE, `${BASE}/api/ui-elements`, cfg);
    store.setMeta(key, JSON.stringify(body));
    return body.ui_elements ?? [];
  }

  async function getApp(q: { name: string; platform?: Platform }): Promise<AppResult> {
    await ensureApps();
    const hit = store.findSasApp(q.name);
    if (!hit) throw new SourceError(`no Simple App Shipper app matching "${q.name}"`, SOURCE);
    const detail = await fetchJson<SasAppDetail>(SOURCE, `${BASE}/api/apps/${hit.id}`, cfg);
    const result = mapAppDetail(detail);
    // Record counts for list_sources.
    const now = new Date().toISOString();
    for (const s of result.screens) store.upsertRecord({ id: s.id, source: SOURCE, kind: s.kind, platform: s.platform, payloadJson: s.title ?? '', createdAt: now });
    return result;
  }

  async function searchComponents(q: ComponentQuery): Promise<UIScreen[]> {
    const limit = q.limit ?? 12;
    const elements = await uiElements();
    const matched = filterUiElements(elements, q.query ?? '');
    const records = matched.flatMap((el) => mapUiElement(el)).slice(0, limit);
    // Record counts for list_sources — only the records actually served.
    const now = new Date().toISOString();
    for (const r of records) store.upsertRecord({ id: r.id, source: SOURCE, kind: r.kind, platform: r.platform, payloadJson: r.title ?? '', createdAt: now });
    return records;
  }

  return {
    name: SOURCE,
    capabilities: {
      platforms: ['ios'],
      kinds: ['screen', 'component'],
      perApp: true,
      components: true,
    },
    async healthCheck(): Promise<Health> {
      try {
        const body = await fetchJson<SasUiElements>(SOURCE, `${BASE}/api/ui-elements`, cfg);
        store.setMeta('sas_ui_elements', JSON.stringify(body));
        return { ok: true };
      } catch (e) {
        return { ok: false, note: e instanceof Error ? e.message : String(e) };
      }
    },
    getApp,
    searchComponents,
  };
}
