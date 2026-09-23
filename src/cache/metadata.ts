import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CatalogApp, FacetItem } from '../types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  store_id TEXT,
  category TEXT,
  rating REAL,
  downloads INTEGER,
  revenue REAL,
  paywall_type TEXT,
  onboarding_step_count INTEGER,
  icon_url TEXT,
  appstore_link TEXT,
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS app_pages (
  slug TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  video_url TEXT,
  frames_json TEXT NOT NULL,
  app_json TEXT
);
CREATE TABLE IF NOT EXISTS facets (
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  fetched_at TEXT,
  PRIMARY KEY (kind, item_id)
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  platform TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  name TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  note TEXT,
  checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_apps_name ON apps(name);
CREATE INDEX IF NOT EXISTS idx_records_source ON records(source, kind);
`;

interface AppRow {
  id: number;
  slug: string;
  name: string;
  store_id: string | null;
  category: string | null;
  rating: number | null;
  downloads: number | null;
  revenue: number | null;
  paywall_type: string | null;
  onboarding_step_count: number | null;
  icon_url: string | null;
  appstore_link: string | null;
  synced_at: string | null;
}

function rowToApp(row: AppRow): CatalogApp {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    storeId: row.store_id,
    category: row.category,
    rating: row.rating,
    downloads: row.downloads,
    revenue: row.revenue,
    paywallType: row.paywall_type,
    onboardingStepCount: row.onboarding_step_count,
    iconUrl: row.icon_url,
    appstoreLink: row.appstore_link,
  };
}

/**
 * All metadata lives here (sqlite, WAL). Images live as plain files — see
 * images.ts. Existence of a row/page = cache hit.
 */
export class MetadataStore {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Add columns introduced after a DB file already exists on disk. */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(app_pages)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'app_json')) {
      this.db.exec('ALTER TABLE app_pages ADD COLUMN app_json TEXT;');
    }
  }

  close(): void {
    this.db.close();
  }

  // ── ScreensDesign catalog ──────────────────────────────────────────────

  upsertApps(apps: CatalogApp[], syncedAt: string): number {
    const ins = this.db.prepare(`
      INSERT INTO apps (id, slug, name, store_id, category, rating, downloads, revenue,
                        paywall_type, onboarding_step_count, icon_url, appstore_link, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        store_id = excluded.store_id,
        category = excluded.category,
        rating = excluded.rating,
        downloads = excluded.downloads,
        revenue = excluded.revenue,
        paywall_type = excluded.paywall_type,
        onboarding_step_count = excluded.onboarding_step_count,
        icon_url = excluded.icon_url,
        appstore_link = excluded.appstore_link,
        synced_at = excluded.synced_at
    `);
    this.db.exec('BEGIN');
    try {
      for (const a of apps) {
        ins.run(
          a.id,
          a.slug,
          a.name,
          a.storeId ?? null,
          a.category ?? null,
          a.rating ?? null,
          a.downloads ?? null,
          a.revenue ?? null,
          a.paywallType ?? null,
          a.onboardingStepCount ?? null,
          a.iconUrl ?? null,
          a.appstoreLink ?? null,
          syncedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return apps.length;
  }

  /** Exact (case-insensitive) → prefix → substring, best rating first. */
  findApp(name: string): CatalogApp | null {
    const queries = [
      `SELECT * FROM apps WHERE name = ? COLLATE NOCASE ORDER BY rating IS NULL, rating DESC LIMIT 1`,
      `SELECT * FROM apps WHERE name LIKE ? || '%' ORDER BY rating IS NULL, rating DESC LIMIT 1`,
      `SELECT * FROM apps WHERE name LIKE '%' || ? || '%' ORDER BY rating IS NULL, rating DESC LIMIT 1`,
    ];
    for (const sql of queries) {
      const row = this.db.prepare(sql).get(name) as AppRow | undefined;
      if (row) return rowToApp(row);
    }
    return null;
  }

  appCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM apps').get() as { c: number };
    return row.c;
  }

  catalogSyncedAt(): string | null {
    return this.getMeta('catalog_synced_at');
  }

  setCatalogSyncedAt(iso: string, partial = false): void {
    this.setMeta('catalog_synced_at', iso);
    this.setMeta('catalog_partial', partial ? '1' : '0');
  }

  catalogPartial(): boolean {
    return this.getMeta('catalog_partial') === '1';
  }

  // ── Refero facet dictionaries ──────────────────────────────────────────

  setFacets(kind: string, items: FacetItem[], fetchedAt: string): void {
    const del = this.db.prepare('DELETE FROM facets WHERE kind = ?');
    const ins = this.db.prepare(
      'INSERT INTO facets (kind, item_id, name, fetched_at) VALUES (?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      del.run(kind);
      for (const item of items) ins.run(kind, item.id, item.name, fetchedAt);
      this.setMeta(`facets_fetched_at:${kind}`, fetchedAt);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getFacets(kind: string): FacetItem[] {
    const rows = this.db
      .prepare('SELECT item_id AS id, name FROM facets WHERE kind = ? ORDER BY name')
      .all(kind) as { id: string; name: string }[];
    return rows;
  }

  facetsFetchedAt(kind: string): string | null {
    return this.getMeta(`facets_fetched_at:${kind}`);
  }

  // ── Decoded ScreensDesign app pages ────────────────────────────────────

  getAppPage(slug: string): {
    fetchedAt: string;
    videoUrl: string | null;
    framesJson: string;
    appJson: string | null;
  } | null {
    const row = this.db
      .prepare('SELECT fetched_at, video_url, frames_json, app_json FROM app_pages WHERE slug = ?')
      .get(slug) as
      | { fetched_at: string; video_url: string | null; frames_json: string; app_json: string | null }
      | undefined;
    if (!row) return null;
    return {
      fetchedAt: row.fetched_at,
      videoUrl: row.video_url,
      framesJson: row.frames_json,
      appJson: row.app_json,
    };
  }

  setAppPage(slug: string, videoUrl: string | null, framesJson: string, appJson: string): void {
    this.db
      .prepare(
        `INSERT INTO app_pages (slug, fetched_at, video_url, frames_json, app_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           video_url = excluded.video_url,
           frames_json = excluded.frames_json,
           app_json = excluded.app_json`,
      )
      .run(slug, new Date().toISOString(), videoUrl, framesJson, appJson);
  }

  /** Exact slug match — the SSR fold needs this (findApp matches on name). */
  findAppBySlug(slug: string): CatalogApp | null {
    const row = this.db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRow | undefined;
    return row ? rowToApp(row) : null;
  }

  // ── Records (for record counts) ────────────────────────────────────────

  upsertRecord(rec: {
    id: string;
    source: string;
    kind: string;
    platform: string;
    payloadJson: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO records (id, source, kind, platform, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           created_at = excluded.created_at`,
      )
      .run(rec.id, rec.source, rec.kind, rec.platform, rec.payloadJson, rec.createdAt);
  }

  recordCounts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT source, COUNT(*) AS c FROM records GROUP BY source')
      .all() as { source: string; c: number }[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.source] = row.c;
    return out;
  }

  // ── Source health ──────────────────────────────────────────────────────

  setSourceStatus(name: string, ok: boolean, note: string | undefined): void {
    this.db
      .prepare(
        `INSERT INTO sources (name, ok, note, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           ok = excluded.ok,
           note = excluded.note,
           checked_at = excluded.checked_at`,
      )
      .run(name, ok ? 1 : 0, note ?? null, new Date().toISOString());
  }

  sourceStatus(): Record<string, { ok: boolean; note: string | null; checkedAt: string }> {
    const rows = this.db
      .prepare('SELECT name, ok, note, checked_at FROM sources')
      .all() as { name: string; ok: number; note: string | null; checked_at: string }[];
    const out: Record<string, { ok: boolean; note: string | null; checkedAt: string }> = {};
    for (const row of rows) {
      out[row.name] = { ok: row.ok === 1, note: row.note, checkedAt: row.checked_at };
    }
    return out;
  }

  // ── Misc kv ────────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
