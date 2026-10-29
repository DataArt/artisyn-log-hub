# Implementation plan — Log Hub Site on GitHub Pages + shared user docs

## TL;DR

- **New top-level folders:** `user-docs/` (the one page set + `nav.json`, replaces `client/public/help/*.md` as source) and `site/` (Home, Features, theme, deck, `data/example-dataset.json`). `client/public/help/` becomes generated, gitignored output.
- **New scripts:** `scripts/user-docs/links.js` (+ `links.d.ts`; pure link/slug resolution, CJS, built-ins only), `scripts/user-docs/generate-help.js` (writes `client/public/help/*.md`, fails on unresolved links), `scripts/site/build-site.mjs` (+ `layout.mjs`, `dataset.mjs`) pre-rendering the site into `tmp/site/`.
- **Every build path changes:** client `prebuild`/`predev`, `scripts/build.js` + `build:serial` (new `build:help` step), `Dockerfile` client stage (copies `user-docs/`, two hook docs, `scripts/user-docs/`), `scripts/scenarios/build-stand.mjs`; CI `checks.yml` gains a "user docs and site" step (link check + `build:site`).
- **New deps:** client `rehype-slug` (heading ids in HelpModal); root devDependencies `unified`, `remark-parse`, `remark-gfm`, `remark-rehype`, `rehype-slug`, `rehype-stringify` (site renderer). Deck uses reveal.js 5.2.1 from jsDelivr with SRI (no npm dep).
- **Client:** `help/articles/index.ts` imports `@loghub/user-docs/nav.json` (new Vite/tsconfig alias); HelpModal gets a `getting-started` default constant, an internal/anchor/external link handler and heading ids.
- **New workflow:** `.github/workflows/pages.yml` (GitHub Pages deploy, SHA-pinned actions, `pages: write`/`id-token: write` on the job only).
- **README** cut to pitch block + minimal quick start + links; its install/config/data sections move into new `user-docs/` pages (`install-server`, `authentication-modes`, `server-configuration`, `trust-model`) and merged pages.
- **Docs:** new KB article `docs/knowledgebase/user-docs-and-site.md`; every tracked "edit `client/public/help/…`" reference (KB, skills, READMEs, CLAUDE.md command table rows for `build:help`/`build:site`) repointed/added; third-party-components rows for the new deps and reveal.js; two task wireframe SVG edits; changelog entry.
- No DB changes, no API changes. Tests: two new algorithm docs + `node --test` table tests; new test helper `tests/scenarios/helpers/help-nav.ts`; edits to tour-09/tour-10/screen-registry/notice-hash helpers and the button name in legacy `tests/e2e/help-modal.spec.ts`; one new scenario `tests/scenarios/platform/s-site-01.spec.ts` (+ catalog entry §S-SITE-01).

## Reference

Requirements: [requirements.md](requirements.md) (GH-47). Research archive: `research/findings-1.md`.

## Design Decisions

**Page set and generation**

1. **DD-1 `nav.json` shape.** `user-docs/nav.json` is a JSON array of `{ "section": string, "articles": [{ "slug", "title", "downloadable"?: true, "source"?: string }] }` — exactly today's `HelpSection[]` plus optional `source` (path relative to `user-docs/`). Order and content = the FR-2 page map (table below).
2. **DD-2 Page map** (sections in this order; `src` = `user-docs/<slug>.md` unless noted; `dl` = downloadable):

   | Section | slug | title | dl | source |
   |---|---|---|---|---|
   | Get started | install-server | Install the server | | |
   | Get started | install-hook | Install the hook | ✓ | `../hook/INSTALL_HOOK.md` |
   | Get started | getting-started | Your first session | | |
   | Get started | connect-repository | Connecting a Repository | ✓ | |
   | Configuration | authentication-modes | Authentication modes | | |
   | Configuration | server-configuration | Server settings | | |
   | Configuration | tuning-your-setup | Tuning Your Setup | | |
   | Configuration | security-hardening | Security Hardening & Configuration | ✓ | |
   | Using Log Hub | session-list | Working with the Session List | | |
   | Using Log Hub | session-log | Session Log | | |
   | Using Log Hub | cost-and-context | Understanding Cost & Context | | |
   | Using Log Hub | analytics-reports | Analytics & Reports | | |
   | Data and security | data-collection-notice | Data Collection Notice | | |
   | Data and security | data-collection | Data Collection & Upload | | |
   | Data and security | trust-model | Trust model | | |
   | Data and security | component-reference | Component Reference | ✓ | |
   | Data and security | responsibility-matrix | Responsibility Matrix (RACI) | ✓ | |
   | Data and security | third-party-components | Third-Party Components | ✓ | |
   | Data and security | how-hook-works | How the hook works | ✓ | `../hook/HOW_HOOK_WORKS.md` |
   | Changelog | changelog | Changelog | | |

3. **DD-3 Link resolution contract** (`scripts/user-docs/links.js`, pure, CommonJS, Node built-ins only; shared by the help generator, the site renderer and tour-10; typed for TS callers by a hand-written `scripts/user-docs/links.d.ts`). Links are always written as **real relative file paths that work on GitHub**: between `user-docs/` pages `slug.md[#anchor]`; from a `user-docs/` page to a source-backed page `../hook/INSTALL_HOOK.md` / `../hook/HOW_HOOK_WORKS.md`; inside the hook files as they are today (`HOW_HOOK_WORKS.md`). Exports:
   - `loadNav(repoRoot)` → `{ sections, pages: [{ slug, title, downloadable, section, file }] }` (`file` = absolute source path; `user-docs/<slug>.md` or `user-docs/` + `source` resolved).
   - `resolveLink(href, fromFile, nav)` → `{ kind: 'external' }` (`http:`/`https:`/`mailto:`), `{ kind: 'anchor', anchor }` (`#x`), `{ kind: 'page', slug, anchor }` (the path part resolved against `path.dirname(fromFile)` equals some page's `file`, compared case-sensitively with `/` separators), or `{ kind: 'unresolved' }` for any other relative link (e.g. `../server/README.md`, images, a missing page).
   - `findLinks(markdown)` → inline/reference link hrefs (regex over `](href)` and `[x]: href`, skipping fenced code blocks and inline code).
   - `rewritePageLinks(markdown, fromFile, nav)` → markdown where every `page` link whose href is not already `<slug>.md[#anchor]` is replaced by `<slug>.md[#anchor]`; all other bytes unchanged.
4. **DD-4 Help generator** (`scripts/user-docs/generate-help.js`, CJS, built-ins only, sync): `loadNav`; for every page `findLinks` → `resolveLink`; any `unresolved` → prints `<file>: <href>` lines to stderr and exits 1. Otherwise writes `<out>/<slug>.md` = `rewritePageLinks(text)` (a page with no such links, e.g. `data-collection-notice.md`, is copied byte-for-byte, so its consent hash `b5eac945` stays). Deletes stale `*.md` in `<out>` not in the nav. Options: `--out <dir>` (default `client/public/help`), `--check` (validate only, write nothing). Idempotent.
5. **DD-5 Generation points.** client `package.json`: `"prebuild": "node ../scripts/user-docs/generate-help.js"`, `"predev": "node ../scripts/user-docs/generate-help.js"` (bun 1.3.14 runs pre-scripts). Root `package.json`: `"build:help": "node scripts/user-docs/generate-help.js"`; `scripts/build.js` runs `build:help` after `build:clean` and before the parallel block (prebuild re-runs it harmlessly). `build:serial` gets `npm run build:help &&` before `build:client`. Scenario stand calls the generator explicitly before `vite build` (it bypasses `bun run build`). `checks.yml` gets one new step after its root `npm ci --ignore-scripts`: `node scripts/user-docs/generate-help.js --check && npm run build:site -- --out tmp/site-check`, so a broken link or dataset fails the PR, not only the post-merge Pages run.
5a. **DD-5a New root commands** `build:help` and `build:site` are build steps (called by `scripts/build.js`, client pre-scripts, `checks.yml`, `pages.yml`), not health checks: they are not added to `repo-health-checks.json`; the CLAUDE.md command table gets two rows marked "build step, not a health check" so they count as approved commands.
6. **DD-6 Docker.** Client-build stage adds before `COPY client/ ./`: `COPY user-docs/ /app/user-docs/`, `COPY hook/INSTALL_HOOK.md hook/HOW_HOOK_WORKS.md /app/hook/`, `COPY scripts/user-docs/ /app/scripts/user-docs/`. Paths resolve because the generator locates the repo root as `path.join(__dirname, '..', '..')`.
7. **DD-7 Client alias.** `@loghub/user-docs` → `../user-docs` in `client/vite.config.ts` `resolve.alias` (+ `server.fs.allow`), `client/tsconfig.json` `paths` `"@loghub/user-docs/*": ["../user-docs/*"]` and `include` `"../user-docs/nav.json"` (`resolveJsonModule` is already on). `index.ts` does `import nav from '@loghub/user-docs/nav.json'` and `export const helpNav: HelpSection[] = nav;` — `HelpArticle` gains `source?: string`; no `as` casts.
8. **DD-8 Tests do not import `help/articles/index.ts`** any more (its alias import would break `tests/tsconfig.json`, which has no `paths`). A new helper `tests/scenarios/helpers/help-nav.ts` re-exports `loadNav`/`resolveLink`/`findLinks` from `scripts/user-docs/links.js` (typed by `links.d.ts`, no `any`) and exports `helpNav` (the nav sections) and `helpPageFile(slug)` (repo-relative source path).
9. **DD-9 `.gitignore`**: add `client/public/help/`. The 14 tracked files are moved to `user-docs/` with the file tools (owner's commit records the move); no git command is run.
10. **DD-10 Dedup ("no text twice").** `authentication-modes.md` owns the auth-mode text; `security-hardening.md` §3.1 keeps only a one-paragraph pointer to `authentication-modes.md`. `install-hook` (INSTALL_HOOK.md) owns hook-install steps; `getting-started.md` "Installing the Hook" and `connect-repository.md` "Step 1 — Install the hook" shrink to one sentence linking `../hook/INSTALL_HOOK.md` (DD-3 form; served in the app as `install-hook.md`). README "Security notes" merges into `security-hardening.md` without renumbering: its points go into the matching existing sections or into a new last section `## 12. Security notes`, so `3.6`, `§11` and other headings referenced by `screen-registry.ts` and KB keep their numbers; README "What is collected" merges into `data-collection.md` under heading `## What is collected` (anchor `what-is-collected`).
11. **DD-11 Hook page titles.** `install-hook` / `how-hook-works` keep their own H1s ("Install Telemetry Hook", "How the Telemetry Hook Works"); the nav titles differ by design. Hook files are not edited.
12. **DD-12 Wireframe "NEW" markers** are annotations for reviewers only; the menu renders no badge.
12a. **DD-12a Downloads of source-backed pages.** "Download .md" serves the generated copy, so a downloaded `install-hook` file links `how-hook-works.md` (the app's help file names) instead of `HOW_HOOK_WORKS.md` — intended. The file name stays `helpDownloadFileName(slug)` = `artisyn-log-hub-<slug>.md` (e.g. `artisyn-log-hub-install-hook.md`).

**HelpModal**

13. **DD-13 Default page.** `const DEFAULT_HELP_SLUG = 'getting-started'` in `HelpModal.tsx` replaces `allArticles[0]`.
14. **DD-14 Link handler** in a new `client/src/viewer/help/HelpMarkdownLink.tsx` passed as `components={{ a: ... }}` with a callback `onNavigate(slug, anchor?)`:
    - `#anchor` → scroll the element with that id inside the content pane; missing id → no-op.
    - `<slug>.md[#anchor]` with a known slug → `onNavigate`; unknown slug → `console.warn('[help] unknown help page: <href>')`, no navigation (warn is not collected by tour-kit, which only collects `console.error`).
    - `http(s):`/`mailto:` → `target="_blank" rel="noopener noreferrer"` with a trailing ` ↗` text node.
    - Parsing lives in a pure `parseHelpHref(href, knownSlugs)` in `client/src/viewer/help/help-links.ts` (same rules as DD-3 minus `source` basenames, which the generator already rewrote).
15. **DD-15 Anchor scroll.** HelpModal keeps `pendingAnchor` state; after `content` renders (effect on `[content, pendingAnchor]`) it calls `document.getElementById(anchor)?.scrollIntoView({ block: 'start' })`, otherwise sets the pane's `scrollTop = 0`. Heading ids come from `rehypePlugins={[rehypeSlug]}` (github-slugger, same as the site).
16. **DD-16 Retention placeholder.** In-app help shows pages as today (no substitution added). The site renderer replaces `{{RETENTION_DAYS}}` with "the retention period configured on your server (default 30 days)".

**Site**

17. **DD-17 Layout of `site/`:**
    - `site/assets/theme.css` (shared by site and deck; tokens on `:root`, dark palette under `@media (prefers-color-scheme: dark)`; light palette per wireframe: text `#111827`, secondary `#374151`/`#6b7280`, accent `#1e3a5f`, page `#ffffff`, stage `#f3f4f6`), `site/assets/site.js` (mobile menu toggle only).
    - `site/pages/home.html`, `site/pages/features.html` — body fragments wrapped by the layout.
    - `site/deck/index.html` — standalone reveal.js page (no site nav).
    - `site/data/example-dataset.json` — DD-21.
18. **DD-18 Output** (`tmp/site/`, gitignored via `tmp`): `index.html` (Home), `features.html`, `docs/<slug>.html` for every nav page, `deck/index.html`, `assets/*`. All links relative (`../`-aware per depth); no root-absolute URL. Section landing in the top nav = the first page of that section (`docs/install-server.html`, `docs/authentication-modes.html`, `docs/session-list.html`, `docs/data-collection-notice.html`). Changelog is in the docs sidebar and footer only.
19. **DD-19 Renderer** `scripts/site/build-site.mjs` (ESM `.mjs` — a documented exemption from the nodejs-script CJS rule, because unified/remark are ESM-only; precedent `scripts/scenarios/*.mjs`), sync file I/O, `unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSlug).use(rehypeStringify).processSync`. No `rehype-raw` (raw HTML is escaped/dropped as in the app). Steps: validate links (DD-3, exit 1 on `unresolved`), rewrite `page` links in mdast to `<slug>.html#anchor`, collect h2/h3 `{depth,id,text}` from hast for the TOC (shown when ≥ 3 entries), substitute `{{RETENTION_DAYS}}`, substitute dataset placeholders (DD-21) in Home/Features/deck, wrap with `layout.mjs`, copy assets. CLI: `--out <dir>` (default `tmp/site`); refuses an `--out` outside the repo or equal to the repo root. Root script `"build:site": "node scripts/site/build-site.mjs"`.
19a. **DD-19a Site constants** (exported from `scripts/site/layout.mjs`): `SITE_URL = 'https://dataart.github.io/artisyn-log-hub/'`, `REPO_URL = 'https://github.com/DataArt/artisyn-log-hub'`, `RELEASES_URL = REPO_URL + '/releases'`. The renderer fills `{{site:url}}`, `{{site:repo}}`, `{{site:releases}}` in Home/Features/deck. Output uses relative links only and never depends on the `/artisyn-log-hub/` base path; tests serve under that path (`BASE_PATH = '/artisyn-log-hub/'` constant in the scenario) to prove it.
20. **DD-20 Layout** (`scripts/site/layout.mjs`): `page({ title, depth, nav, activeSection, body, toc, prevNext })` → full HTML: top nav (Home, Features, Get started, Configuration, Using Log Hub, Data & security, Deck, GitHub ↗), docs pages get the three-column layout of `wireframes/site-docs-page.svg` (sidebar from nav, content, "On this page" TOC, prev/next), footer "MIT · GitHub · Releases · Changelog · not affiliated with Anthropic". Repo `https://github.com/DataArt/artisyn-log-hub`, releases `…/releases`. `<meta name="viewport">`, base font 16 px, no external fonts/scripts.
21. **DD-21 Example dataset.** `site/data/example-dataset.json` (fictional, all money in USD numbers):
    - `team`: `{ developers: 6, workingDays: 20, period: "one month" }`
    - `session`: `{ total: 8.00, parts: { input: 0.62, output: 1.94, cacheRead: 2.16, cacheWrite: 1.48, subAgents: 1.80 }, tokens: { input: 42000, output: 18000, cacheRead: 1560000, cacheWrite: 380000 }, contextRereadPct: 78 }` (parts sum = 8.00; tokens sum = 2,000,000; 1,560,000 / 2,000,000 = 78 %)
    - `daily`: `{ sessions: 18, total: 144.00 }` (18 × 8.00); `monthly`: `{ total: 2880.00 }` (20 × 144.00)
    - `tools`: four rows `{ name, kind: "mcp"|"cli", calls, errorPct, retriedPct, openedFilePct }` with generic names `docs-search` (mcp), `issue-tracker` (mcp), `build-cli` (cli), `db-cli` (cli, `calls: 0` = never called), used by blocks D/E.
    - The deck and pages show no figure that is not a key of this file; adding a figure means adding a key first.
    Placeholders `{{ds:<dot.path>}}` (raw, thousands separator for integers), `{{ds:<dot.path>|usd}}` (`$` + thousands separator + 2 decimals, e.g. `$2,880.00`), `|usd0` (no decimals, `$8`), `|pct` (`78%`). `scripts/site/dataset.mjs` (no top-level `await`) exports `checkDataset(ds)` → array of error strings: parts sum ≠ `total` (±0.005), `daily.total ≠ daily.sessions × session.total`, `monthly.total ≠ team.workingDays × daily.total`, `contextRereadPct ≠ round(100 × tokens.cacheRead / Σ tokens)`; and `fillPlaceholders(text, ds)` (throws `unknown dataset key: <path>` / `unknown format: <f>`). The renderer fails on any error. Every block that shows dataset figures carries the label `<span class="illustrative">Illustrative example</span>`.
22. **DD-22 Fact corrections (FR-7)** to apply in Features/deck text: 17 reports, all PDF-exportable; detector ids `context-compression`, `context-ceiling-pressure`, `low-cache-read-ratio`, `change-surface-spread`, `change-surface-modules`, `change-surface-single-file-folders`, `claude-version` (no `change-surface-shared`); tool usefulness signals `empty`, `retried`, `opened file` (no `fell back`); env defaults from `server/.env.example` (`SESSION_RETENTION_DAYS=30`, `AUTH_MODE=password-confirm`, `PASSWORD_POLICY=long`). Re-verify against code at implementation time.

22a. **DD-22a Thesis wording** (shared by README pitch, Home hero/lead and deck slide 2; adapt length, keep meaning): "You already know what AI coding costs — per month, per day, per session — and controlling that is right and useful. But a number alone is not an answer: this session cost $8. Is that a lot or a little, good or bad? How do you make it cheaper — or when is it worth spending more for better quality? Log Hub answers the next questions: why it costs that much, which factors drive it, whether your harness works the way you designed it, and what your tools really bring — for one session and across the team." Never call cost tracking useless.
22b. **DD-22b Feature blocks** (Features page sections `#a`–`#f` and deck blocks; "where" = app location, verify each tab name against `client/src/viewer/tab-ids.ts` at implementation):

   | Block | Question it answers | What it shows (pool) | Where |
   |---|---|---|---|
   | A | Why does it cost this much? | per-turn token breakdown (input/output/cache read/cache write 5m·1h/vision) priced from Log Hub's own price table; Context Growth chart with per-step drill-down; summary detectors (DD-22 ids); tree-scoped cost of root + sub-agents + workflow agents (Agents table); Turn-End Cost Advisor (LLM review after each turn); Statistics / Bash / tool-call views (success, error, denial rates, heavy Bash, files read/changed/run) | session view tabs |
   | B | Does my harness work as designed? | system context (CLAUDE.md, rules, skills, agents, MCP servers) and its token size — the per-turn "tax"; harness usage (skills/rules/workflows/MCP/tools used, how often); harness snapshot per session (spec.: compare before/after a harness change); OKF knowledge-base usage (index vs search entry, never-read articles, `always_read`, `kb_flood`, `coarse_article`, verdicts); permission attribution; Tools/MCP tab (every MCP call and monitored CLI tool call, operation tree with calls and error %, call details, signals `empty`/`retried`/`opened file`) | session view + repository tabs |
   | C | What does it really bring? | Change Surface (files/folders/modules touched, concentration); productivity counters (diff lines, commits, PRs, cost/line, lines/hour); Session Attributes (LLM labels such as task type, outcome) as a group-by for every chart and report | session view + repository analytics |
   | D | What happens across the team? | Repository Analytics (work time, cost, files, vision, MCP, cache ratio by hour/day; grouped by user/branch/attribute) and Top-N rankings; 17 reports, all PDF-exportable (Executive Summary, Cost by Branch/User, Token Usage, Tool Analytics, Harness Usage, Claude Version Usage, Cache Read Ratio, Change Surface, Attribute Breakdown, …); anomalies (ranking outliers, low cache ratio, `kb_flood`, lagging Claude Code versions, unusual cost/line, per-tool error spikes, never-called monitored tools, high `retried`); teams (transparent/restricted access, manager and ADLC-trainer roles) | repository Analytics, Reports, Tools; admin Teams |
   | E | Does this tool work — for its author and for the admin who rolled it out? | tool authors: how the agent really uses their MCP server/CLI (arguments, errors, empty answers, truncated output) with no integration on the tool side; admins/team leads: is it called at all, by whom, how often, error %, does the agent trust its output (`opened file`) or abandon it (`retried`) — the basis to keep, tune or remove it | repository Tools tab |
   | F | How do I run it? | self-hosted (Docker + Postgres, one-command install), hook via `npx`, full transcript capture by design, backward compatibility with old hooks, session export/import | Get started docs |

   *(spec.)* items appear only as a use of existing data ("compare snapshots before/after a harness change"), never as a screen. Items not picked for a slide go to that slide's speaker notes.

**Deck**

23. **DD-23 Deck engine.** reveal.js `5.2.1` from `https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/dist/{reset.css,reveal.css,reveal.js}` and `plugin/notes/notes.js`, each with `integrity="sha384-…"` (computed at implementation with `node:crypto` from the downloaded file) and `crossorigin="anonymous"`. No reveal theme CSS — `../assets/theme.css` + deck-specific rules. `Reveal.initialize({ hash: true, width: 1280, height: 720, plugins: [RevealNotes] })`. Exit link to `../index.html` hidden under `.print-pdf`.
24. **DD-24 Slide list (13 slides):** 1 Title · 2 Problem/thesis (`wireframes/slide-opening-thesis.svg`) · 3 A: cost breakdown of the $8 session · 4 A: context growth + detectors · 5 B: system context = harness tax · 6 B: harness usage + Tools/MCP · 7 C: change surface + productivity · 8 D: team analytics + 17 reports · 9 D: anomalies · 10 E: tool authors · 11 E: admins who rolled a tool out · 12 F: self-hosted foundation + install · 13 Closing (links Home, Get started, GitHub). Content slides follow `wireframes/slide-content-template.svg` (block marker, P/A–F pills, one headline sentence, ≤ 3 bullets, ≤ 40 words body, one key figure, 464×300 visual slot); leftover inventory items go to `<aside class="notes">`.

**README / workflow**

25. **DD-25 README pitch** (directly under `# Artisyn Log Hub`, before badges; ≤ 8 non-empty lines, ≤ 100 chars each, ≤ 70 words): a condensed DD-22a thesis and what Log Hub answers, then the link line `[Docs](user-docs/install-server.md) · [Site](https://dataart.github.io/artisyn-log-hub/) · [Deck](https://dataart.github.io/artisyn-log-hub/deck/)`.
26. **DD-26 `pages.yml`** — per FR-8: `on.push.branches: [main]` with `paths: [site/**, user-docs/**, hook/INSTALL_HOOK.md, hook/HOW_HOOK_WORKS.md, scripts/user-docs/**, scripts/site/**, package.json, package-lock.json, .github/workflows/pages.yml]` + `workflow_dispatch`; top-level `permissions: contents: read`; `concurrency: { group: pages, cancel-in-progress: false }`; job `deploy` on `ubuntu-latest`, `permissions: { contents: read, pages: write, id-token: write }`, `environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }`; steps: checkout `3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` (`persist-credentials: false`) → setup-node `949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0` (`node-version: 24`, `package-manager-cache: false`) → `npm ci --ignore-scripts` → `npm run build:site` → configure-pages `45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0` → upload-pages-artifact `fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0` (`path: tmp/site`) → deploy-pages `368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1` (`id: deployment`). `README.md` and `client/**` are not site inputs, so they are deliberately not in `paths`.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `user-docs/*.md` (14 moved) | page set | moved from `client/public/help/`; `getting-started.md` H1 → "Your first session" |
| `user-docs/install-server.md`, `authentication-modes.md`, `server-configuration.md`, `trust-model.md` | new pages | text moved from README sections |
| `user-docs/security-hardening.md`, `data-collection.md`, `getting-started.md`, `connect-repository.md` | merges / dedup | DD-10 |
| `user-docs/nav.json` | navigation | DD-1, DD-2 |
| `.gitignore` | ignore `client/public/help/` | DD-9 |
| `scripts/user-docs/links.js`, `scripts/user-docs/links.d.ts` | link resolution + TS types | DD-3 |
| `.github/workflows/checks.yml` | PR step: help link check + `build:site` | DD-5 |
| `CLAUDE.md` | command-table rows for `build:help`, `build:site` | DD-5a |
| `docs/changelog/<YYYY-MM-DD-HHmm>-why-loghub-slides.md` | changelog entry | changelog skill |
| `scripts/user-docs/generate-help.js` | help generator | DD-4 |
| `package.json` (root) | `build:help`, `build:site`, `build:serial`, devDeps | DD-5, DD-19 |
| `scripts/build.js` | run `build:help` | DD-5 |
| `client/package.json` | `prebuild`/`predev`, `rehype-slug` dep | DD-5 |
| `Dockerfile` | copy sources | DD-6 |
| `scripts/scenarios/build-stand.mjs` | stand inputs + generator step | DD-5 |
| `client/vite.config.ts`, `client/tsconfig.json` | alias | DD-7 |
| `client/src/viewer/help/articles/index.ts` | import nav.json | DD-7 |
| `client/src/viewer/help/HelpModal.tsx` | default, rehype-slug, anchors | DD-13, DD-15 |
| `client/src/viewer/help/HelpMarkdownLink.tsx`, `help-links.ts` | link handler | DD-14 |
| `client/src/viewer/lib/notice-hash.ts` | comment → `user-docs/` | |
| `README.md` | pitch + minimal | DD-25 |
| `client/README.md`, `docs/third-party-components.md`, `.claude/skills/security-check/SKILL.md`, `docs/qaa-overview/scenarios/06-ui-tab-walk.md` | repoint `client/public/help/` | |
| `docs/knowledgebase/user-docs-and-site.md` | new KB article | page set, generator, site, deck, deploy |
| `docs/knowledgebase/{index,client-routing-and-layout,client-component-map,release-pipeline,legacy-design-decisions-map,user-account-flows,db-tables,static-asset-serving,repo-local-packages}.md` | repoint / update | |
| `scripts/site/build-site.mjs`, `layout.mjs`, `dataset.mjs` | site renderer | DD-19..21 |
| `site/assets/theme.css`, `site/assets/site.js` | theme | DD-17 |
| `site/pages/home.html`, `site/pages/features.html` | site-only pages | |
| `site/deck/index.html`, `site/deck/deck.css` | deck | DD-23, DD-24 |
| `site/data/example-dataset.json` | dataset | DD-21 |
| `.github/workflows/pages.yml` | deploy | DD-26 |
| `docs/knowledgebase/algorithms/user-docs-links.md` + `scripts/__tests__/user-docs-links.algo.test.js` | algo doc + table test | DD-3 |
| `docs/knowledgebase/algorithms/site-example-dataset.md` + `scripts/__tests__/site-example-dataset.algo.test.js` | algo doc + table test | DD-21 |
| `docs/knowledgebase/algorithms/README.md` | two rows | |
| `tests/scenarios/helpers/help-nav.ts` | nav reader for tests | DD-8 |
| `tests/scenarios/helpers/notice-hash.ts`, `tests/e2e/helpers/notice-hash.ts` | `NOTICE_PATH` → `user-docs/` | |
| `tests/scenarios/tours/screen-registry.ts` | `HELP`, rows | |
| `tests/scenarios/tours/tour-09-help-consent.spec.ts`, `tour-10-registry.spec.ts` | help steps | |
| `tests/e2e/help-modal.spec.ts` | default title | button name only |
| `tests/scenarios/platform/s-site-01.spec.ts` | site scenario | new feature |
| `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` | catalog row + `### S-SITE-01` section | like S-PLAT-01 |
| `docs/tasks/todo/2026-10-28-why-loghub-slides/wireframes/slide-opening-thesis.svg`, `slide-content-template.svg` | figures / dark-mode note | see Wireframes |

## Dependencies

- client `dependencies`: `rehype-slug` `^6.0.0` (brings `github-slugger` 2.x). Add rows to `user-docs/third-party-components.md` and `docs/third-party-components.md`.
- root `devDependencies`: `unified ^11.0.5`, `remark-parse ^11.0.0`, `remark-gfm ^4.0.1`, `remark-rehype ^11.1.2`, `rehype-slug ^6.0.0`, `rehype-stringify ^10.0.1`. Not shipped in `dist/` (dev-only), still listed in `docs/third-party-components.md` as build tooling.
- reveal.js 5.2.1 via jsDelivr (site only, not a package).

## Test coverage plan

Under the CLAUDE.md test policy (algorithm / API contract / scenario only):

- **Algorithm — new doc `docs/knowledgebase/algorithms/user-docs-links.md`** with an examples block for `resolveLink` (rows carry `href`, `fromFile` and a small inline nav: external, `#anchor`, `slug.md`, `slug.md#anchor`, `../hook/INSTALL_HOOK.md` from `user-docs/` → `install-hook`, `HOW_HOOK_WORKS.md` from `hook/INSTALL_HOOK.md` → `how-hook-works`, missing page, `../server/README.md`, image path) and `rewritePageLinks`; table test `scripts/__tests__/user-docs-links.algo.test.js` (runs under `npm run test:scripts`). `loadNav` takes a repo root, so the doc rows pass the nav inline and `resolveLink`/`rewritePageLinks` accept that `{ pages }` object.
- **Algorithm — new doc `docs/knowledgebase/algorithms/site-example-dataset.md`** with rows for `checkDataset` (consistent set, parts off by 0.01, daily mismatch, monthly mismatch) and `fillPlaceholders` (raw, `|usd`, `|usd0`, unknown path → error); table test `scripts/__tests__/site-example-dataset.algo.test.js`. `dataset.mjs` is ESM, so each CJS test body is `async` and loads it with `await import(pathToFileURL(...).href)`. Both docs follow the "Doc format" of `docs/knowledgebase/algorithms/README.md` (front matter `reviewed: no` / `reviewer: none`, sections Purpose, Code, Rules, Edge cases, Examples with one `examples` JSON block of `{ id, input, expected, note }` rows), which `scripts/__tests__/algo-docs.test.js` enforces.
- **API contract:** none (no routes change).
- **Scenario — extend `tests/scenarios/tours/tour-09-help-consent.spec.ts`** (mode A): default page H1 "Your first session"; menu section order per DD-2; clicking the install-hook link in `getting-started` switches the article and highlight; a `data-collection.md#what-is-collected` link (placed in `trust-model.md`) opens `data-collection` with the heading in view; external link has `target=_blank`; with `page.route` serving a modified `/help/getting-started.md` that contains `no-such-page.md` and `session-log.md#no-such-anchor` links: the first logs a `console.warn` and keeps the article, the second opens `session-log` at the top; with every non-stand request aborted (`context.route`) every menu page opens and `Download .md` count unchanged.
- **Scenario — extend `tests/scenarios/tours/tour-10-registry.spec.ts`**: nav.json slugs ↔ `user-docs/*.md` files plus `source` files exist; every page's relative links resolve (calls `links.js`).
- **Scenario — existing notice-hash helpers** keep the consent-hash steps green after the path change (hash stays `b5eac945`).
- **Scenario — new `tests/scenarios/platform/s-site-01.spec.ts`** (genuinely new feature; mode A; tag `@S-SITE-01`): builds the site into `tmp/scenarios/site/` with `build-site.mjs`, serves it with a Node `http` static server under `/artisyn-log-hub/`, then: every page reachable from top nav, crawl finds no 404, Home has thesis + 3 questions + deck/Features/Get started links, Features has six A–F entries, docs pages have TOC and repo/releases links, 375 px → no horizontal scroll and body ≥ 16 px, 1280×720 no overflow, `emulateMedia({ colorScheme: 'dark' })` changes background, deck: arrows move slides, `?print-pdf` renders, every content slide ≤ 3 bullets and ≤ 40 body words, 10–15 slides; requests only to the local server or `cdn.jsdelivr.net` with versioned URLs; artifact grep finds no e-mail, `C:\`/`/Users/`/`/home/` path; every figure block has the illustrative label.
- **Legacy e2e `tests/e2e/help-modal.spec.ts`**: only the default-article button name changes to "Your first session" (no new spec).

## Visual/UX notes

- HelpModal layout, colours and sizes unchanged; only menu content, default page, link behaviour (`↗` after external links) change.
- Site: max content width 760 px for docs text; three-column docs layout ≥ 1024 px, sidebar collapses under a "Menu" button < 768 px; TOC hidden < 1024 px. Body 16 px / line-height 1.6; headings in accent navy. Visual slots are bordered placeholders (`aspect-ratio`, no screenshots) so a screenshot can be dropped in later.
- Deck: white slide on light-grey stage (dark: `#111827` slide on `#0b1220`), headline 40 px, bullets 26 px, key figure 72 px accent; footer site URL + `n / N` (reveal `slideNumber: 'c/t'`). Columns stack < 600 px.

## Wireframes

- `slide-opening-thesis.svg`: replace figures with dataset values `$2,880 / month`, `$144 / day`, `$8 / session` (DD-21; the old $2,900/$140 do not divide into whole sessions/days).
- `slide-content-template.svg` note 6: "Light theme only" → "Light theme; dark via prefers-color-scheme (FR-3)".

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Page set move + link module + generator | 7 | foundation; everything reads `user-docs/` |
| 2 | Build-path wiring | 7 | needs chunk 1 generator |
| 3 | Site renderer | 8 | needs chunk 1 `links.js` |
| 4 | User-doc content from README | 7 | needs chunk 1 files; validated by chunks 1–3 tools |
| 5 | README + repoints + KB | 7 | needs chunk 4 pages |
| 6 | In-app help client | 6 | needs alias from chunk 2 |
| 7 | Site content + dataset | 5 | needs chunk 3 renderer |
| 8 | Deck + workflows + wireframes | 6 | needs chunk 7 theme/dataset |
| 9 | Tests — algorithm docs | 5 | needs chunks 1, 3 |
| 10 | Tests — help scenarios | 8 | needs chunks 2, 4, 6 |
| 11 | Tests — site scenario | 6 | needs chunks 3, 7, 8 |

### Chunk 1 — Page set move + link module + generator
- [ ] Move all 14 files from `client/public/help/*.md` to `user-docs/` unchanged (file tools, no git commands); verify `data-collection-notice.md` bytes are identical.
- [ ] Create `user-docs/nav.json` per DD-1 / DD-2; create `install-server.md`, `authentication-modes.md`, `server-configuration.md`, `trust-model.md` in `user-docs/` as stubs holding only their H1 (filled in chunk 4).
- [ ] Add `client/public/help/` to `.gitignore` (DD-9).
- [ ] Create `scripts/user-docs/links.js` exporting `loadNav`, `resolveLink`, `findLinks`, `rewritePageLinks` per DD-3 (CJS, built-ins only, header comment naming algorithm doc `user-docs-links`).
- [ ] Create `scripts/user-docs/links.d.ts` declaring the four exports and the nav/page/result types of DD-3.
- [ ] Create `scripts/user-docs/generate-help.js` per DD-4 (nodejs-script skill: CJS, sync, `path.join`, stderr diagnostics, exit codes; `--out`, `--check`).
- [ ] Run the generator; confirm 20 files in `client/public/help/`, exit 0, and `data-collection-notice.md` byte-identical to the source.

### Chunk 2 — Build-path wiring
- [ ] Root `package.json`: add `"build:help": "node scripts/user-docs/generate-help.js"`; insert `npm run build:help &&` before `npm run build:client` in `build:serial` (DD-5).
- [ ] `scripts/build.js`: `await run('build:help')` after `build:clean`, before the `Promise.all` block; mention it in the header comment.
- [ ] `client/package.json`: add `prebuild` and `predev` scripts per DD-5.
- [ ] `Dockerfile` client-build stage: add the three `COPY` lines per DD-6 before `COPY client/ ./`, with a one-line comment.
- [ ] `scripts/scenarios/build-stand.mjs`: add `'user-docs'` to `INPUT_DIRS`; `'scripts/user-docs/generate-help.js'`, `'scripts/user-docs/links.js'` to `BUILDER_FILES`; `step('generate help', node, [<generator path>], ROOT)` before `vite build`.
- [ ] Add the `@loghub/user-docs` alias to `client/vite.config.ts` (`resolve.alias` + `server.fs.allow`) and `client/tsconfig.json` (`paths` + `include`) per DD-7.
- [ ] Run `npm run build` in the background; confirm `dist/public/help/install-hook.md` and `data-collection-notice.md` exist.

### Chunk 3 — Site renderer
- [ ] Root `package.json`: add the root devDependencies listed under Dependencies and `"build:site": "node scripts/site/build-site.mjs"`; run `npm install`.
- [ ] Add rows for `unified`, `remark-parse`, `remark-gfm`, `remark-rehype`, `rehype-slug`, `rehype-stringify` (build tooling, not shipped) to `docs/third-party-components.md`.
- [ ] Create `scripts/site/dataset.mjs` with `checkDataset` and `fillPlaceholders` per DD-21 (no top-level `await`; header comment naming algorithm doc `site-example-dataset`).
- [ ] Create `scripts/site/layout.mjs` with the DD-19a constants and `page(...)` per DD-20 (relative prefix from `depth`; nav, docs sidebar, TOC, prev/next, footer).
- [ ] Create `scripts/site/build-site.mjs` per DD-19: `--out` guard, empty only its own output dir, link validation via `links.js`, each nav page → `docs/<slug>.html`, `{{RETENTION_DAYS}}` substitution (DD-16); ESM exemption stated in the header comment.
- [ ] In `build-site.mjs`: wrap `site/pages/home.html` → `index.html` and `features.html`; fill `{{ds:…}}` and `{{site:…}}` placeholders there and in `site/deck/index.html`; copy `site/assets/` and `site/deck/`; exit 1 on any dataset, placeholder or link error.
- [ ] Create minimal placeholder inputs (replaced in chunks 7–8): `site/pages/home.html` and `features.html` (one heading each), `site/deck/index.html` (one `{{site:url}}` line), `site/data/example-dataset.json` per DD-21.
- [ ] Run `npm run build:site`; confirm `tmp/site/docs/*.html` render with heading ids and TOC and the placeholders are filled.

### Chunk 4 — User-doc content from README
- [ ] Write `user-docs/install-server.md` from README Quick start + Other ways to run (release install, source build, Docker image, check you are the admin); drop contributor-only links such as `server/README.md`.
- [ ] Write `user-docs/authentication-modes.md` from README "Authentication modes"; reduce `security-hardening.md` §3.1 to a pointer to `authentication-modes.md` (DD-10).
- [ ] Write `user-docs/server-configuration.md` from README "Configuration"; verify every env var name/default against `server/.env.example` (DD-22).
- [ ] Write `user-docs/trust-model.md` from README "Trust model", including a link `data-collection.md#what-is-collected` (used by tour-09).
- [ ] Merge README "Security notes" into `security-hardening.md` and README "What is collected" into `data-collection.md` under `## What is collected` (DD-10).
- [ ] `getting-started.md`: H1 → "Your first session"; replace "Installing the Hook" with one sentence linking `../hook/INSTALL_HOOK.md`. `connect-repository.md`: Step 1 → the same one-sentence link (DD-3, DD-10).
- [ ] Run `node scripts/user-docs/generate-help.js --check` and `npm run build:site`; fix every unresolved link until both exit 0.

### Chunk 5 — README + repoints + KB
- [ ] Rewrite `README.md`: pitch per DD-25 under the title, then badges, description, disclaimer, one-line warning linking `user-docs/data-collection.md#what-is-collected`, quick start (commands only, each followed by a link to `user-docs/install-server.md` or `hook/INSTALL_HOOK.md`), links to section pages; keep Repository layout, For developers, Licence; delete moved sections.
- [ ] Repoint `client/public/help/` edit-target references to `user-docs/` in `client/README.md`, `docs/third-party-components.md` (~25, ~169), `.claude/skills/security-check/SKILL.md:39`; in `docs/qaa-overview/scenarios/06-ui-tab-walk.md` also update the section list (~100) to DD-2's five sections and the file count (~183) to 20.
- [ ] Update KB: `client-routing-and-layout.md` (HelpModal default, link handler, nav source), `client-component-map.md` (`viewer/help/`, generated `public/help/`), `release-pipeline.md:40`, `legacy-design-decisions-map.md:56`, `user-account-flows.md:98`, `db-tables.md:1212`, `authorization-and-authentificaiton.md:128`.
- [ ] Update `repo-local-packages.md` (`@loghub/user-docs` alias) and `static-asset-serving.md` (`/help/*.md` generated); add CLAUDE.md command-table rows for `build:help` / `build:site` per DD-5a.
- [ ] Create `docs/knowledgebase/user-docs-and-site.md` (OKF front matter): page set, nav.json, DD-3 link rules, generator and its build paths, site renderer/output, dataset placeholders, deck, `pages.yml`, owner step (Settings → Pages → Source: GitHub Actions).
- [ ] Add the new article to `docs/knowledgebase/index.md`.
- [ ] Grep tracked files (excluding `docs/tasks/`, `docs/changelog/`) for `client/public/help/`; every remaining hit must describe generated output.

### Chunk 6 — In-app help client
- [ ] `client/src/viewer/help/articles/index.ts`: drop the inline `helpNav` array, import `@loghub/user-docs/nav.json`, add `source?: string` to `HelpArticle`, keep `helpDownloadFileName` (DD-7).
- [ ] `bun add rehype-slug@^6.0.0` in `client/`; add rows for `rehype-slug` and `github-slugger` to `user-docs/third-party-components.md` and `docs/third-party-components.md`.
- [ ] Create `client/src/viewer/help/help-links.ts` with `parseHelpHref(href, knownSlugs)` returning `external | anchor | page | unknown` per DD-14.
- [ ] Create `client/src/viewer/help/HelpMarkdownLink.tsx` rendering `<a>` per DD-14 (internal → `preventDefault` + `onNavigate`; unknown → `console.warn`; external → new tab + ` ↗`).
- [ ] `HelpModal.tsx`: `DEFAULT_HELP_SLUG = 'getting-started'` (DD-13), `rehypePlugins={[rehypeSlug]}`, `components={{ a }}`, `pendingAnchor` state, content-pane ref and scroll effect per DD-15.
- [ ] `client/src/viewer/lib/notice-hash.ts`: repoint the comment to `user-docs/data-collection-notice.md`; run client lint and typecheck.

### Chunk 7 — Site content + dataset
- [ ] Finalise `site/data/example-dataset.json` exactly per DD-21 (all fields); confirm `checkDataset` returns no errors.
- [ ] Create `site/assets/theme.css` (tokens, light + dark palettes per DD-17, layout per Visual/UX notes, `.illustrative` label, visual-slot placeholder) and `site/assets/site.js` (menu toggle).
- [ ] Write `site/pages/home.html` per `wireframes/site-home.svg`: hero "This session cost {{ds:session.total|usd0}}. Is that good?", DD-22a thesis, three question cards (A, B, C–E of DD-22b) → `features.html#a|#b|#c`, buttons to `docs/install-server.html` and `deck/index.html`, illustrative label.
- [ ] Write `site/pages/features.html`: sections `#a`–`#f` from DD-22b, each with question, what it shows, where in the app; facts per DD-22; illustrative label on any dataset figure.
- [ ] Run `npm run build:site`, serve `tmp/site` locally under `/artisyn-log-hub/`, visually check Home, Features and two docs pages at 1280 px and 375 px, light and dark (use-playwright skill).

### Chunk 8 — Deck + workflows + wireframes
- [ ] Create `site/deck/index.html` with reveal.js 5.2.1 tags and SRI per DD-23 (sha384 computed with `node:crypto` from the fetched files) and `site/deck/deck.css`; add a reveal.js 5.2.1 (MIT, site only) row to `docs/third-party-components.md`.
- [ ] Write the 13 slides per DD-24 from DD-22b, with dataset placeholders, illustrative labels on figure slides, unpicked DD-22b items as speaker notes; slide 2 = DD-22a per `wireframes/slide-opening-thesis.svg`.
- [ ] Check every content slide (one headline sentence, ≤ 3 bullets, ≤ 40 body words); arrows, `S`, `?print-pdf` work from the local server.
- [ ] Create `.github/workflows/pages.yml` per DD-26.
- [ ] `.github/workflows/checks.yml`: add the "user docs and site" step per DD-5 after the root `npm ci --ignore-scripts`.
- [ ] Update `wireframes/slide-opening-thesis.svg` figures and `wireframes/slide-content-template.svg` note 6 per Wireframes.

### Chunk 9 — Tests — algorithm docs
- [ ] Write `docs/knowledgebase/algorithms/user-docs-links.md` (README "Doc format") with rows for `resolveLink` and `rewritePageLinks` per Test coverage plan.
- [ ] Create `scripts/__tests__/user-docs-links.algo.test.js` modelled on `release-version.algo.test.js` (`loadExamples('user-docs-links')`, call `input.fn` of `scripts/user-docs/links.js` with `input.args`).
- [ ] Write `docs/knowledgebase/algorithms/site-example-dataset.md` with rows for `checkDataset` and `fillPlaceholders` per Test coverage plan.
- [ ] Create `scripts/__tests__/site-example-dataset.algo.test.js` with async tests importing `scripts/site/dataset.mjs` via `await import(pathToFileURL(...).href)`; thrown errors compared as `{ error: <message> }`.
- [ ] Add both docs as rows to `docs/knowledgebase/algorithms/README.md`; run `npm run test:scripts`.

### Chunk 10 — Tests — help scenarios
- [ ] Create `tests/scenarios/helpers/help-nav.ts` per DD-8.
- [ ] `tests/scenarios/helpers/notice-hash.ts:18` and `tests/e2e/helpers/notice-hash.ts:22-25`: `NOTICE_PATH` → `user-docs/data-collection-notice.md`.
- [ ] `tests/scenarios/tours/screen-registry.ts`: `HELP = 'user-docs'`; add the six new slugs to `HELP_ARTICLES` with their real H1s (DD-11); `getting-started` H1 "Your first session"; `docRef` of `install-hook`/`how-hook-works` → `hook/INSTALL_HOOK.md`/`hook/HOW_HOOK_WORKS.md`.
- [ ] `screen-registry.ts` rows `auth.login.none` (~152) and `admin.auth` (~314): `docRef` → `user-docs/authentication-modes.md` with its real H2; the row at ~463 (`connect-repository.md` "Step 1 — Install the hook") → `hook/INSTALL_HOOK.md` with its real install heading.
- [ ] `tour-10-registry.spec.ts`: import from `helpers/help-nav`; compare nav slugs with `user-docs/*.md` + `source` files; add a step asserting every page's relative links resolve; update header comment `:12`.
- [ ] `tour-09-help-consent.spec.ts`: import from `helpers/help-nav`; add the steps listed in Test coverage plan (default page, section order, internal link, anchor link, external target, unknown-slug and missing-anchor via `page.route`, offline pass).
- [ ] `tests/e2e/help-modal.spec.ts:22`: button name → 'Your first session'.
- [ ] Run `npm run typecheck:tests` and `npm run test:scenarios -- --mode a --only scenarios --grep "@TOUR-09|@TOUR-10"`.

### Chunk 11 — Tests — site scenario
- [ ] Add a catalog row and a `### S-SITE-01` section (steps per Test coverage plan) to `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md`, like S-PLAT-01.
- [ ] Create `tests/scenarios/platform/s-site-01.spec.ts` (mode A, tag `@S-SITE-01`, header pointing at §S-SITE-01): build via `build-site.mjs --out tmp/scenarios/site`, serve with Node `http` under `BASE_PATH` (DD-19a).
- [ ] Add site steps: top-nav reachability on non-deck pages, link crawl without 404, Home/Features content, TOC + repo/releases links, dark mode, 375 px / 1280×720 layout, only versioned `cdn.jsdelivr.net` external requests.
- [ ] Add deck steps: 10–15 slides, arrow navigation, `?print-pdf` renders, per-content-slide bullet/word limits, illustrative label on figure blocks, artifact grep for e-mails and absolute local paths.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SITE-01"` and fix failures.
- [ ] Write `docs/changelog/<YYYY-MM-DD-HHmm>-why-loghub-slides.md` per the `changelog` skill.
