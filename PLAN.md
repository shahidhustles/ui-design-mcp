# Implementation Plan — ui-design-mcp

**State:** greenfield (empty repo, not yet `git init`). Research complete — see `RESEARCH.md`
for source ranking, risks, and the full endpoint appendix. This file is the build plan.

**Build order (per decision):** Phase 1 = **Refero + ScreensDesign** → run it, verify,
then Phase 2 (**Mobbin first** — highest corpus value, cookie route; then bulk corpora),
Phase 3 (web galleries + Dribbble).
Policy: legality/ToS is a soft concern (owner-kept, sources are public) — rank by corpus
value and data cleanliness, not risk.

---

## 1. Stack & repo layout

- **TypeScript, Node ≥ 20**, `@modelcontextprotocol/sdk` (stdio transport), `tsx` for dev,
  `vitest` for tests. No framework. Check current SDK API via Context7 before coding.
- Plain `fetch` (Node 20 global). `cheerio` for the few HTML adapters (later phases).
  No DB in v1 — **SQLite via `node:sqlite` (Node 22+) or better-sqlite3** for metadata +
  an on-disk image cache (`data/cache/<source>/<sha1(url)>.<ext>`).

```
ui-design-mcp/
├─ src/
│  ├─ index.ts               # MCP server wiring: register tools, stdio transport
│  ├─ types.ts               # UIScreen, UIFlow, AppRecord (unified record shape)
│  ├─ cache/
│  │  ├─ metadata.ts         # sqlite: records table, sources table, upsert + query
│  │  └─ images.ts           # download-once image cache (sha1-keyed, ETag/Last-Modified)
│  ├─ adapters/
│  │  ├─ adapter.ts          # interface + registry
│  │  ├─ refero.ts           # PHASE 1
│  │  ├─ screensdesign.ts    # PHASE 1
│  │  ├─ apple-itunes.ts     # PHASE 1 (join for store screenshots, official API)
│  │  ├─ pageflows.ts        # PHASE 2
│  │  ├─ appshots.ts         # PHASE 2
│  │  ├─ simpleappshipper.ts # PHASE 2
│  │  ├─ nicelydone.ts       # PHASE 2
│  │  ├─ landbook.ts         # PHASE 3
│  │  ├─ awwwards.ts         # PHASE 3
│  │  ├─ saasframe.ts        # PHASE 3
│  │  ├─ pttrns.ts           # PHASE 3
│  │  ├─ mobbin.ts           # PHASE 2 (first; cookie route primary, RSC fallback)
│  │  └─ dribbble.ts         # PHASE 3 (user OAuth token)
│  └─ tools/
│     ├─ search-screens.ts   # fuses adapters by platform/kind
│     ├─ get-app.ts
│     ├─ get-flows.ts
│     ├─ find-sites.ts       # PHASE 3
│     ├─ find-components.ts  # PHASE 3
│     └─ get-store-screenshots.ts
├─ RESEARCH.md  PLAN.md
└─ data/ (gitignore)
```

## 2. Unified record shape (`src/types.ts`)

```ts
type Kind = 'screen' | 'flow' | 'site' | 'component' | 'store-listing';
interface UIScreen {
  id: string;                  // `${source}:${nativeId}`
  source: string;              // refero | screensdesign | …
  kind: Kind;
  platform: 'ios' | 'android' | 'web' | 'desktop' | 'unknown';
  app?: { name: string; slug?: string; storeId?: string; logoUrl?: string };
  title?: string;              // screen/flow name or AI caption
  tags: string[];              // screen type, patterns, elements — normalized lowercase
  imageUrls: string[];         // remote originals (highest res first)
  cachedUrls: string[];        // local file:// paths after download
  videoUrl?: string;
  colors?: string[];           // hex, when source provides
  fonts?: string[];
  sourceUrl: string;           // human-browsable page
  capturedAt?: string;
}
interface UIFlow extends UIScreen { steps: UIScreen[]; }   // ordered
```

**Adapter interface:**

```ts
interface Adapter {
  name: string;
  capabilities: { platforms: string[]; kinds: Kind[]; search?: boolean; flows?: boolean; perApp?: boolean; sites?: boolean };
  healthCheck(): Promise<{ ok: boolean; note?: string }>;   // 1 cheap request, surfaced in a `list_sources` tool
  searchScreens(q: { query?: string; platform?: string; tags?: string[]; limit?: number }): Promise<UIScreen[]>;
  getFlows?(q: { query?: string; platform?: string; limit?: number }): Promise<UIFlow[]>;
  getApp?(q: { name: string; platform?: string }): Promise<{ app: AppRecord; screens: UIScreen[] }>;
}
```

## 3. Phase 1a — Refero adapter (the search backbone)

Verified endpoints (2026-09-22, all unauthenticated, 200s):

- `GET https://api.refero.design/v1/search?query=<text>&page=N&order=trending|newest|oldest`
  - 24 records/page (fixed for anon); pagination `{current, next, pages, count}`;
    anon query cap 10,000 results — fine for search-shaped queries.
  - **Facet filters (Rails-style, repeatable):** `page_types[id][]=28`,
    `design_patterns[id][]=`, `page_elements[id][]=`, `site_id[id][]=51`,
    `fonts[id][]=`, `app_id[id][]=`, `flow_types[id][]=`, `categories[id][]=`.
    Use **id-bracket params** (name filters are partially ignored for anon).
  - Facet id dictionaries: `GET /v1/page_types/available`, `/v1/design_patterns/available` (87),
    `/v1/page_elements/available` (69), `/v1/apps/available` (24 iOS apps),
    `/v1/sites/available` (430 sites) — cache these locally at startup.
- `GET /v1/flows/<id>` → named flow with **ordered screenshots array**.
- Records already carry: `uuid, width/height, url[] (multi-frame), thumbnail_url,
  preview_url, video_url, colors (5× RGB), fonts[], page_url (REAL source page URL),
  site{domain,name,description,favicon}, page_types[], design_patterns[],
  page_elements[], flow_ids[], created_at`.
- Images: `https://images.refero.design/screenshots/<domain>/desktop/<uuid>/0.jpg`
  (+ `_thumb.jpg`, `_preview.jpg`) — open S3, no hotlink protection.

**Adapter notes:** map `page_types[]/design_patterns[]/page_elements[]` → `tags`;
`video_url` present → kind `flow`-ish multi-step. Anon pagination limits: to enumerate a
site fully, iterate `site_id[id][]` per site (430 calls, cache in sqlite).

## 4. Phase 1b — ScreensDesign adapter (per-app mobile depth)

Verified endpoints (2026-09-22, all unauthenticated):

- **Catalog API (Django REST):** `GET https://api.screensdesign.com/v1/apps/?page=N`
  - 50/page, 2,711 apps, ~55 pages. Fields per app: `name, slug, store_id,
    revenue, revenue_list (monthly), downloads, rating, paywall_type,
    onboarding_step_count, icon URL, category, appstore_link`.
  - `?category=<numeric>` filter; `GET /v1/apps/<numericId>/` for detail.
- **Per-app screens** — `GET https://screensdesign.com/apps/<slug>/` (SSR React-Router 7).
  **Decoding recipe (verified with curl; port to TS):**
  1. `m = html.match(/streamController\.enqueue\("((?:[^"\\]|\\.)*)"\)/)` — one enqueue holds everything.
  2. `s = JSON.parse('"'+m[1]+'"')` (unescapes the JS string).
  3. `flat = JSON.parse(s)` → flat array (turbo-stream format).
  4. Resolve refs: any value `{"_K": V}` means `{ flat[K]: resolve(flat[V]) }`;
     negative `V` = null. Recursively.
  5. App object: `root['loaderData']['routes/app-detail']['app']`;
     `replay_screens` / `featured_screens` are index lists → full frames.
  - Each replay frame: image at `https://media.screensdesign.com/avs-pp/<hash>.webp`
    (up to 2160×4666; `avs-pr` previews, `avs-thumbs` thumbs), `description_short`
    (AI caption), flow label, timestamp.
- **Full session recording:** JSON-LD `VideoObject.contentUrl` on the same page →
  `https://vz-*.b-cdn.net/<uuid>/play_720p.mp4`, CORS `*`, no auth.
- **Apple join (official, legal):** `GET https://itunes.apple.com/lookup?id=<store_id>&country=us`
  → `screenshotUrls` + metadata for all 2,711 apps.
- Full app URL index: `https://screensdesign.com/sitemap-apps.xml` (6.4MB, 2,711 URLs).
- robots.txt explicitly keeps ClaudeBot/GPTBot discoverable.

**Adapter notes:** `getApp(name)` = search catalog (sqlite after first sync) → slug →
decode page → `UIScreen[]` in flow order + videoUrl. Nightly full sync = 55 API pages
+ 2,711 app pages at ~1 rps ≈ 10 min; do it lazily first (on demand + cache).

## 5. Phase 1 tools (MCP surface)

1. `search_screens(query, platform?, tags?, limit=10)` → Refero (web+iOS) + Appshots when
   Phase 2 lands. Returns unified records; download top-N images into cache; include
   `cachedUrls` + `sourceUrl`.
2. `get_app(name, platform?)` → ScreensDesign (`app`, `revenue`, `paywall_type`, ordered
   `screens[]` + session video) ∪ Apple iTunes store screenshots.
3. `get_flows(query|app, platform?)` → Refero `/v1/flows` + ScreensDesign session recordings
   (video + frames).
4. `list_sources()` → per-adapter `healthCheck()` + record counts from sqlite.

**Config (env):** `UIMCP_CACHE_DIR` (default `./data`), `UIMCP_RATE_LIMIT_MS` (default 500),
`UIMCP_MAX_RESULTS` (default 24). Phase 2: `MOBBIN_COOKIE` (free Mobbin account — primary
search route, cookie stays local with the user). Phase 3: `DRIBBBLE_TOKEN`.

## 6. Phase 2 — dedicated tools for the two zero-auth niches (DONE 2026-09-25)

Decision (2026-09-23/24): rather than one more generic search, ship **two
dedicated tools** over two zero-auth, zero-new-env-var sources that fill gaps
nothing else covers. No sync CLI — Phase 1's on-demand + cache model holds.

| Source | New tool | What it uniquely provides |
|---|---|---|
| **Nicely Done** (nicelydone.club) | `get_onboarding(app?, category?, query?, platform?, limit≤20)` | 13k+ curated **onboarding flows**, organized per product and per flow category. Refero is web-only in practice and has no onboarding-first corpus. |
| **Simple App Shipper** (simpleappshipper.com/library) | `find_components(component, platform?, limit≤30)` + `get_app` perApp depth | **Component-grain** records (`kind: "component"`) — the only source with buttons/cards/tabs/charts as first-class. Also adds 500 iOS apps (app + all screens in one call) to `get_app`. Its 3,685 screens deliberately do **not** join free-text `search` (would overlap Refero). |

**Nicely Done mechanics** (probe-verified 2026-09-24/25):
- Catalog: `/api/content/apps` (669 products, one call) → `nd_products` table.
- Category path: SSR pages `/flows/{slug}` and `/apps/{slug}/flows` embed the flow
  list in the Nuxt `__NUXT_DATA__` payload (devalue flat-array encoding, decoded in
  `nicelydone/decode.ts`). Unknown slug → SSR 500 → fall back to the 12 taxonomy
  sample flows cached in sqlite.
- Query path: `/api/search/global/refinements?q=…&contentType=flows` returns the
  site's own ranked category chips (empty for nonsense queries — the built-in
  guard); top chips → category slugs.
- Taxonomy endpoint `/api/content/meta` (93 categories + sample flows) is
  **best-effort**: observed 2026-09-25 returning populated counts but empty
  category arrays, so the category path must not depend on it.
- Images: `assets.nicelydone.club/t/900x484/{uuid}.jpg` — the only public transform.

**Simple App Shipper mechanics** (probe-verified 2026-09-25):
- `/api/sitemap` (500 apps, one call) → `sas_apps` table; `/api/apps/{id}` returns
  app + full `screens[]` in one call, screens ordered by `flow_index`.
- `/api/ui-elements` (6 component categories, ~20 design examples) → component
  records. PNGs on `releases.simpleappshipper.com` (no auth).

**Deferred to Phase 3:** Mobbin (cookie route — user provides `MOBBIN_COOKIE` when
built; RSC fallback as the anonymous path) and Page Flows (flow videos). **Cut:**
Appshots.

## 6a. (superseded) original Phase 2 plan — Mobbin first, then bulk corpora

<details><summary>the pre-decision table, kept for the endpoint research</summary>

| Order | Source | Core call | Notes |
|---|---|---|---|
| 0 | **Mobbin** (see §7) | cookie route: `POST /api/search-bar/search`, `/api/app/fetch-app-versions-screens`, `/api/discover/fetch-discover-page-apps`, `/api/screen/fetch-screen-info` | 621k screens / 323k flows — top value. Free-account cookie `sb-ujasntkfphywizsdaapi-auth-token.0/.1` (config). Fallback (no cookie): `sitemap.xml` → 1,330 `/explore/*` pages, parse Next 15 RSC flight stream (60 screens or 12 ordered flows/page) + `bytescale.mobbin.com` CDN (no auth). |
| 1 | Page Flows | `post-sitemap.xml` → SSR `/post/<platform>/<flow>/<product>/` → `<source src="/media/videos/*.mp4">` + posters | free CSV taxonomy at `/static/website/csv/{flows,elements,screens,products,flow_synonyms}.csv` |
| 2 | Appshots | `be.appshots.design/api/v1/neo/get_all_screens_filtered/?content_type=screens&platform=ios&page=N&page_size=100` (+`_apps_`, `_flows_`, `get_all_filters`) | anon `is_limited:true`; some watermarked thumbs; flow detail endpoint 404 anon (filtered endpoint inlines screens — use that) |
| 3 | Simple App Shipper | `/api/sitemap` (500 apps) → `/api/apps/{id}` (app+screens in one call); `/api/screens?limit=100&offset=N` (3,685 total); `/api/ui-elements` | CORS open; PNGs on `releases.simpleappshipper.com` |
| 4 | Nicely Done | `nicelydone.club/api/{apps,screens,flows}?page=N` | `/api/screens` caps at 1,000 — per-app `__NUXT_DATA__` SSR pages for the rest; only `900x484` image transform public |

</details>

## 7. Phase 3 — Mobbin + Page Flows + web galleries

- **Mobbin** (top value, from the superseded §6a row 0): primary = cookie route —
  the user provides `MOBBIN_COOKIE` (free account) when this is built;
  `POST /api/search-bar/search {query,experience,platform}`,
  `/api/app/fetch-app-versions-screens {appId}`, `/api/discover/fetch-discover-page-apps`,
  `/api/screen/fetch-screen-info` (live cookie-gated routes verified 2026-09-22; anon
  returns `200 {error:{message:"unauthenticated"}}`). Anonymous fallback:
  `sitemap.xml` → 1,330 `/explore/*` pages, concat `self.__next_f.push([1,…])` chunks
  → 60 screens or 12 ordered flows per page + `bytescale.mobbin.com` CDN (no auth).
  Legacy `/api/content/*` + 2023 Supabase RPCs are **dead**.
- **Page Flows:** `post-sitemap.xml` (8,544 URLs) → SSR
  `/post/<platform>/<flow>/<product>/` → `<source src="/media/videos/*.mp4">`
  (full recording, no auth) + poster frames. Free CSV taxonomy:
  `/static/website/csv/{flows,elements,screens,products,flow_synonyms}.csv`.
  The only source with end-to-end **flow videos** (Airbnb, Uber, Netflix…).
- **Land-book:** `/design/{cat}?page=N` (20/page, 10,460 sites; `?view=mobile` swaps capture;
  `?color=%23hex` etc. are server-side). Full-res originals: detail-page JSON-LD →
  unsigned `cdn.land-book.com/website/{id}/{file}` (signature not enforced). `llms.txt` + `rss.xml` for sync.
- **Awwwards:** `/websites/?page=N` (32/page) + `/sites/<slug>/content` JSON fragment;
  full-res = strip `media/cache/<size>/` prefix; open CDN.
- **SaaSFrame:** `sitemap.xml` (8,466) → JSON-LD `about.image` full-page captures.
- **Pttrns:** `/patterns?d3ab045c_page=N` (78×100) + `/patterns/{id}` (app + categories).
- **Dribbble:** official API v2 with the user's own OAuth token (`DRIBBBLE_TOKEN`, free tier
  ~200 req/hr) for shots/search — or undocumented internal JSON if the free tier's rate cap
  is too tight. Design shots, not app flows — complementary to the app-side sources.

## 8. Definition of done

### Phase 1 (verify against live endpoints) — DONE

- [x] `npm run dev` starts the stdio server; `list_sources` shows refero+screensdesign+apple healthy.
- [x] `search_screens("checkout", platform="ios")` returns ≥5 Refero records with working `cachedUrls` (image file on disk, >10KB).
- [x] `search_screens("dashboard")` returns web records with `colors[]` populated.
- [x] `get_app("Spotify")` returns ordered screens (≥5) from ScreensDesign + Apple store screenshots + 720p session video URL.
- [x] `get_flows("onboarding")` returns ≥1 Refero flow with `steps.length > 1`.
- [x] Kill network mid-test → cached images still served (cache-hit path works).
- [x] Unit tests: Refero tag mapping, ScreensDesign `_K`-ref resolver (fixture HTML),
      apple-lookup URL builder.

### Phase 2 (verify against live endpoints) — DONE 2026-09-25

- [x] `npm test` — all green (106 tests, incl. ND devalue decoder + mapper + adapter,
      SAS mappers + adapter, fixture-driven).
- [x] `npm run build` — clean.
- [x] `npm run verify -- all` — **10 subcommands green**, including:
  - [x] `list-sources`: 5 sources healthy (nicelydone + simpleappshipper present).
  - [x] `get-onboarding`: ordered onboarding flow, `steps.length > 1`, first-step image
        cached on disk >10KB, ≥1 inline image block.
  - [x] `search-components`: ≥3 records with `kind:"component"`, cached image on disk.
  - [x] `get-app-spotify` and `offline-cache` — unchanged, still pass.
- [x] Manual NDJSON probe of both new tools via `npm run dev`.

## 9. Conventions

- Every adapter: browser-like UA, 1–2 req/s default, 3 retries w/ backoff, per-source
  timeout 15s; errors → `note` in tool result, never crash the server.
- `healthCheck()` = cheapest possible request (e.g. `/v1/page_types/available` for Refero,
  one sitemap HEAD for SaaSFrame) — never full-page HTML.
- Git: init repo, `git init` + conventional commits; commit message attribution lines
  per session rules.
- Suggested skills for the build session: `context7-mcp` (MCP SDK current API),
  `run` (start the server and drive it), `code-review` before merging each adapter.
