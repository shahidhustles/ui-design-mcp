# ui-design-mcp

Give coding agents real-world UI references — actual app screens, named user flows,
and full session recordings — from free design-reference backends. No API keys and
no paid MCP tier: Mobbin / Refero / ScreensDesign all sell official MCPs, but the
backends behind them are open.

## Sources

| source | provides | notes |
|---|---|---|
| **Refero** (`api.refero.design`) | 74k+ real web + iOS screens with page-type / pattern / element facets, color palettes, fonts; named ordered flows | anonymous tier works; in practice web-only — iOS queries fall back to unfiltered results with a note |
| **ScreensDesign** (`screensdesign.com`) | 2,711 top-grossing iOS apps: revenue, paywall type, per-screen AI captions, full 720p session recordings | per-app pages decoded lazily on first `get_app` and cached forever; `get_app` resolves the app via a single live name-search request, and the full catalog sync (for browse/category search) is resumable and runs only as a fallback |
| **Nicely Done** (`nicelydone.club`) | 13k+ curated web-product **onboarding flows**, per product and per flow category (12,784 flows across 669 products in the browse catalog) | powers `get_onboarding`; SSR pages decoded from the Nuxt `__NUXT_DATA__` payload; images at the public `900x484` transform; taxonomy endpoint is best-effort (observed intermittently empty) |
| **Simple App Shipper** (`simpleappshipper.com/library`) | 500 iOS apps (app + all screens in one call, `flow_index`-ordered) and a **component library** (buttons, cards, lists, charts, tabs, navigation bars) | powers `find_components` + extra `get_app` depth; 3,685 screens stay out of free-text `search` on purpose; PNG CDN no-auth |
| **Pttrns** (`app.pttrns.com`) | **7,754 iOS UI patterns**, every one attributed to its app: 100 queryable categories (screen types like login/signup/guided-tour, UI elements like button/card/checkout/empty-states, and business verticals like shopping/productivity) + per-app pages for ~1,000 apps (airbnb, target, …) | powers `find_components`'s category + app-name axes; no-auth SSR + one Jetboost category-filter call per query; screenshots on the public Webflow CDN with `-p-500` thumbnails |
| **Apple iTunes lookup** | official App Store screenshots for any `store_id` | the fully-legal join channel — called from `get_app` when the catalog row has a `store_id` |

## Tools

| tool | arguments | what you get |
|---|---|---|
| `search` | `type: "screens" \| "apps"` (required), `query?`, `platform?`, `tags?` (screens), `category?` (apps), `limit?` (default 10) | **the entry point — one tool, no "which search?" confusion.** `type "screens"`: unified screen records from every search-capable source, interleaved; `colors[]` hex, fonts, tags, `cachedUrls` (local `file://` full-res) + ≤8 inline base64 thumbnails. `type "apps"`: browse the per-app catalogs to **choose** an app before `get_app` — live ScreensDesign name search ("music" → 48 apps), category filter on the local catalog |
| `get_app` | `name`, `platform?` | one app's full profile (revenue, paywall, rating…), its complete ordered screen sequence with per-screen captions, 720p `videoUrl`, plus official App Store screenshots |
| `get_flows` | `query?`, `platform?`, `limit?` | named user flows (Refero) — ordered screenshot sequences; for a whole app session use `get_app` |
| `get_onboarding` | `app?`, `category?`, `query?`, `platform?`, `limit?` (default 6, max 20) | real product **onboarding flows** (Nicely Done) — ordered step captures with pattern tags. `app` = all of a product's flows, `category` = "signing-up" / "onboarding" / …, `query` = free text (the site's own search ranks the matching categories) |
| `find_components` | `component` (required), `platform?`, `limit?` (default 12, max 30) | **component-level + screen-type** design examples. Pttrns (iOS): real patterns by category ("login", "signup", "guided tour", "button", "empty states") **or by app name** ("airbnb") — with app attribution. Simple App Shipper (OS-agnostic): the widget library — buttons, cards, lists, charts, tabs, navigation bars |
| `get_image` | `url`, `format?` (auto/png/jpeg), `maxDim?` (default 1600) | one screenshot returned **as an inline image block** — no local Read needed, webp/webm/avif work as bytes; `format` transcodes (webp→png), `maxDim` downscales |
| `save_references` | `projectRoot` (absolute), `folder?` (default `references/ui`), `items` (`{url,title?}[]`, 1–30) | saves only the AI's chosen screenshots or video into the project; accepts media URLs and `file://` cached images, keeps item order in filenames, and reports saved absolute paths plus per-item failures |
| `list_sources` | — | live health of every adapter (1 cheap request each), capabilities, local record counts, catalog progress, cache dir |

## MCP Apps gallery

The six media tools (`search`, `get_app`, `get_flows`, `get_onboarding`,
`find_components`, `get_image`) advertise the
[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) extension
(`io.modelcontextprotocol/ui`): each tool carries `_meta.ui.resourceUri`
pointing at `ui://ui-design/gallery.html`, a single-file vanilla-JS app served
by the server. Hosts that support MCP Apps render it in a sandboxed iframe
next to the conversation. The tool result is returned without a user action.
The app shows its screenshots, video, and text in a compact scrollable gallery:

- Scroll through the returned screens and flow steps. Video controls appear
  when the result includes a video URL.
- Expand **Tool payload** to inspect the returned text, structured data, and
  inline image blocks. The host controls how it presents these to the model.
- Open a card for a larger view, or open its source page (`ui/open-link`).

When the user asks to keep particular references, the AI calls
`save_references` with the relevant URLs and the app repository's absolute
path. For example, it can save the ordered steps returned by `get_onboarding`
under `references/onboarding`. The gallery does not write project files.

The app speaks the spec `2026-01-26` bridge (JSON-RPC over postMessage):
`ui/initialize` handshake, `ui/notifications/tool-input` / `tool-result`,
`tools/call` for image previews, `ui/open-link`, host theming via
`hostContext.styles` CSS variables, and a CSP allowlist declared on the
resource for the direct-URL image/video fallback.

**Client support** (official matrix,
[modelcontextprotocol.io/extensions/client-matrix](https://modelcontextprotocol.io/extensions/client-matrix)):
Claude (web + Desktop), ChatGPT (incl. Codex in the ChatGPT app — the same
in-conversation rendering Higgsfield's MCP uses), Cursor, VS Code Copilot,
Microsoft 365 Copilot, Goose, Postman, MCPJam, Archestra.AI, PostHog Code.
Hosts without the extension ignore `_meta.ui` entirely — every tool result
still carries `structuredContent` plus ≤8 inline base64 image blocks, so the
model (and any plain client) keeps working. Test a local server with the
official basic-host: `git clone https://github.com/modelcontextprotocol/ext-apps
&& cd ext-apps/examples/basic-host && npm i && SERVERS='["http://localhost:3001/mcp"]' npm start`.

## Install

```sh
git clone <this repo> && cd ui-design-mcp
npm install
npm run build
```

Point any MCP client at the built server:

```json
{
  "mcpServers": {
    "ui-design": {
      "command": "node",
      "args": ["/path/to/ui-design-mcp/dist/index.js"],
      "env": { "UIMCP_CACHE_DIR": "/path/to/cache" }
    }
  }
}
```

Or for Claude Code: `claude mcp add ui-design -- node /path/to/ui-design-mcp/dist/index.js`

Dev mode (no build): `npm run dev` runs the server via `tsx`.

## Skill

A packaged agent skill ships in `.agents/skills/ui-design/` — a playbook for
driving this MCP: when to reach for each tool, the working `get_onboarding`
category slugs and `find_components` vocabulary, and the two end-to-end workflows
(improve an existing UI; build an app from a studied clone). It's model-invoked
and uses progressive disclosure — `SKILL.md` stays lean, `reference/` files load
only when that tool is in play.

Install it alongside the server for any Agent-Skills harness:

- **Claude Code** — symlinked into `.claude/skills/` in this repo (or copy the folder).
- **Command Code** — copy or symlink into `~/.commandcode/skills/` (global) or the project's `.agents/skills/`.

## Environment

| variable | default | meaning |
|---|---|---|
| `UIMCP_CACHE_DIR` | `./data` | root for the sqlite metadata DB and the on-disk image cache |
| `UIMCP_RATE_LIMIT_MS` | `500` | minimum spacing between requests per source |
| `UIMCP_MAX_RESULTS` | `24` | result cap applied on top of per-tool limits |
| `UIMCP_TIMEOUT_MS` | `15000` | per-request timeout |
| `UIMCP_RETRY_BASE_MS` | `500` | retry backoff base (attempt N waits base·2ᴺ, jittered) |
| `UIMCP_FAKE_OFFLINE` | — | `1`/`true` throws before any network request (cache-hit tests) |
| `UIMCP_CATALOG_TTL_DAYS` | `7` | ScreensDesign catalog staleness before re-sync |
| `UIMCP_FACET_TTL_DAYS` | `7` | Refero facet dictionary staleness before refresh |

## What gets cached

```
data/
├── meta.sqlite              # catalog rows, facet dictionaries, decoded app pages,
│                            # record counts, source health (WAL, node:sqlite)
└── cache/<source>/          # images, content-addressed by sha1(url)
    └── <sha1>.jpg|png|webp  # full-res (cachedUrls) and thumbnails (inline blocks)
```

Everything is a cache: a cold server still answers, it just makes network calls;
a warm one answers from disk.

## Caveats

- **First `get_app` can be slow.** The one-time ScreensDesign catalog sync
  (2,711 apps) runs on the first per-app call if the catalog is stale. The API
  throttles in ~30-request bursts followed by a ~11-minute `retry-after` window,
  and degrades per-page size under load — a cold sync typically takes 30–60
  minutes wall-clock. It is idempotent, resumes from where it stopped, and is
  re-run only after the catalog TTL expires.
- **Refero anonymous tier is web-only in practice.** `search(type: "screens",
  platform: "ios")` returns web results with a note when iOS coverage is thin.
- **Response size is bounded.** ≤8 base64 thumbnail blocks per tool response;
  full-res images stay on disk and are referenced via `cachedUrls`.
- **A failing source never crashes the server** — it surfaces in the `notes`
  array of the result.

## Development

```sh
npm test                     # unit: decoder, mappers, http retries, sqlite, image cache, MCP Apps UI resource
npm run verify -- all        # live §8 verification (see scripts/verify.ts for subcommands)
npm run dev                  # run the stdio server
```

`scripts/verify.ts` is a dependency-free NDJSON MCP client that spawns the real
server and runs the PLAN.md §8 assertions — 10 subcommands: `list-sources`,
`search-checkout`, `search-dashboard`, `get-app-spotify`, `get-flows-onboarding`,
`offline-cache`, `search-apps`, `get-image`, `get-onboarding`, `search-components`
(`npm run verify -- all` or one at a time; `help` lists them).
