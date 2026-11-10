---
type: "Reference"
title: "User Docs and Site (user-docs/, in-app help, GitHub Pages)"
description: "The one user-documentation page set in user-docs/ and its nav.json, the link rules shared by every consumer (scripts/user-docs/links.js), the generator that writes the in-app help into client/public/help/ and every build path that runs it, the static site renderer (scripts/site/) and its output (head/OG tags, canonical URLs, sitemap.xml, 404.html, favicon and og-image), the example dataset placeholders, the reveal.js deck, the pages.yml deploy workflow and the one-time owner step."
tags:
  - docs
  - client
  - build
  - site
timestamp: "2026-11-06T00:00:00+04:00"
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
| Get started | `install-server`, `small-team-setup` ("Quick setup for a small team": VM in a company network, Modes 2/3, copy-paste `.env`, http vs https), `install-hook` (source `../hook/INSTALL_HOOK.md`), `getting-started` ("Your first session"), `connect-repository` |
| Configuration | `authentication-modes`, `server-configuration`, `tuning-your-setup`, `otel-admin-guide`, `security-hardening` |
| Using Log Hub | `all-views`, `session-list`, `session-log`, `cost-and-context`, `analytics-reports`, `budgets`, `okf-tab`, `otel-tab`, `otel-architecture` |
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
  - `og-image.png` (2026-11-06, harness thesis): a hand-written HTML card — "Artisyn Log Hub",
    the tag "Your Claude Code harness, measured", the hook headline from the dataset ("It ran
    alone for 10 minutes, cost $8 and shipped the feature. All good?"), the nine harness elements
    and five tiles (quality, cost, speed, autonomy, safety) — in the dark site palette (`theme.css`
    dark tokens, system and monospace font stacks, no external fonts), served from a temporary
    local HTTP server (Playwright MCP blocks `file:`) and screenshotted at a 1200×630 viewport.
    The HTML is not committed; rebuild it from this description. Its figures must stay equal to
    `session.durationMin`, `session.total` and `session.outcome` in the dataset. (Until
    2026-11-06 the image was the OTEL tab's cost-flow Sankey.)
  - Check both with an IHDR size read (bytes 16–23) — `@S-SITE-01` step 17 asserts 1200×630 and
    180×180, and that the output favicon equals `client/public/favicon.svg` byte-for-byte.
- `layout.mjs` exports `SITE_URL` (`https://dataart.github.io/artisyn-log-hub/`), `REPO_URL`,
  `RELEASES_URL`, filled into `{{site:url}}`, `{{site:repo}}`, `{{site:releases}}`. Top nav: Home,
  Features, Get started, Configuration, Using Log Hub, Data & security, FAQ (`questions.html`;
  renamed from "Questions" 2026-11-06 so it does not collide with Features' "Nine questions"),
  Deck, GitHub ↗; a section link opens that section's first page. Page titles are
  `<title> — Artisyn Log Hub`, except a title that already starts with the site name, used as is
  (Home: "Artisyn Log Hub — your Claude Code harness, measured"). Changelog is in the sidebar and footer only.
- Style: "old digital" — warm paper / near-black palette, muted phosphor green and amber, monospace
  headings, nav, labels and numbers, a faint grid background, square corners; no neon or glow.
  Light/dark palette from `prefers-color-scheme`; sidebar collapses under "Menu" below 768 px,
  TOC hidden below 1024 px.
- Spelling: the hand-written site pages (`site/pages/*.html`) and the deck use American spelling
  ("organization", "favor", "color", "license"); `user-docs/` and `docs/` are not converted.
- Screenshots: `site/assets/shots/*.png` are real screens from local prod — the demo repository,
  or the Log Hub repository where the demo one has no data (OTEL, KB, Live) — cropped to the
  content pane. Rule: English UI text only, no e-mail, user name or local path on them. Features
  and deck show them as `<figure class="shot">` whose caption is only "where in the app" (e.g.
  `Session → Change surface`), with no "real screen" or repository suffix; they are not dataset
  figures.

  | Shot | Shows | Used on |
  |---|---|---|
  | `change-surface.png`, `analytics.png`, `okf-usage.png`, `tool-analytics.png` | Features blocks C, D, G, H | Features (`change-surface.png` also on deck slide 21) |
  | `context-usage.png` | Session → Charts → Context Usage | no longer shown (replaced by `system-context-anatomy.png` in deck v2); kept for reuse |
  | `agent-tree.png`, `call-tree.png`, `context-growth-start.png`, `context-growth-later.png`, `cost-by-branch.png`, `harness-usage.png`, `lines-per-hour.png`, `metric-list.png`, `sessions-by-cost.png`, `timeline.png`, `tool-heatmap.png`, `tools-mcp.png` | session charts, reports, analytics | deck |
  | `system-context-anatomy.png` (2026-11-06) | Session → System context anatomy: startup context by source (bar + table), demo repository, `/adlc-demo:implement` session | deck slides 6 and 17, Features B |
  | `otel-cost-by-skill.png` (2026-11-06) | Repository → OTEL, 7 days, cost stacked by skill, Log Hub repository (taken at a 1100 px viewport so the chart stays readable at 600 px) | deck slide 10 |
  | `session-map.png` (2026-11-06) | Session → Session Map, replay of a finished workflow session, demo repository | deck slide 14, Features I |
  | `trace-waterfall.png` (2026-11-06) | Session → OTEL → Traces, one turn's waterfall (the demo repository has no traces, so a Log Hub repository session with English skill names) | deck slide 14, Features I |
  | `live-view.png` (2026-11-06) | Top bar → Live: tree, tiles and "Tokens over time" (chart 2 / 7), paused; the user e-mail was replaced by "Developer A" and the team name by "Team A" in the DOM before the shot (as for `og-image.png`), the crop stops above a Cyrillic session title | deck slide 15, Features I |
  | `okf-kb-value.png`, `okf-kb-value-heuristic.png` (2026-11-06) | Repository → OKF, KB folder `docs/knowledgebase`: section A (verified) and section B (heuristic, check by hand), Log Hub repository (the demo repository has no KB) | deck slide 19, Features G |
  | `spend-budget.png` (2026-11-10) | Repository → Spend: the monthly budget card (bar, ticks, four tiles) and the daily chart with the budget-pace legend, Log Hub repository, 1100 px viewport; the slice table and costly-sessions list (which carry e-mails) were removed from the DOM before the shot | deck slide 12, Features → A |
  | `nav-lenses.png` | one row of session tabs: the View select on Cost, its row and "More" open | Features → Navigation |
  | `nav-chart-tabs.png` | View: All tabs, Call Tree open as a session tab of its own | Features → Navigation |
  | `summary-hub.png` | Summary tiles, "Where to look next" cards, Explore chips | Features → Navigation |
  | `all-views-map.png` | All views map filtered "cost" | Features → Navigation |
  | `demo/app-tour.gif` (+ first frame `demo/app-tour.png`) | 25 s tour, 960×600: repositories, sessions by cost, summary, context growth, call tree, Session Map replay, change surface, cost by branch | `README.md` and item 1 of the Home "See it in action" carousel |
  | `demo/<id>.png` (21 stills, 2560×1600) | one screen each (repos, sessions, session tabs, analytics views, tools) | Home carousel |
  | `demo/clip-*.gif` (10 clips, 960×600, 5–8 s) + first frame `demo/clip-*.png` | short interactions (map replay, tab switching, analytics range/group/metric, call-tree drill-down, …); the first frame is the `prefers-reduced-motion` still | Home carousel |
  | `demo/thumbs/<id>.jpg` (256×160) | one thumbnail per item | Home carousel strip |
  | `demo/items.json` | manifest in carousel order: `{ id, kind, src, still?, thumb, duration?, caption, where, alt }` | read by `carousel.js` and `@S-SITE-01` |

  The deck v2 shots were taken from local prod with Playwright MCP (identify-only login), clipped
  to the content pane; none shows an e-mail, a person's name or a local path. Not captured: an
  OKF single-article drill-down (the repository view shows the verified/heuristic split instead)
  and the Agents table with the Phase column (the speed slide uses `lines-per-hour.png`).

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

`site/data/example-dataset.json` is the only source of Log Hub figures on Home, Features and the
deck (one worked example: a team of 6 developers, a 10-minute $8.00 session, 18 sessions/day =
$144.00, 20 working days = $2,880.00). A figure that is not a key of this file must not appear; add
the key first. Values stay in the normal range for such sessions and teams and are stated plainly:
no "Illustrative example" label, no "fictional" or "hypothetical" wording (removed 2026-11-06 with
the `.illustrative` CSS). Dataset blocks are `.deck-figure` (deck) or `.figure-block` (site).

Keys added for deck v2 (2026-11-06; no `checkDataset` rule reads them): `session.durationMin`,
`session.autonomousMin`, `session.outcome` (the hook's "shipped the feature"),
`session.linesChanged`, `session.subAgents`, `session.parallelPeak`, `session.mcpCalls`,
`session.mcpErrors`, `kb.articlesRead`, `kb.pointerYieldPct`, `kb.alwaysReadPct`,
`kb.orgSyncedContextPct`, `costShare.skill.*`, `costShare.mcp.*`, `costShare.effort.*`,
`costShare.fastMode.*` (each group sums to 100), `live.tokensPerMin`, `live.sessionsNow`,
`productivity.linesPerAutoHour` (= linesChanged / autonomousMin × 60, rounded). Money and percent
placeholders state their format (`|usd`, `|usd0`, `|pct`); counts and strings use the raw form.

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
theme: `../assets/theme.css` plus deck rules. 1280×720, `hash: true`, slide numbers `c/t`;
`?print-pdf` prints it. Content slides (`section.content-slide`): one headline, ≤ 3 bullets, ≤ 40
words of `.slide-body` text (text in a `.deck-figure` or `.visual-slot` does not count), at most one
key figure from the dataset. No speaker notes (`aside.notes`), no footnotes, no Sources slide, no
source URLs.

**Map and dividers (2026-11-10).** One `<template id="deck-map">` (outside `.reveal`) holds the
deck map: the black box ("N minutes alone, $8 spent, feature shipped — All good?") → nine group
nodes (`li[data-group]`: harness, cost, speed, context, quality, team, tools, safety, trust). The
inline script clones it into every `.map-host` before `Reveal.initialize`; a host with
`data-active="<group>"` gets `.deck-map.has-active` and its node `.active` (highlighted, the
rest dimmed). `section.map-slide` (after "black box") shows the whole map; a
`section.divider-slide` ("Part N of 9 · <group>", headline = the group's question) opens each
group from cost to trust. Neither is a `.content-slide`, so the body-text rules do not apply to
them. Styles: the "Deck map" block at the end of `deck.css`.

**"Your harness, measured" (v2, 2026-11-06).** Storyline: the hook, then the harness thesis, then
the five dimensions (quality, cost, speed, autonomy, safety) answered one by one. Pills in each
slide head: hook · harness · cost · speed · context · quality · team · tools · safety · trust.
**Safety** is about the agent (what it read and sent, the injection surface); **trust** is about
Log Hub's own data (where it lives, outbound calls, who reads it, retention) — split 2026-11-10.

| # | Slide | Visual |
|---|---|---|
| 1 | Title — "Your harness, measured" | — |
| 2 | Hook (`section.thesis-slide`): "It ran alone for N minutes, cost $8 and shipped the feature. All good?" + the five questions | dataset control column, five tiles |
| 3 | The harness decides — one study figure per dimension | `.visual-slot.study-board` (no dataset figure) |
| 4 | Black box vs glass box — the vendor's own advice | contrast board |
| 5 | Map (`section.map-slide`): "One “All good?”, nine places to look." | deck map |
| 6 | Anatomy of a harness — nine elements → view (same nine as the Home strip; Settings dropped 2026-11-10) | table + `system-context-anatomy.png` |
| 7 | Divider · Part 2 of 9 · cost | deck map, cost highlighted |
| 8 | Cost · four prices plus sub-agents | cost bar |
| 9 | Cost · context growth | `context-growth-*.png` |
| 10 | Cost · by skill, MCP server, effort, fast mode (OTEL) | `otel-cost-by-skill.png` |
| 11 | Cost · one session from every side | mosaic (agent tree, timeline, tool heatmap, call tree) |
| 12 | Cost · budgets: forecast and threshold notices (2026-11-10, no dataset figure) | `spend-budget.png` |
| 13 | Divider · Part 3 of 9 · speed | deck map |
| 14 | Speed · autonomy | mosaic (Session Map, timeline, trace waterfall, lines per hour) |
| 15 | Live | `live-view.png` |
| 16 | Divider · Part 4 of 9 · context | deck map |
| 17 | Context · harness tax | `system-context-anatomy.png` |
| 18 | Context · what the agent uses | `harness-usage.png` |
| 19 | Context · knowledge base, verified vs heuristic | `okf-kb-value*.png` |
| 20 | Divider · Part 5 of 9 · quality | deck map |
| 21 | Quality · what changed, and what it was about (session attributes as tags) | `change-surface.png` |
| 22 | Divider · Part 6 of 9 · team | deck map |
| 23 | Team · analytics, reports, anomalies | anomaly board |
| 24 | Team · 13 metrics | mosaic |
| 25 | Divider · Part 7 of 9 · tools | deck map |
| 26 | Tools · author and admin | tool table + `tools-mcp.png` |
| 27 | Divider · Part 8 of 9 · safety | deck map |
| 28 | Safety · what the agent read and sent, and who could steer it | study line + "traceable afterwards" board |
| 29 | Divider · Part 9 of 9 · trust | deck map |
| 30 | Trust · Log Hub's own data stays on your host (outbound calls, post-turn analysis without tools) | seal board |
| 31 | Trust · collected, visible to, kept for | seal board |
| 32 | Closing — the hook's answer, links | — |

**Home (v2).** Hero: the same hook (`h1` from the dataset), the harness claim in the lead with one
attributed study figure, "right and useful" and "Log Hub answers the next questions", five
dimension tiles (`.dimensions a.dimension` → Features C, A, I, I, E); the worked example (step 02
gains KB and MCP lines, "What to do" a fourth action); the carousel; the harness anatomy strip
(`section.anatomy`, nine elements → Features blocks); six cards (five dimensions + team scale).
**Features** has nine blocks A–I ("Nine questions Log Hub answers"); block I is "Was it fast, and
how far could it go alone?".

**Study figures and sources.** A study figure on a slide or on Home is attributed in its own
sentence (institution or group, year) and never shares a tile with a dataset figure. An Anthropic
statement appears only as the vendor's own advice or admission. The source list lives only here
(and in the task notes), never on the site:

| Figure (where) | Source | Date · status | URL | Check (2026-11-06) |
|---|---|---|---|---|
| up to 5× cost per task at similar success (deck 3, Home lead) | HarnessTax — UC Berkeley Sky Computing Lab and Arena | 2026-09 · research blog, not peer-reviewed | https://harnesstax.github.io/ | confirmed: "similar success rates at up to 5x costs"; typical gap 1.5–2.0× |
| 43 → 72 of 169 tasks fully solved (deck 3) | "Same Model, Different Harness: Different Coding-Agent Results", arXiv 2608.26218 v1 | 2026-08-26 · preprint | https://arxiv.org/abs/2608.26218 | confirmed (abstract, Table 2); the treatment is a harness-only bundle (old tool results, stall detection, command guards) on a SWE-bench Verified subset |
| 16,581 vs 829 tokens of first-call fixed context, Claude Code vs mini-SWE-agent (deck 3, Speed tile) | Liu, Han, "What Does a Harness Buy? Tokens, Mostly", arXiv 2610.04433 | 2026-10-03 · preprint | https://arxiv.org/abs/2610.04433 | confirmed (16,581 / 7,025 / 829); its "accuracy within 2 pp" secondary claim is wrong (paper: within 5 pts) and is not used |
| 18 models, performance degrades as input grows (deck 3, Autonomy tile: a long solo run is a growing input) | Chroma, "Context Rot" | 2025-07-14 · industry research report | https://www.trychroma.com/research/context-rot | confirmed |
| not used: ~7 months doubling of the 50 % task horizon | METR, "Measuring AI Ability to Complete Long Tasks", arXiv 2503.14499 | 2025-03 · preprint | https://arxiv.org/abs/2503.14499 | confirmed, but it measures model progress, not a harness effect, so it left the Autonomy tile (2026-11-06 review) |
| 36.5 % average success of poisoned MCP tool descriptions, 20 agent settings (deck 3) | MCPTox, arXiv 2508.14925 (AAAI-26) | 2025-08-19 · peer-reviewed | https://arxiv.org/abs/2508.14925 | confirmed (§4.1, §4.2) |
| 62–100 % MCP injection success, 18 model–server pairs (deck 28) | "Log-To-Leak", arXiv 2610.36108 v1 | 2026-10-26 · preprint | https://arxiv.org/abs/2610.36108 | confirmed (abstract: 62.64–100 %) |
| not used: LLM judges favour their own output | Panickssery, Bowman, Feng, "LLM Evaluators Recognize and Favor Their Own Generations", NeurIPS 2024 | 2024 · peer-reviewed | https://arxiv.org/abs/2404.13076 | confirmed, but it left deck slide 16 on 2026-11-10: session attributes are tags the team defines (ticket, customer, stage), not a verdict on the session |
| vendor advice: read the traces, remove one component at a time (deck 4) | Anthropic, "Harness design for long-running application development" | 2026-03-24 · vendor blog | https://www.anthropic.com/engineering/harness-design-long-running-apps | confirmed (verbatim fragments) |

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
