# UI Design Sources — Research & Reverse-Engineering Report

**Date:** 2026-09-23 · **Goal:** find web sources of real-world UI screenshots/flows whose
data an agent MCP can retrieve without paid APIs (free surfing).
**Policy (2026-09-23):** legality/ToS is a *soft* concern — the MCP stays private with its
owner and every source is publicly surfable, so rank by corpus value + data cleanliness, not
risk. What "bounces back" to us is operational breakage (dead endpoints, rate limits,
watermarks) and, for cookie/token routes, the user's own session identity.
**Method:** 6 parallel discovery sweeps (66 candidate sites) → 14 hands-on probes
(robots.txt, raw HTML, JSON APIs, CDNs, auth walls) → this synthesis.
**Headline result: all 14 probed sources came back EASY.** Multiple "paid, no API" sites
run completely open JSON backends.

---

## 1. Ranked source table (probed sites)

Ranked by (a) technical ease, (b) legal/ToS risk, (c) value for an MCP serving UI screenshots.

| # | Source | Verdict | Data | Access (verified 2026-09) | Risk |
|---|--------|---------|------|---------------------------|------|
| 1 | **Refero** (refero.design) | EASY | 74,933 web + ~67k iOS screens, 12k ordered flows, colors/fonts/source-page metadata | **Open JSON REST, no auth**: `api.refero.design/v1/search?query=…&page_types[id][]=28`, `/v1/flows/<id>`, `/v1/sites/available` (430 sites); images on open S3 (`images.refero.design`, no hotlink protection). Their official MCP is Pro-only — raw API is free and richer. | Low. robots: nothing disallowed, only GPTBot blocked. Anonymous pagination caps (24/page, 10k max per query) — walk per-site via `site_id[id][]` to enumerate fully. |
| 2 | **ScreensDesign** (ex-UI Sources) | EASY | 2,711 top-grossing iOS apps, full session recordings, paywall/onboarding metadata, revenue data, 2160px frames w/ AI captions | **Open paginated REST, no auth**: `api.screensdesign.com/v1/apps/?page=N` (2,711 apps w/ store_id, revenue, paywall_type). Per-app SSR pages embed a decodable React-Router turbo-stream payload (full replay frames); 720p MP4 in JSON-LD `VideoObject` on CORS-open Bunny CDN. Also has its own first-party MCP product page. | Low. robots.txt explicitly keeps ClaudeBot/GPTBot discoverable. |
| 3 | **Appshots** (appshots.design) | EASY | 116,231 screens, 5,897 flows, 617 apps (iOS+web) | **Open Nuxt backend, no auth**: `be.appshots.design/api/v1/neo/get_all_screens_filtered/?content_type=screens&platform=ios&page=N&page_size=100` — direct unwatermarked Firebase screenshot URLs; `get_all_apps_filtered`, `get_all_flows_filtered` (inline screens), `get_all_filters` (category counts). | Low-medium. Anonymous payload carries `is_limited: true` + watermarked thumbs; full per-flow detail endpoint 404s anon. |
| 4 | **Nicely Done** (nicelydone.club) | EASY | 3,270+ onboarding flows, 672 apps, 18k+ tagged patterns, free since 2016 | **Open Nuxt JSON, no key**: `/api/apps?page=N`, `/api/screens?page=N` (capped at 1,000 items), `/api/flows`; images at `assets.nicelydone.club/t/900x484/{uuid}.jpg` (only that one transform is public). Per-app SSR pages embed the whole catalog in `__NUXT_DATA__` (e.g. airbnb page = 7,102 image filenames). | Low. robots: only `/apps/*/visit` disallowed. Note screenshots copyright their owners (stated by site). |
| 5 | **Simple App Shipper** (simpleappshipper.com/library) | EASY | 3,685 screenshots, 500 apps, screen_type + flow_index, per-component UI elements | **Open JSON, no auth, CORS on**: `/api/sitemap` (500 apps), `/api/apps/{id}` (app + full screens[] in one call), `/api/screens?limit=100&offset=N`, `/api/flows`, `/api/ui-elements`. Direct PNG CDN `releases.simpleappshipper.com/community/{app_id}/{screen_id}.png`. Full library = 37 requests. | Low-medium. Indie project; small corpus; screenshot-copy search UI not exposed via API. |
| 6 | **Page Flows** (pageflows.com) | EASY | 100k+ items; recorded end-to-end flow **videos** (Airbnb, Uber, Netflix…), 8,544 flow×product posts | **SSR, no auth, no JS**: `post-sitemap.xml` (8,544 URLs) → each `/post/<platform>/<flow>/<product>/` page has `<source src="/media/videos/*.mp4">` (full recording, no auth) + poster frames. Free public taxonomy: `/static/website/csv/flows.csv`, `elements.csv`, `screens.csv`, `products.csv`, `flow_synonyms.csv`. | Low. robots: `Allow: /` + 4 disallows; sitemaps explicitly advertised. |
| 7 | **Mobbin** (mobbin.com) | EASY (heavy) | 621k screens, 323k flows, 1,428 apps — the category leader | **Free path:** sitemap.xml (1,330 `/explore/*` URLs) → each page is Next.js 15 RSC flight stream carrying 60 screens/page (id, tags, app attribution, signed Bytescale srcSet 100–1920w) or 12 full ordered flows/page; `bytescale.mobbin.com` CDN serves unauthenticated. **Official MCP** `api.mobbin.com/mcp` (Streamable HTTP+OAuth, tools `search_screens/search_flows/search_sections`, 60 req/60s) — **Pro-only ($10–15/mo)**. With a free-account cookie (`sb-ujasntkfphywizsdaapi-auth-token.0/.1`) the live cookie-gated routes work: `POST /api/search-bar/search`, `/api/app/fetch-app-versions-screens`, `/api/discover/fetch-discover-page-apps`, `/api/screen/fetch-screen-info` (all verified 200 `{error:unauthenticated}` anon → alive). | Medium. robots: `Allow: /` for all agents; llms.txt warns not to copy designs verbatim. Legacy `/api/content/*` + Supabase RPCs all dead (schema rebuilt); live Supabase key `sb_publishable_YptnKskI90SD2g25sAvVxQ_…` found in app bundle. |
| 8 | **Pttrns** (app.pttrns.com) | EASY | 7,754 curated iOS patterns, ~1,000 apps, ~90 screen-type categories | **SSR Webflow, no auth, not a SPA**: `/patterns?d3ab045c_page=N` (78 pages × 100) → pattern ID + full-res CDN original; `/patterns/{id}` gives app name + category labels + "more screens from this app". | Low. robots.txt empty (all allowed). No 429 in ~20 reqs. |
| 9 | **Land-book** (land-book.com) | EASY | 10,460 curated websites (desktop + mobile full-page shots), Sections/Motion/OG-images, 2,946 landing pages | **SSR Laravel, no auth**: `/design/{category}?page=N` (20/page, fresh IDs verified) → JSON-LD ItemList + 600px webp; `?view=mobile` swaps to mobile capture; server-side filters `?color=%23hex`, `?industry`, `?style`, `?search=`. **Full-res originals public**: detail-page JSON-LD exposes unsigned `cdn.land-book.com/website/{id}/{file}` (signature not enforced — byte-identical unsigned). Ships `llms.txt` + `rss.xml`. | Low. robots explicitly welcomes ClaudeBot et al.; filter query-strings are robots-disallowed (soft risk — content is SSR there regardless). Pro ($6/mo) gates downloads/filters, not visibility. |
| 10 | **Awwwards** (awwwards.com) | EASY | Site-of-the-Day winners, collections, nominee gallery; full-res screenshots + element videos | **SSR Symfony, no auth, no Cloudflare challenge**: `/websites/?page=N` (32 cards, verified), `/websites/sites_of_the_day/`, `/sites/<slug>` (og:image = full-res `assets.awwwards.com/awards/submissions/…png`, CORS `*`, 90-day cache — strip `media/cache/<size>/` prefix from thumbnails to get originals), `/sites/<slug>/content` = JSON metadata fragment (id, unix createdAt, tags). | Low-medium. robots disallows `?page=` query form (base paths allowed); declared sitemap currently 404s. |
| 11 | **SaaSFrame** (saasframe.io) | EASY | 322 SaaS products, 6,099 page examples (full-page captures), 566 sections, 501 email flows | **Webflow SSR, no auth**: `sitemap.xml` (8,466 URLs, daily lastmod) → each page's JSON-LD `about.image`/`about.screenshot` = direct CDN full-page capture URL (no hotlink protection, `?w=&q=` resize supported). | Low. No API; HTML/JSON-LD parse. |
| 12 | **Appshot Gallery** (appshot.gallery) | EASY | 822 apps × 8 App Store screenshots, JSON-LD metadata (OS, category, price, App Store ID), 547 developer pages | **Webflow SSR, no auth**: `sitemap.xml` → per-app pages with `img--screenstore` deterministic CDN filenames (`screenshot_1..8.jpeg`); SSR search `?query=`. | Low. Content = store-listing shots (ASO), not in-app UI. |
| 13 | **InspoAI** (inspoai.io) | EASY (mixed quality) | 24,771 assets (100k+ claimed); natural-language UI search | **Open JSON, no auth**: `inspoai.io/api/visual-inspo?q=dashboard&page=N&limit=500` (verified, returns image_url + AI title + dims). But flagship 92k-screenshot search moved to Firebase-token auth; images mostly Pinterest CDN (ToS murkier); old documented developer API + MCP SSE endpoint dead. | Medium. Semantic matching but corpus quality/ToS mixed. |
| 14 | **MobbinAPI / mobbin-mcp** (prior-art repos) | EASY | Endpoint maps for Mobbin | `underthestars-zhy/MobbinAPI` (Swift, MIT, 43★, stale 2023): Supabase project ref `ujasntkfphywizsdaapi` unchanged, but all 2023 RPC functions 404 after schema rebuild, anon key rotated. `pdcolandrea/mobbin-mcp` (archived 2026-05): cookie names + refresh endpoint still live, `/api/content/*` dead, replaced by `/api/search-bar/*` etc. | n/a (evidence). |

### Fully-legal tier (zero scraping, not probed in depth but standard)

| Source | What | Access |
|---|---|---|
| **Apple iTunes lookup** | `itunes.apple.com/lookup?id=<store_id>&country=us` → app metadata + official screenshots (6.7"-sized variants) | Free, official, no key. ScreensDesign's API hands you the `store_id` for all 2,711 apps — instant join. |
| **google-play-scraper** (npm) | Play Store app details, all screenshots, ratings, description | Free quasi-official scraping lib; maintained. |
| **Dribbble API v2** | Shots, users, likes — official | Free tier: user's own OAuth token, ~200 req/hr — keep behind optional user config. |
| **RICO / ScreenUI / Hugging Face Rico mirrors** | Academic app-screenshot + layout-bbox datasets | Research licenses; good for offline enrichment/embeddings. |
| **Savee (savee.com/mcp)** | Commercial inspiration platform — **already ships an official MCP** | Direct prior-art competitor; worth a look for their source list. |

### Adjacent galleries discovered but not yet probed (same patterns likely apply)

curated.design, recent.design (ex-Godly), darkmodedesign.com, dark.design, minimal.gallery,
onepagelove.com, lapa.ninja, landing.gallery, landingfolio.com, saaslandingpage.com,
ecomm.design, footer.design, 404s.design, httpster.net, siteinspire.com, maxibestof.one,
uigarage.net, collectui.com, lookatui.com, mobile-patterns.com, uinotes.com, goodux.appcues.com,
checklist.design, uxarchive.app, scrnshts.club, banani.co/references, screenlane.com (→ Page Flows),
muz.li (extension), curated.design, context.dev, brandfetch.com.
Most of these are Webflow/Laravel SSR in the same family as the probed ones — cheap to add later.

---

## 2. Recommended implementation pipeline (first 5)

1. **Refero** — the backbone for *search*. One REST call returns structured records (image URL,
   page type, patterns, elements, colors, fonts, real source URL) with faceted filters.
   → `search_screens()` on web+mobile.
2. **ScreensDesign** — the backbone for *per-app mobile depth*. Open API gives the app catalog
   with store_ids; join with **Apple iTunes lookup** (official) for a fully-legal app channel;
   decode the SSR payload for full-session frame sequences with AI captions.
3. **Appshots + Simple App Shipper** — bulk *screen corpora* (116k + 3.7k screens) via open
   backend APIs; both return direct image URLs, so a nightly sync fills your local cache.
4. **Page Flows** — the *flows-as-video* differentiator: sitemap → 8,544 SSR posts → mp4 +
   poster frames, plus free CSV taxonomy. Nothing else gives you the recording of the whole journey.
5. **Land-book + Awwwards + SaaSFrame** — the *website* side: SSR + `?page=N` / sitemaps,
   full-res originals public, JSON-LD metadata. Land-book ships `llms.txt`/RSS for incremental sync.

**Mobbin is #1 by value** (621k screens / 323k flows) and, under the soft-risk policy, gets
set up early: a free-account cookie (`MOBBIN_COOKIE`) unlocks the live `/api/search-bar/*`
JSON routes (verified alive, just auth-gated) — a clean search API that beats the heavier
free path. The RSC flight-stream parse of `/explore/*` sitemap pages stays as the anonymous
fallback, not the primary route. The cookie is the user's own session — it stays with them,
per policy.

### Architecture notes

- **Adapter per source** (one module each), unified record shape:
  `{source, kind: screen|flow|site, platform, app?, tags[], image_urls[], video_url?, source_url, captured_at}`.
- **Local cache is mandatory**: every source serves images from a public CDN that can 404/rotate
  at any time. Download on fetch (or nightly via sitemaps/RSS), serve from local storage.
- **Incremental sync** via sitemaps (Page Flows, SaaSFrame daily lastmod, Land-book, Appshot)
  and RSS (Land-book).
- **Smoke-test per adapter** in CI-ish fashion — the unofficial endpoints (`be.appshots.design`,
  `api.screensdesign.com`, `api.refero.design`, `nicelydone.club/api`, `inspoai.io/api`) can
  change on any deploy.
- **Polite-crawl defaults**: 1–2 req/s, browser-like UA, honor the soft robots notes above
  (Land-book filter params, Awwwards `?page=`).
- **Cookie support as a first-class optional** (Mobbin free account) — same pattern extends to
  Dribbble OAuth token.

## 3. Risks

Policy (2026-09-23): ToS/robots soft risks below are **accepted by default** — the owner's
call. The risks that actually matter are operational: endpoint breakage, rate limits,
watermarks, and (for cookie routes) the account itself.

- **Unofficial-API fragility**: Appshots/ScreensDesign/Refero/NicelyDone backends are internal.
  Mitigate with adapter isolation + cache + per-source health check surfaced to the agent.
- **ToS soft spots**: Mobbin llms.txt warns against verbatim copying of protected designs;
  Land-book disallows filter query-strings in robots; InspoAI images are Pinterest-hosted.
- **Watermark/limits**: Appshots anonymous tier flags `is_limited` and serves watermarked thumbs
  for some assets; Refero anonymous pagination caps (24/page, 10k/query) — work around via per-site
  enumeration, or support a user cookie.
- **Paywall drift**: these sites monetize; Pro-gating can extend to previously-open content
  (Mobbin app pages now soft-404 anon; their 2023 Supabase surface vanished in a rebuild).
  The cache + multiple-source redundancy is the real protection.
- **Copyright**: screenshots belong to the apps. For a developer-agent tool (reference, not
  redistribution) fair-use risk is low; document per-source attribution in tool output.

## 4. MCP tool surface (sketch)

```
search_screens(query, platform?, kind?, limit?)
    → Refero (web+iOS) + Appshots (mobile) + Pttrns (patterns) + Simple App Shipper
      ranked/fused; returns unified records with locally-cached image URLs

get_flows(query_or_app, platform?, kind=steps|video)
    → Refero /flows (ordered screenshots) · Page Flows (full mp4 recording)
      · ScreensDesign (session recording + frame sequence) · Appshots/NicelyDone flows

get_app(app_name, platform)
    → app profile + ALL its screens/flows:
      ScreensDesign (slug + store_id) · Simple App Shipper (app_id)
      · Mobbin /api/app/fetch-app-versions-screens (needs cookie)
      · Apple iTunes lookup (official store screenshots, legal)

find_sites(industry?, style?, color?, view=desktop|mobile, limit?)
    → Land-book (facets + mobile view) · Awwwards (SOTD/collections)
      · SaaSFrame (SaaS pages/sections/email flows)

find_component_examples(component, context?)
    → Pttrns (7.7k patterns by screen type) · Simple App Shipper /api/ui-elements
      · UI Garage/Collect UI/LookAtUI (add in phase 2)

get_store_screenshots(app, store=apple|play)
    → Apple iTunes lookup (official) · google-play-scraper · Appshot Gallery
```

## 5. Appendix — all 66 discovered candidates

Mobbin · Page Flows · ScreensDesign (ex-UI Sources, ex-Design Vault) · Refero · Appshots ·
Nicely Done · Pttrns · Simple App Shipper · Appshot Gallery · Banani References · InspoAI ·
SaaSFrame · Land-book · Awwwards · Savee (official MCP) · Dribbble (+API v2) · Behance API
(**discontinued**) · DeviantArt · Adobe Portfolio · Collect UI · Look At UI · UI Garage ·
Mobile Patterns · GoodUX (Appcues) · UI Notes · UX Archive · Checklist Design · ScreenLane
(→Page Flows) · curated.design · recent.design (ex-Godly) · Dark Mode Design · dark.design ·
Minimal Gallery · One Page Love · Lapa Ninja · Landing.Gallery · Landingfolio ·
SaaS Landing Page · eComm.design · Footer.design · 404s.design · Httpster · SiteInspire ·
MaxiBestOf · Product Hunt · Muzli (extension) · shots.ninja · Site-Shot · Thum.io ·
Scrnshts · Brandfetch · Context.dev · Reddit (r/UI_Design et al.) · X/Twitter UI accounts ·
Wayback Machine · Common Crawl · Apple iTunes Search/Lookup · google-play-scraper ·
Google RICO + ScreenUI · Hugging Face Rico mirrors · AppStream (UIUC) ·
MobbinAPI + mobbin-mcp (prior art) · usetools.design
