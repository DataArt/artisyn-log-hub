---
type: "Reference"
title: "User Docs and Site (user-docs/, in-app help, GitHub Pages)"
description: "The one user-documentation page set in user-docs/ and its nav.json, the link rules shared by every consumer (scripts/user-docs/links.js), the generator that writes the in-app help into client/public/help/ and every build path that runs it, the static site renderer (scripts/site/) and its output (head/OG tags, canonical URLs, sitemap.xml, 404.html, favicon and og-image), the example dataset placeholders, the reveal.js deck, the pages.yml deploy workflow and the one-time owner step."
tags:
  - docs
  - client
  - build
  - site
timestamp: "2026-11-03T00:00:00+04:00"
---

# User Docs and Site

All user documentation is written once, in `user-docs/` at the repository root (plus two hook
files). Three consumers read it:

| Consumer | How it gets the pages |
|---|---|
| In-app help (`HelpModal`) | `client/public/help/<slug>.md`, **generated** by `scripts/user-docs/generate-help.js`, fetched at runtime from `/help/<slug>.md`; the menu imports `user-docs/nav.json` |
| GitHub (repository browser) | the files themselves — every link is a real relative path, so it works there |
| Site (GitHub Pages) | `docs/<slug>.html`, pre-rendered by `scripts/site/build-site.mjs` |

Never edit `client/public/help/` — it is gitignored output and is rewritten on every build.

## Page set and `nav.json`

`user-docs/nav.json` is a JSON array of
`{ "section": string, "articles": [{ "slug", "title", "description", "downloadable"?: true, "source"?: string }] }`
— the client's `HelpSection[]` type plus the optional `source`. A page's file is
`user-docs/<slug>.md`, or `user-docs/` + `source` when `source` is set. The order of the array is
the order of the help menu and of the site sidebar.

- `description` is **required by the site build** and **ignored by the in-app help**: it becomes the
  page's `<meta name="description">` and `og:description`. Plain English (no Markdown, e-mail or
  path) saying what the page helps the reader do; 50–160 characters (`.length` of the raw string),
  unique across the site (the Home/Features/Questions descriptions in `build-site.mjs` and the
  deck's own meta included). A missing, out-of-range or duplicate description fails the site build
  (`user-docs/nav.json: <slug>: description …`). `loadNav` passes it through; it is typed as
  `description?: string` in `links.d.ts` (`NavArticle`, `NavPage`) and in the client `HelpArticle`
  (type mirror only — the client bundles `nav.json`, so the strings ride along unused).

| Section | Pages (slug) |
|---|---|
| Get started | `install-server`, `install-hook` (source `../hook/INSTALL_HOOK.md`), `getting-started` ("Your first session"), `connect-repository` |
| Configuration | `authentication-modes`, `server-configuration`, `tuning-your-setup`, `otel-admin-guide`, `security-hardening` |
| Using Log Hub | `all-views`, `session-list`, `session-log`, `cost-and-context`, `analytics-reports`, `otel-tab`, `otel-architecture` |
| Data and security | `data-collection-notice`, `data-collection`, `trust-model`, `component-reference`, `responsibility-matrix`, `third-party-components`, `how-hook-works` (source `../hook/HOW_HOOK_WORKS.md`) |
| Changelog | `changelog` |

- `downloadable: true` adds the "Download .md" button in the app; the downloaded file is the
  generated copy, named `artisyn-log-hub-<slug>.md`.
- The two hook pages keep their own H1s; the nav title may differ by design. Hook files are edited
  only as part of the hook (`hook/` is the source of truth), never to suit the site.
- **One text, one place.** `authentication-modes.md` owns the auth-mode text, the hook's
  `INSTALL_HOOK.md` owns the install steps, `data-collection.md#what-is-collected` owns the
  collected-data list; other pages link to them instead of repeating them. Numbered headings of
  `security-hardening.md` (`3.6`, `§11`, …) are referenced from tests and KB — do not renumber.
- `data-collection-notice.md` is also the consent text: its content hash
  (`client/src/viewer/lib/notice-hash.ts`) versions the consent, so any edit re-asks every user once.
  It has no page links, so the generator copies it byte-for-byte.
- `README.md` carries only a pitch, a quick start and links into `user-docs/`; long text belongs in
  a page.

Adding a page: create `user-docs/<slug>.md`, add it to `nav.json`, run `npm run build:help`. The
help menu, the site sidebar and the registry tour pick it up from the nav.

## Link rules (`scripts/user-docs/links.js`)

Pure CommonJS, Node built-ins only, shared by the help generator, the site renderer and the
tests (`tests/scenarios/helpers/help-nav.ts`); typed for TypeScript callers by the hand-written
`links.d.ts`. Algorithm doc: `docs/knowledgebase/algorithms/user-docs-links.md`.

Write links as **real relative file paths**: between pages `slug.md` or `slug.md#anchor`; from a
`user-docs/` page to a hook page `../hook/INSTALL_HOOK.md` / `../hook/HOW_HOOK_WORKS.md`.

- `loadNav(repoRoot)` → `{ sections, pages: [{ slug, title, downloadable, section, file }] }`.
- `resolveLink(href, fromFile, nav)` → `external` (`http:`/`https:`/`mailto:`), `anchor` (`#x`),
  `page` `{ slug, anchor }` when the path resolved against the linking file equals a page's file
  (case-sensitive, `/` separators), otherwise `unresolved` — e.g. `../server/README.md`, an image
  or a missing page.
- `findLinks(markdown)` → inline and reference-style hrefs, skipping fenced and inline code.
- `rewritePageLinks(markdown, fromFile, nav)` → every `page` link becomes `<slug>.md[#anchor]`;
  all other bytes unchanged.

An `unresolved` link fails the help generator and the site build. Anchors are not validated at
build time; the app ignores a missing anchor and opens the page at the top. Heading ids are
GitHub-style (`rehype-slug` / github-slugger) in the app, on the site and on GitHub alike.

## Help generator and its build paths

`node scripts/user-docs/generate-help.js [--out <dir>] [--check]` (CJS, sync, built-ins only).
Validates every page's links (prints `<file>: <href>` and exits 1 on any `unresolved`), writes
`<out>/<slug>.md` = `rewritePageLinks(text)`, deletes stale `*.md` in `<out>` that are not in the
nav. Default `--out` is `client/public/help`; `--out` must be a dedicated folder inside the
repository (not `user-docs/` or `hook/`). `--check` validates and writes nothing. Idempotent. The
repository root is found as `path.join(__dirname, '..', '..')`.

It runs on every path that builds the client:

| Path | Where |
|---|---|
| `bun run dev` / `bun run build` | client `predev` / `prebuild` scripts |
| `npm run build` | `scripts/build.js`, the `build:help` step after `build:clean`, before the parallel block |
| `npm run build:serial` | `npm run build:help` before `build:client` |
| Docker image | client-build stage copies `user-docs/`, the two hook docs and `scripts/user-docs/` before `client/`; the client `prebuild` generates |
| Scenario stand | `scripts/scenarios/build-stand.mjs` runs the generator explicitly before `vite build` |
| CI (`checks.yml`) | `generate-help.js --check` and `npm run build:site -- --out tmp/site-check`, so a broken link or dataset fails the PR |

`npm run build:help` and `npm run build:site` are build steps, not health checks — they are not in
`repo-health-checks.json` (the CLAUDE.md command table lists them as build steps).

## In-app help

`client/src/viewer/help/articles/index.ts` imports `@loghub/user-docs/nav.json` (a Vite/tsconfig
alias, see [repo-local-packages.md](repo-local-packages.md)) and exports it as `helpNav`.
`HelpModal` opens on `getting-started`; links are handled by `HelpMarkdownLink.tsx` /
`help-links.ts` (in-pane anchor scroll, page switch with optional anchor, `console.warn` on an
unknown page, external links in a new tab with ` ↗`). Details:
[client-routing-and-layout.md](client-routing-and-layout.md#helpmodal-helphelpmodaltsx). The app
shows `{{RETENTION_DAYS}}` as written; only the consent screen substitutes it.

## Site renderer and output

`npm run build:site` = `node scripts/site/build-site.mjs [--out <dir>]` (default `tmp/site`,
gitignored via `tmp`). ESM `.mjs` because unified/remark are ESM-only; otherwise sync I/O and
explicit exit codes (0 written, 1 validation/build failure, 2 bad arguments or refused `--out`).
`--out` must be inside the repository and not its root; an existing folder is emptied only when it
carries the script's marker file `.loghub-site-output` (or is empty).

Pipeline: `unified` + `remark-parse` + `remark-gfm` + `remark-rehype` + `rehype-slug` +
`rehype-stringify` (root devDependencies; no `rehype-raw`, raw HTML is not rendered). Steps:
validate links (exit 1 on `unresolved`), rewrite page links to `<slug>.html#anchor`, build the
"On this page" TOC from h2/h3 (shown with ≥ 3 entries), replace `{{RETENTION_DAYS}}` with "the
retention period configured on your server (default 30 days)", fill dataset and site placeholders
in Home/Features/deck, wrap with `scripts/site/layout.mjs`, copy assets.

**Diagrams.** A fenced block whose info string carries `diagram=<name>` (e.g.
```` ```text diagram=architecture ```` in `component-reference.md`) becomes a Mermaid figure from
`site/diagrams/<name>.mmd` on the site, with the original ASCII block kept under a "Text version"
`<details>` (open until the diagram renders). The in-app help and GitHub ignore the meta and show
the ASCII block. A missing `.mmd` fails the build. Only pages with a diagram load Mermaid 12.2.0
from jsDelivr (pinned, SRI) and `assets/diagrams.js`, which themes it from the CSS tokens.

**Images.** A page may show an image kept in `user-docs/images/` (lowercase name, `.svg` or `.png`,
no subfolder), linked as `![alt](images/<name>)`. `resolveLink` returns `{kind:'asset'}` for it
(rule 6 of `algorithms/user-docs-links.md`); any other image path is `unresolved` and fails both
builds, as does a missing file. `generate-help.js` copies the linked images to
`client/public/help/images/` (stale ones there are removed) and `HelpModal` renders only
`images/<name>` sources, from `/help/images/` — never a remote `src`, so the help stays offline.
`build-site.mjs` copies them to `docs/images/`. First used by `otel-architecture.md` (two OTEL tab
wireframes).

| Input | Output |
|---|---|
| `site/pages/home.html`, `features.html`, `questions.html` (body fragments) | `index.html`, `features.html`, `questions.html` (security-lead FAQ, each answer links its source doc) |
| every `nav.json` page | `docs/<slug>.html` (sidebar, content, TOC, prev/next) |
| `site/deck/` | `deck/` (standalone, no site nav) |
| `site/assets/` (`theme.css` shared by site and deck, `site.js` menu toggle, `diagrams.js`, `carousel.js` home media carousel, `shots/*.png`, `demo/` carousel media + `items.json`) | `assets/` (copied as-is; `demo/` is committed output of the manual `npm run record:demo`, never generated by `build:site`) |
| `site/assets/favicon.svg` | `assets/favicon.svg` — `<link rel="icon">` of every page; byte-identical committed copy of `client/public/favicon.svg` (the source of truth; Pages does not build `client/`). Missing → build fails |
| `site/assets/apple-touch-icon.png` (180×180) | `assets/apple-touch-icon.png` — `<link rel="apple-touch-icon">` |
| `site/assets/og-image.png` (1200×630) | `assets/og-image.png` — `og:image` of every indexable page and the deck |
| `site/pages/404.html` (body fragment) | `404.html` — GitHub Pages serves it for a miss at any depth; `noindex`, not in the sitemap |
| every built `.html` except `404.html` | `sitemap.xml` — `sitemapXml(urls)`: sorted `<url><loc>` entries (canonical URLs, no `lastmod`/`changefreq`/`priority`); a URL not under `SITE_URL` fails the build |

- Every link in the output is relative (`../`-aware per depth); nothing depends on the
  `/artisyn-log-hub/` base path — **except `404.html`**: `page({ notFound: true })` uses `SITE_URL`
  as the prefix instead of `prefixFor(depth)`, so its nav, footer, stylesheet, script and icon URLs
  are absolute (Pages serves it from whatever nested URL missed). No external fonts; the only
  external scripts are Mermaid on diagram pages and reveal.js in the deck, both pinned with SRI.
- **Canonical URL** — `canonicalUrl(outPath)` in `layout.mjs`: `\` → `/`, then `index.html` →
  `SITE_URL`, a path ending in `/index.html` → `SITE_URL + <dir>/` (`deck/index.html` →
  `…/deck/`), anything else → `SITE_URL + outPath`. `<link rel="canonical">`, `og:url` and the
  sitemap all use it. The build passes `page()` a POSIX `path` (`index.html`, `features.html`,
  `docs/<slug>.html`, …) and a `description`.
- **Head tags** — every indexable page, after `<title>`: `meta description`, `link canonical`,
  `og:type` (`website`), `og:site_name` (`SITE_NAME`), `og:title` (= `<title>`), `og:description`,
  `og:url` (= canonical), `og:image` / `og:image:width` / `og:image:height` / `og:image:alt`
  (`OG_IMAGE_URL`, `OG_IMAGE_WIDTH` 1200, `OG_IMAGE_HEIGHT` 630, `OG_IMAGE_ALT`, exported by
  `layout.mjs`), `twitter:card` `summary_large_image`, `link rel="icon"` (`assets/favicon.svg`,
  `image/svg+xml`) and `link rel="apple-touch-icon"`. The 404 page gets only `robots noindex` and
  the two icon links (absolute). The deck's `<head>` is hand-written with the same set (icons
  `../assets/…`, absolute URLs via `{{site:url}}`, canonical `{{site:url}}deck/`); the build reads
  its `<title>`/`<meta name="description">` after filling placeholders and validates the
  description with the others. If you change an `OG_IMAGE_*` value, change the deck and the
  `@S-SITE-01` constants too.
- **Regenerating the PNGs** (one-off manual renders, no committed script):
  - `apple-touch-icon.png`: with Playwright MCP (`use-playwright` skill), a 180×180 viewport whose
    page is `client/public/favicon.svg` inline at `width`/`height` 180 on the SVG's own background;
    screenshot to `site/assets/apple-touch-icon.png`.
  - `og-image.png`: the repository OTEL tab's team-context Sankey (`OtelCostFlow.tsx`, model → user
    → branch) in the dev app, with the demo repository exported from local prod and imported via
    Settings › Import/Export (the repository must belong to a team so the tab opens with
    `teamId`). Before loading the tab, `page.route('**/api/v1/repositories/*/otel/facts?**')`
    fetches the real response and maps each distinct non-null `userEmail` in `flows[]` and
    `sessions[]` to `Developer A`, `Developer B`, … (first appearance), so no e-mail reaches the
    image; branch names must carry no person's name. Viewport 1200×630, clipped to the Sankey card,
    ≥ 3 framings in `tmp/site-shots/`, pick one. Never invent data.
  - Check both with an IHDR size read (bytes 16–23) — `@S-SITE-01` step 17 asserts 1200×630 and
    180×180, and that the output favicon equals `client/public/favicon.svg` byte-for-byte.
- `layout.mjs` exports `SITE_URL` (`https://dataart.github.io/artisyn-log-hub/`), `REPO_URL`,
  `RELEASES_URL`, filled into `{{site:url}}`, `{{site:repo}}`, `{{site:releases}}`. Top nav: Home,
  Features, Get started, Configuration, Using Log Hub, Data & security, Questions, Deck, GitHub ↗; a section
  link opens that section's first page. Changelog is in the sidebar and footer only.
- Style: "old digital" — warm paper / near-black palette, muted phosphor green and amber, monospace
  headings, nav, labels and numbers, a faint grid background, square corners; no neon or glow.
  Light/dark palette from `prefers-color-scheme`; sidebar collapses under "Menu" below 768 px,
  TOC hidden below 1024 px.
- Screenshots: `site/assets/shots/*.png` are real screens of the demo repository in local prod,
  cropped to the content pane. Rule: English UI text only, no e-mail, user name or local path on
  them. Features and deck show them as `<figure class="shot">` with a "where in the app" caption;
  they are not dataset figures and carry no illustrative label.

  | Shot | Shows | Used on |
  |---|---|---|
  | `context-usage.png`, `change-surface.png`, `analytics.png`, `okf-usage.png`, `tool-analytics.png` | Features blocks B, C, D, G, H | Features (the first three also in the deck) |
  | `agent-tree.png`, `call-tree.png`, `context-growth-start.png`, `context-growth-later.png`, `cost-by-branch.png`, `harness-usage.png`, `lines-per-hour.png`, `metric-list.png`, `sessions-by-cost.png`, `timeline.png`, `tool-heatmap.png`, `tools-mcp.png` | session charts, reports, analytics | deck |
  | `nav-lenses.png` | one row of session tabs: the View select on Cost, its row and "More" open | Features → Navigation |
  | `nav-chart-tabs.png` | View: All tabs, Call Tree open as a session tab of its own | Features → Navigation |
  | `summary-hub.png` | Summary tiles, "Where to look next" cards, Explore chips | Features → Navigation |
  | `all-views-map.png` | All views map filtered "cost" | Features → Navigation |
  | `demo/app-tour.gif` (+ first frame `demo/app-tour.png`) | 25 s tour, 960×600: repositories, sessions by cost, summary, context growth, call tree, Session Map replay, change surface, cost by branch | `README.md` and item 1 of the Home "See it in action" carousel |
  | `demo/<id>.png` (21 stills, 2560×1600) | one screen each (repos, sessions, session tabs, analytics views, tools) | Home carousel |
  | `demo/clip-*.gif` (10 clips, 960×600, 5–8 s) + first frame `demo/clip-*.png` | short interactions (map replay, tab switching, analytics range/group/metric, call-tree drill-down, …); the first frame is the `prefers-reduced-motion` still | Home carousel |
  | `demo/thumbs/<id>.jpg` (256×160) | one thumbnail per item | Home carousel strip |
  | `demo/items.json` | manifest in carousel order: `{ id, kind, src, still?, thumb, duration?, caption, where, alt }` | read by `carousel.js` and `@S-SITE-01` |

  **Demo media (`site/assets/demo/`).** Written only by the manual
  `npm run record:demo -- <tour|items|all> [--only <id>[,<id>]]` (`scripts/site/record-demo.mjs`);
  it is not part of `build:site`, CI or the Pages deploy, which just copy the committed files.
  `tour` records `app-tour`, `items` the stills and clips, `all` both; `--only` re-records the
  listed catalog ids (each must belong to the mode) and keeps the other `items.json` entries.
  It drives a running Log Hub with Playwright Chromium (identify-only login, GET navigation only,
  never starts a server) and needs the env vars `LOGHUB_URL`, `LOGHUB_EMAIL` (demo repository
  owner), `LOGHUB_REPO`, `SESSION_COST` (costly session, English prompts) and `SESSION_AGENTS`
  (session with a workflow and sub-agents) — no defaults, never written to tracked files; missing
  or malformed → exit 2. Budgets (violation fails the item, exit 1): tour ≤ 5,000,000 bytes and
  22–28 s, clip ≤ 3,000,000 bytes and 5–8 s, still ≤ 600,000 bytes, the whole folder ≤ 25,000,000
  bytes. A clean-frame guard fails a scene on Cyrillic, "Loading" text, a local path or an e-mail
  other than `dev@example.com`. The script never deletes files; it warns about foreign files in
  `demo/` for a human to remove.

  The navigation shots (v1.2.0) were taken in the dev app from a demo-repository export of local
  prod (bootstrap-imported via "Import repo sessions" into a neutral identity, so Home lists only
  that repository), at least three framings each in `tmp/site-shots/`, and picked by a
  `model: "fable"` judge (clarity of the navigation idea, readability at 900 px, balance, clutter;
  1–10, best of each subject, retake below 7). Features stacks a block's further shots in
  `.shot-grid` (one column, max 960 px, never upscaled past the image's own width).

## Example dataset placeholders

`site/data/example-dataset.json` is the only source of figures on Home, Features and the deck
(fictional team: 6 developers, $8.00 session, 18 sessions/day = $144.00, 20 working days = $2,880.00).
A figure that is not a key of this file must not appear; add the key first. Every block that shows
dataset figures carries `<span class="illustrative">Illustrative example</span>`.

- `{{ds:<dot.path>}}` raw value (thousands separator for integers), `|usd` (`$2,880.00`),
  `|usd0` (`$8`), `|pct` (`78%`).
- `scripts/site/dataset.mjs`: `checkDataset(ds)` returns errors when the session parts do not sum to
  the total (±0.005), `daily.total ≠ daily.sessions × session.total`,
  `monthly.total ≠ team.workingDays × daily.total`, `contextRereadPct` does not match the token
  counts, or — when the optional `insight` block (Home "what to do about it" readout) is present —
  its unused-context share, sub-agent share or trim saving per session / per month do not follow
  from the other figures; `fillPlaceholders(text, ds)` throws on an unknown key or format. Any error fails the
  build. Algorithm doc: `docs/knowledgebase/algorithms/site-example-dataset.md`.

## Deck

`site/deck/index.html` is a standalone reveal.js 5.2.1 page loaded from jsDelivr with pinned
versions, `integrity="sha384-…"` and `crossorigin="anonymous"` (no npm dependency; the offline
product does not depend on it — the site is an extra, the user docs ship with the app). No reveal
theme: `../assets/theme.css` plus deck rules. 1280×720, `hash: true`, notes plugin, slide numbers
`c/t`; `?print-pdf` prints it. Content slides: one headline, ≤ 3 bullets, ≤ 40 body words, one key
figure from the dataset; the rest goes to `<aside class="notes">`.

## Deploy (`.github/workflows/pages.yml`)

Runs on a push to `main` that touches a site input (`site/**`, `user-docs/**`, the two hook docs,
`scripts/user-docs/**`, `scripts/site/**`, `package.json`, `package-lock.json`, the workflow) and
on `workflow_dispatch`. `README.md` and `client/**` are not inputs. Top-level permissions
`contents: read`; the `deploy` job alone gets `pages: write` and `id-token: write`, environment
`github-pages`, `concurrency: pages` without cancelling. Steps (actions pinned by SHA): checkout
(`persist-credentials: false`) → setup-node 24 → `npm ci --ignore-scripts` → `npm run build:site`
→ configure-pages → upload-pages-artifact (`tmp/site`) → deploy-pages.

**Owner step, once per repository:** GitHub → repository **Settings → Pages → Build and
deployment → Source: GitHub Actions**. Until that is set the deploy job fails; nothing in the
repository can set it.

**Sitemap submission (owner, manual):** a project site cannot serve `robots.txt` (crawlers read it
only at the host root `dataart.github.io`), so `https://dataart.github.io/artisyn-log-hub/sitemap.xml`
is submitted by hand in Google Search Console and Bing Webmaster Tools after a deploy.

## Related

- [client-routing-and-layout.md](client-routing-and-layout.md) — HelpModal behaviour.
- [client-component-map.md](client-component-map.md) — `viewer/help/` files and the generated `public/help/`.
- [repo-local-packages.md](repo-local-packages.md) — the `@loghub/user-docs` alias.
- [static-asset-serving.md](static-asset-serving.md) — how `/help/*.md` is served and cached.
- `docs/third-party-components.md` — rows for the renderer packages, `rehype-slug` and reveal.js;
  keep `user-docs/third-party-components.md` in sync with it.
