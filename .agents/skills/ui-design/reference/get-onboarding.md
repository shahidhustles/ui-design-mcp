# get_onboarding — selectors and category slugs

The corpus is **web products** (SaaS onboarding, not mobile apps), so leave `platform` unset — every record is `web`. Pick one selector; the order below is precision-first.

## 1. `category` — the deterministic route

~93 flow categories; the slug *is* the category, and it appears in every flow's `tags[]`. See a flow you like, copy its category slug, and re-call with that `category` to browse the whole category.

Working slugs, by group:

- **auth / account** — `signing-up`, `sign-in`, `set-up-account`, `verify-identity`, `reset-password`, `set-up-multi-factor-authentication`
- **money / plans** — `upgrade-your-plan`, `set-up-payment-method`, `start-trial`, `request-early-access`
- **product intro** — `onboarding`, `follow-product-tour`, `browse-guide`
- **content tasks** (the largest categories) — `create`, `edit`, `settings`, `add`, `delete`, `search`, `share`, `export`

## 2. `query` — the fuzzy route

Routed to the source's own search, so **specific task words** work well: `signup`, `login`, `pricing`, `upgrade`, `payment`, `checkout`. Typos are tolerated.

- Avoid generic words (`search`, `settings`, `create`) — they match everything and return huge ambiguous sets.
- Long phrases are weak: `verify email` matches nothing, but the category slug `verify-identity` is the reliable route.

## 3. `app` — one product

Every onboarding flow of a product (fuzzy name match). Best once you've already picked a reference product.

No selector → top of the catalog.

**Observed quirk:** search cross-matches near-synonyms — `"sign up"` can surface Signing-**in** flows first. If a returned flow's category tag isn't what you intended, read it and re-call with the right `category` slug.

Step images are 900px; use `ui-design:get_image` for more.
