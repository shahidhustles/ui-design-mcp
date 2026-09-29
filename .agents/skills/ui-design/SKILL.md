---
name: ui-design
description: Real-world UI references via the ui-design MCP. Search product screens, study recorded app sessions and onboarding flows, find component patterns, and save chosen images or videos into a project reference folder when the user asks to keep them.
---

# ui-design — real-world design references

Eight tools on the `ui-design` MCP server, backed by free design-reference sources: 74k+ web/iOS screens (Refero), 2,700 top-grossing iOS apps with recorded sessions (ScreensDesign), 12k+ curated onboarding flows (Nicely Done), 500 apps plus a component library (Simple App Shipper), 7,700 iOS UI patterns (Pttrns), and official App Store screenshots (Apple iTunes). No API keys.

Call tools as `ui-design:<tool>` (e.g. `ui-design:search`).

**Every result carries a `notes[]` array** reporting fallbacks, thin coverage, and failures — a dead source never crashes the call. Read `notes` before re-running a call; it usually explains why a result is thin and what to try next.

## The tools

| tool | what you get | key args |
|---|---|---|
| `ui-design:search` | **Entry point.** `type:"screens"` → real UI screens with palettes, fonts, tags, inline thumbnails. `type:"apps"` → app catalogs for picking one (rating, revenue, paywall). | `type` (req), `query`; `platform`/`tags` (screens) or `category` (apps) |
| `ui-design:get_app` | One app's full profile + its complete ordered session, an AI caption on every screen, 720p video, store screenshots. | `name` (req) |
| `ui-design:get_onboarding` | A product's real onboarding flows — ordered step captures with pattern tags. | `app` / `category` / `query` (one), `limit` |
| `ui-design:find_components` | Component + screen-type patterns (iOS, by category or app name) and an OS-agnostic widget library. | `component` (req), `limit` |
| `ui-design:get_flows` | Named multi-step user flows (Refero) as ordered screenshot sequences. | `query` (req), `limit` |
| `ui-design:get_image` | One screenshot as an inline full-res image; transcodes webp, downscales. | `url` (req), `format?`, `maxDim?` |
| `ui-design:save_references` | Save chosen images or videos in the project, with ordered filenames and absolute paths in the result. | `projectRoot` (req), `folder?`, `items` (req) |
| `ui-design:list_sources` | Health + record counts + catalog progress of every source. | — |

## Pick the tool

Match the task to one lookup first:

- **Choose a product to study → `ui-design:search {type:"apps"}`.** Live substring name search — a short query beats a phrase ("journal" surfaces Day One, Daylio, Reflectly). Also filter by `category` ("Music", "Health & Fitness").
- **Style or study interfaces → `ui-design:search {type:"screens"}`.** "Show me interfaces like X." Returns palettes, fonts, tags, and inline thumbnails for every screen.
- **The job is specifically onboarding / signup / first-run → `ui-design:get_onboarding`.** It's organized per product and per flow category, so it beats free-text search for that job. Selectors and working category slugs: [reference/get-onboarding.md](reference/get-onboarding.md).
- **A single UI component, or how native apps do a screen type → `ui-design:find_components`.** A button, tab bar, chart — or "how do iOS apps do login / empty states." What to pass: [reference/find-components.md](reference/find-components.md).
- **A whole app's recorded session → `ui-design:get_app`** once you've picked the app via `search {type:"apps"}`.
- **A named multi-step sequence → `ui-design:get_flows`** (e.g. "signing up" as ordered screenshots).
- **A close look at any screen → `ui-design:get_image`.** Use this for full-res, not a Read tool — it transcodes webp/webm/avif and downscales.
- **Keep references in the project → `ui-design:save_references`.** When the user asks to save a flow, screenshots, or video, choose only the relevant media from the tool result. Pass the current project's absolute root and a relative folder such as `references/onboarding`. Use each screen's `cachedUrls[0]` or `imageUrls[0]`, plus `videoUrl` when requested. Keep the `items` array in flow order. Report the saved paths and any failures. The user does not need to select cards in the gallery.

Rule of thumb: **apps first when cloning a product, screens first when styling a page.** The chains run `search apps → get_app → get_image` and `search screens → get_image`.

## Workflow A — improve an existing UI (competitor study)

The user has a product and wants evidence-based UI/UX improvement.

1. **Scope.** Read the project first to fix the niche and the page types that matter; ask only if the niche is genuinely ambiguous. If the user names competitors, use their names as `query`s.
2. **Gather references.** `ui-design:search {type:"screens", query:"<niche term>", platform:"web", tags:["<your page type>"]}`. Repeat once or twice from other angles (a competitor name, a pattern word like "pricing" or "dashboard") — it's cheap.
3. **Study.** The response already has palettes, fonts, tags, and thumbnails. Pick the 3–5 screens that fit, then `ui-design:get_image {url:<imageUrl>, format:"png", maxDim:1600}` on the ones worth a close look.
4. **Pitch it in writing.** Write `DESIGN_RESEARCH.md` in the repo with (a) extracted design tokens — a 5–6 hex palette and the typeface names, (b) 3–5 concrete layout/interaction patterns you learned, each tied to the reference that shows it, and (c) what to change in *this* codebase to adopt them. Show the user.
5. **Implement on approval** in the project's existing stack and design-system conventions; re-check details with `ui-design:get_image` when unsure. Commit per coherent chunk.

*Done when:* `DESIGN_RESEARCH.md` exists with real extracted tokens and named patterns, and the user has approved or rejected the proposed changes.

## Workflow B — build an app from scratch (niche → studied clone)

The user wants a new app in a niche; features and design come from what already succeeds.

1. **Find the field.** `ui-design:search {type:"apps", query:"<niche>", limit:10}`. Read rating, revenue, **and paywall type** — the paywall reveals the monetization model that works here (subscription vs one-time vs free+IAP).
2. **Pick 2–3 winners** (high rating + real revenue + a paywall model the user accepts). For each, `ui-design:get_app {name}` → the complete ordered session with a caption on every screen, a 720p `videoUrl`, and store screenshots. First call per app is ~15s, cached after.
3. **Extract features — two channels, both free:**
   - *Read the captions.* Each screen caption and label is effectively a feature list. Build a matrix: feature → which app/screen shows it → what it costs (free / paywall).
   - *Read the pixels.* `ui-design:get_image {url:<frame>, format:"png"}` on the 5–8 frames that matter (onboarding, home, core flow, stats, paywall). Captions make feature inference near-certain.
4. **Persist the study.** Write `DESIGN_RESEARCH.md`: the per-app feature matrix, the design language to adopt (palette, typography, spacing feel), the monetization model, and a recommended build order. This file is what lets later iterations skip the re-browse.
5. **Iterate in slices — never one-shot.** Order: (1) design system + app shell, (2) onboarding, (3) the core loop, (4) secondary features, (5) paywall/metering. Each slice: re-read `DESIGN_RESEARCH.md`, `ui-design:get_image` 2–3 reference screens for *that slice only*, build it in **the user's own design system** — their tokens and stack; the study informs *what* to build and *how it feels*, not a pixel clone. Commit per slice. A bad slice is cheap to redo.

*Done when:* the app is built in the user's own design system across committed slices, and `DESIGN_RESEARCH.md` documents the study that drove it.

## Conventions

- **Full-res looks go through `ui-design:get_image`.** Most Read tools can't render webp. `format:"png"`; `maxDim` to taste (default 1600). `cachedUrls` are local `file://` full-res files, so `get_image` serves them with no network.
- **Persist research as `DESIGN_RESEARCH.md`** in the repo — both workflows span sessions, and a re-browse is wasted calls.
- **Platform coverage is uneven; `notes` tells you where.** `get_app` is iOS-only (ScreensDesign + Simple App Shipper depth). `search {type:"screens"}` covers web + iOS via Refero, but the anonymous Refero tier is web-only in practice — an iOS screen search may return web screens with a note. `get_onboarding` is a **web-product** corpus (SaaS signups, not mobile onboarding) — leave `platform` unset. `find_components` mixes iOS (Pttrns) and OS-agnostic (Simple App Shipper) records — omit `platform` unless you specifically want native patterns.
- **Sources still being added** (Mobbin, Page Flows, web galleries) — these workflows stay stable; only coverage grows.
