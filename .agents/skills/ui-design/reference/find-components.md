# find_components — what to pass for `component`

One `component` string, matched against two fused sources: Pttrns patterns (`platform:"ios"`, real iOS UI, each attributed to its app) and the Simple App Shipper widget library (`platform:"unknown"`, OS-agnostic). Inlines at most 4 thumbnails; `ui-design:get_image` serves the rest at full res.

The word can match three things:

## 1. Category words (Pttrns, iOS)

~100 categories, matched case-insensitively on slug or title. Working words, by group:

- **screen types** — `login`, `signup`, `setup`, `guided-tour`, `launch-screen`, `checkout`, `purchase`, `home`, `settings`, `profile-account`, `empty-states`, `search`, `share`
- **UI elements** — `button`, `card`, `chart`, `banner`, `dialog`, `sheet-bottom`, `bottom-bar`, `side-nav`, `navigation`, `progress`, `loading-bar`, `spinner`
- **business verticals** — `shopping`, `productivity`, `health-fitness`, `finance`, `food-drink`, `music`, `news`, `sports`

Near-synonyms resolve: `onboarding` → guided tour, `sign up` → signup, `tab bar` → bottom bar.

Results are the category's patterns **newest-first, each attributed to its app** (name and icon in `app`; the category labels and app name in `tags[]`). Newest-first means one recently-uploading app can dominate the top of a category (e.g. "login" led by one app's screen batch) — raise `limit` (max 30) when you want cross-app variety.

## 2. App names (Pttrns, iOS)

Any of the ~1,000 catalog apps: `airbnb`, `target`, `loom`, … returns that app's patterns in site order. Best after you've picked a reference app.

## 3. Widget-library words (Simple App Shipper, OS-agnostic)

`button`, `card`, `list`, `chart`, `tab`, navigation bars. Example-level matching works too — `donut` → the donut chart example.

**Empty result plus a note** → the word matched neither a category nor an app. Try the closest category word, or an app name.

For "how does app X handle onboarding": prefer `ui-design:get_onboarding` (web products), or `ui-design:find_components` with a `guided-tour` category (iOS apps).
