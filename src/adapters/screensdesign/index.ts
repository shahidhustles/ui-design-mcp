import type { MetadataStore } from '../../cache/metadata.js';
import type { Config } from '../../config.js';
import { fetchJson, fetchText } from '../../http.js';
import { log } from '../../log.js';
import type { AppRecord, CatalogApp, UIScreen, UIFlow } from '../../types.js';
import { SourceError } from '../../types.js';
import type { Adapter, AppQuery, AppResult, AppSearchQuery, FlowQuery, Health } from '../adapter.js';
import { CATALOG_API, catalogFresh, mapCatalogApp, SOURCE, syncCatalog, type CatalogPage } from './catalog.js';
import { extractAppPage, type SdFrame } from './decode.js';

const PAGE_URL = (slug: string) => `https://screensdesign.com/apps/${slug}/`;

function toScreen(slug: string, app: AppRecord, f: SdFrame): UIScreen {
  return {
    id: `${SOURCE}:${slug}:${f.id}`,
    source: SOURCE,
    kind: 'screen',
    platform: 'ios',
    app: { name: app.name, slug, storeId: app.storeId, logoUrl: app.iconUrl },
    title: f.descriptionShort,
    tags: f.labels,
    imageUrls: [f.imageUrl],
    cachedUrls: [],
    thumbnailUrl: f.thumbnailUrl,
    sourceUrl: PAGE_URL(slug),
    capturedAt: f.createdAt,
  };
}

export function createScreensDesignAdapter(store: MetadataStore, cfg: Config): Adapter {
  async function resolveCatalogApp(name: string): Promise<CatalogApp> {
    if (!catalogFresh(store, cfg)) {
      log(`catalog stale or missing — running one-time sync (~55 pages)`);
      await syncCatalog(store, cfg);
    }
    let app = store.findApp(name);
    if (!app && store.catalogPartial()) {
      // A 429-truncated catalog may simply not contain this app yet.
      log(`"${name}" missing from partial catalog — resuming sync`);
      await syncCatalog(store, cfg);
      app = store.findApp(name);
    }
    if (!app) throw new SourceError(`app not found in ScreensDesign catalog: "${name}"`, SOURCE);
    return app;
  }

  async function loadAppPage(slug: string): Promise<{
    app: Record<string, unknown>;
    frames: SdFrame[];
    videoUrl?: string;
  }> {
    const cached = store.getAppPage(slug);
    if (cached) {
      log(`app page cache hit: ${slug}`);
      return {
        app: JSON.parse(cached.appJson ?? '{}') as Record<string, unknown>,
        frames: JSON.parse(cached.framesJson) as SdFrame[],
        videoUrl: cached.videoUrl ?? undefined,
      };
    }
    const html = await fetchText(SOURCE, PAGE_URL(slug), cfg);
    const page = extractAppPage(html);
    store.setAppPage(slug, page.videoUrl ?? null, JSON.stringify(page.frames), JSON.stringify(page.app));
    // Fold the fields only the SSR payload provides back into the catalog row.
    // findAppBySlug — findApp matches on the NAME column, and slug != name
    // for most apps (e.g. 'spotify-music-and-podcasts').
    const row = store.findAppBySlug(slug);
    if (row) {
      const merged: CatalogApp = {
        ...row,
        storeId: (page.app['store_id'] as string | undefined) ?? row.storeId,
        appstoreLink: (page.app['appstore_link'] as string | undefined) ?? row.appstoreLink,
        category: (page.app['category_primary'] as string | undefined) ?? row.category,
      };
      store.upsertApps([merged], new Date().toISOString());
    }
    return page;
  }

  function appRecord(row: CatalogApp, decoded: Record<string, unknown>): AppRecord {
    return {
      name: row.name,
      slug: row.slug,
      storeId: (decoded['store_id'] as string | undefined) ?? row.storeId ?? undefined,
      platform: 'ios',
      iconUrl: row.iconUrl ?? undefined,
      storeUrl: (decoded['appstore_link'] as string | undefined) ?? row.appstoreLink ?? undefined,
      category: (decoded['category_primary'] as string | undefined) ?? row.category ?? undefined,
      rating: row.rating ?? undefined,
      downloads: row.downloads ?? undefined,
      revenueUsdMonthly: row.revenue ?? undefined,
      paywallType: row.paywallType ?? undefined,
      onboardingStepCount: row.onboardingStepCount ?? undefined,
    };
  }

  async function doGetApp(q: AppQuery): Promise<AppResult> {
    const row = await resolveCatalogApp(q.name);
    const page = await loadAppPage(row.slug);
    const record = appRecord(row, page.app);
    const screens = page.frames.map((f) => toScreen(row.slug, record, f));
    return { app: record, screens, videoUrl: page.videoUrl };
  }

  return {
    name: SOURCE,
    capabilities: {
      platforms: ['ios'],
      kinds: ['screen', 'flow'],
      perApp: true,
      flows: true,
      appSearch: true,
    },

    async healthCheck(): Promise<Health> {
      try {
        await fetchJson<unknown>(SOURCE, 'https://api.screensdesign.com/v1/apps/?page=1', cfg);
        return { ok: true };
      } catch (e) {
        return { ok: false, note: e instanceof Error ? e.message : String(e) };
      }
    },

    /**
     * Browse the app catalog. `?name=` is the API's live substring search
     * (verified 2026-09-23: name=music → 48 hits, count field included);
     * category / no-query paths use the locally synced catalog.
     */
    async searchApps(q: AppSearchQuery): Promise<CatalogApp[]> {
      const limit = Math.min(q.limit ?? 10, 50);
      if (q.query) {
        try {
          const body = await fetchJson<CatalogPage>(
            SOURCE,
            `${CATALOG_API}?name=${encodeURIComponent(q.query)}&page=1`,
            cfg,
          );
          const apps = (body.results ?? []).map(mapCatalogApp).slice(0, limit);
          if (apps.length > 0) return apps;
        } catch (e) {
          log(`search_apps live query failed — local catalog fallback: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return store.searchAppsLocal(q.query, q.category, limit);
    },

    getApp: doGetApp,

    async getFlows(q: FlowQuery): Promise<UIFlow[]> {
      if (!q.app) return [];
      const res = await doGetApp({ name: q.app });
      if (res.screens.length === 0) return [];
      const first = res.screens[0]!;
      return [
        {
          id: `${SOURCE}:flow:${res.app.slug ?? q.app}`,
          source: SOURCE,
          kind: 'flow',
          platform: 'ios',
          app: { name: res.app.name, slug: res.app.slug, storeId: res.app.storeId, logoUrl: res.app.iconUrl },
          title: `${res.app.name} — full session recording`,
          tags: ['session-recording'],
          imageUrls: first.imageUrls,
          cachedUrls: [],
          thumbnailUrl: first.thumbnailUrl,
          videoUrl: res.videoUrl,
          sourceUrl: res.app.slug ? PAGE_URL(res.app.slug) : '',
          steps: res.screens,
        },
      ];
    },
  };
}
