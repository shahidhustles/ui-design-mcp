---
name: ui-design
description: Use the ui-design MCP when the task is about looking at or learning from real-world UI — improving an existing page by studying competitors, cloning or building an app from scratch, finding design references, or extracting design tokens (palettes, typography, patterns) from real products.
---

# ui-design — real-world design references

Seven tools backed by free design-reference backends (Refero: 74k+ web/iOS screens; ScreensDesign: 2,711 top-grossing iOS apps with full recorded sessions; Nicely Done: 13k+ curated onboarding flows; Simple App Shipper: 500 iOS apps + a component library; Apple iTunes: official store screenshots). No paid API keys.

| Tool | One-liner |
|---|---|
| `search` | **The entry point.** `type: "screens"` or `"apps"` — see below. |
| `get_app` | One app's full profile + complete ordered screen session (AI caption per screen) + 720p video + official store shots. iOS depth from ScreensDesign and Simple App Shipper. |
| `get_flows` | Named ordered user flows from Refero ("onboarding" → multi-step sequences). For a whole app session use `get_app`. |
| `get_onboarding` | Real product **onboarding flows** (Nicely Done): `app` (all of a product's flows), `category` ("signing-up", "onboarding", …), or `query`. Ordered step captures with pattern tags. |
| `find_components` | Component-level design examples (Simple App Shipper): buttons, cards, lists, charts, tabs, navigation bars — one captured screen per component, with a description. |
| `get_image` | One screenshot returned **as an inline image** — use this, never your Read tool, for full-res views (webp won't render in Read). |
| `list_sources` | Health + record counts + catalog progress. Run once at the start if anything looks off. |

## `search` — which type?

- **`type: "apps"`** → you need to *pick a product to study*. Returns name, rating, revenue, paywall type, downloads. Live name-substring search — "journal" finds Day One, Daylio, Reflectly… Use `query` (substring, shorter is better) and/or `category` ("Music", "Health & Fitness").
- **`type: "screens"`** → you need to *look at interfaces*. Returns per record: `colors[]` (hex palette), `fonts`, `tags` (page type / pattern / element facets), `imageUrls`, `cachedUrls` (local `file://` full-res), plus ≤8 inline thumbnails so you can actually see them. Use `query` + `platform` ("web"/"ios") and `tags` like `["dashboard"]`, `["landing page"]`, `["checkout"]`.

Rule of thumb: **apps first when cloning a product, screens first when styling a page.** They chain: `search apps → get_app → get_image`; `search screens → get_image`.

**Choosing between the three lookups:**
- `search {type:"screens"}` — generic "show me interfaces like X" (palettes, fonts, tags, any page type).
- `get_onboarding` — the task is specifically **onboarding / signup / first-run**: it's organized per product and per flow category, so it's sharper than a free-text search for that job.
- `find_components` — the task is a **single UI component** (a button, a tab bar, a chart): the only source with component-grain records.

## `get_onboarding` — how to use it (observed behavior, 2026-09-25)

Three selectors, in order of precision. The corpus is **web products** (SaaS onboarding — not mobile apps), so leave `platform` unset (passing `ios` filters everything out, since every record is `web`).

1. **`category: "<slug>"` — the deterministic one.** ~93 flow categories exist; the slug *is* the category. Verified-working slugs:
   - auth/account: `signing-up`, `sign-in`, `set-up-account`, `verify-identity`, `reset-password`, `set-up-multi-factor-authentication`
   - money: `upgrade-your-plan`, `set-up-payment-method`, `start-trial`, `request-early-access`
   - product intro: `onboarding`, `follow-product-tour`, `browse-guide`
   - content tasks (biggest categories): `create`, `edit`, `settings`, `add`, `delete`, `search`, `share`, `export`
   Slugs appear in every flow's `tags[]` — see a flow you like, copy its category slug, re-call with that `category` to browse the whole category.
2. **`query: "<keyword>"` — the fuzzy one.** Routed to the source's own search, so **specific task words** work well: `signup`, `login`, `pricing`, `upgrade`, `payment`, `checkout`. Typos are fine (`onbording` → Onboarding). **Avoid generic words** (`search`, `settings`, `create`) — they match everything and return huge ambiguous categories. Long phrases are weak: `verify email` matches *nothing*; the category slug (`verify-identity`) is the reliable route.
3. **`app: "<product name>"`** — every onboarding flow of one product (fuzzy name match). Best when you've already picked a reference product.

No selector → top of the catalog. Observed quirk: the search cross-matches near-synonyms (`"sign up"` can surface Signing-**in** flows first) — if the result's category isn't what you intended, read the flow's category tag and re-call with the right `category` slug.

Read the `notes` array in every result — it reports fallbacks (thin platform coverage → unfiltered results served, sharp unavailable, no matches → try shorter query). Trust notes before re-running the same call.

## Workflow A — "Improve our UI" (existing project, competitor study)

User has a product and wants UI/UX improved with evidence from competitors.

1. **Scope.** Identify the niche + the page types that matter (read the project first; ask only if the niche is genuinely ambiguous). If the user names competitors, use their names as `query`s.
2. **Gather references.** `search {type: "screens", query: "<niche term>", platform: "web", tags: ["<your page type>"]}`. Repeat 1–2 times with different angles (competitor name, pattern word like "pricing", "dashboard") — cheap.
3. **Study.** The response already carries palettes, fonts, tags and thumbnails. Pick the 3–5 records that fit the user's product, then `get_image {url: <imageUrl>, format: "png", maxDim: 1600}` for full-res study of the ones worth it.
4. **Pitch, in writing.** Write `DESIGN_RESEARCH.md` in the repo: (a) the extracted design tokens — 5–6 hex palette, typeface names, (b) 3–5 concrete layout/interaction patterns you learned (e.g. "sticky order summary on checkout", "skeleton cards while loading"), each with which reference demonstrates it, (c) what to change in *this* codebase to adopt them. Show the pitch to the user.
5. **Implement on approval**, in the project's existing stack and design-system conventions; re-check details against references with `get_image` when uncertain. Commit per coherent chunk.

## Workflow B — "Build me an app from scratch" (niche → studied clone in our design system)

User wants a new app in a niche; features and design should be learned from what already succeeds.

1. **Find the field.** `search {type: "apps", query: "<niche>", limit: 10}`. Read rating, revenue **and paywall type** — paywall tells you the monetization model that works in this space (subscription vs one-time vs free+IAP).
2. **Pick 2–3 winners** (high rating + real revenue + paywall model the user would accept). For each: `get_app {name}` → complete ordered session with an **AI caption on every screen** (`description_short`), 720p `videoUrl`, official App Store screenshots. First call ~15s, cached after.
3. **Extract features — two channels, both free:**
   - *Read the captions.* Each screen's caption + labels is effectively a feature list. Build a feature matrix: feature → which app/screen shows it → what it costs (free / paywall).
   - *Look at the pixels.* `get_image {url: <frame>, format: "png"}` on the 5–8 frames that matter (onboarding, home, core flow, stats, paywall). Screen-reading makes feature inference straightforward; captions make it near-certain.
4. **Persist the study.** Write `DESIGN_RESEARCH.md`: per-app feature matrix, the design language of the reference to adopt (palette, typography, spacing feel), monetization model, and a recommended build order. This file is what makes later iterations possible without re-browsing.
5. **Iterate in slices — never one-shot.** Suggested order: (1) design system + app shell, (2) onboarding, (3) the core loop, (4) secondary features, (5) paywall/metering. Each iteration: re-read `DESIGN_RESEARCH.md`, `get_image` 2–3 reference screens for *that slice only*, build it in **the user's own design system** (their tokens, their stack — the study informs *what* and *how it feels*, not pixel-clone), commit. A capable model carries 4–6 iterations comfortably; each slice is self-contained so a bad iteration is cheap to redo.

## Conventions

- **`get_image` for any full-res look** — ScreensDesign frames are webp; most Read tools can't render them. `format: "png"`, `maxDim` to taste (default 1600).
- **`cachedUrls` (file://) are local full-res files** — `get_image` serves them without network; fine offline.
- **Persist research as markdown in the repo** (`DESIGN_RESEARCH.md`) — both workflows span sessions; a re-browse is wasted calls.
- **`get_app` is iOS-only** (ScreensDesign + Simple App Shipper depth); `search screens` covers web + iOS via Refero. `get_onboarding` is a **web-product** corpus (Nicely Done) — onboarding for SaaS/web signups, not mobile app onboarding.
- **`find_components` records are platform-`unknown`** (the library doesn't say which OS each design targets) — don't hard-filter them by `platform`.
- **Phase 3 will add sources** (Mobbin, Page Flows, web galleries) — the workflows above don't change, only coverage grows.
