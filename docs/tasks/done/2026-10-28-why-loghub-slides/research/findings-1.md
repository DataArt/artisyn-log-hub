# Research findings 1 — 2026-10-29

**Requirements summary**
The task builds a static product site in a new top-level `site/` folder, published to `https://dataart.github.io/artisyn-log-hub/` by a new `.github/workflows/pages.yml`. The site has Home, Features (blocks A–F), Get started, Configuration, Using Log Hub, Data and security, and a reveal.js 5.x "Why Log Hub" deck at `site/deck/` with 10–15 slides for a C-level audience.

The site's docs pages and the in-app help come from one page set in a new `user-docs/` folder, driven by `user-docs/nav.json`. A Node generator writes the gitignored `client/public/help/*.md` from it in every build path: client prebuild/predev, `scripts/build.js`, Docker, the scenario stand and CI. A second Node script pre-renders the site pages with unified/remark/rehype. HelpModal gains an internal-link handler, anchors and a `getting-started` default.

The README is cut down to a pitch block of at most 8 lines placed above the badges, a minimal quick start and links into `user-docs/`. Its install, configuration and data/security sections move to `user-docs/` pages. All numbers come from one fictional `site/data/example-dataset.json` and carry an "Illustrative example" label. Product facts are checked against the code. The README, Home and slide 2 share one thesis: cost control is right, but "$8 per session" alone says nothing.

**Wireframes** (all in `wireframes/`, all referenced)
- `site-home.svg`: top nav (Home, Features, Get started, Configuration, Using Log Hub, Data & security, Deck, GitHub ↗).
  - Hero "This session cost $8. Is that good?" with "Get started" and "Why Log Hub (deck)" buttons.
  - Three question cards linking to Features → A / B / C,D,E; a visual slot; a footer (MIT · GitHub · Releases · not affiliated).
  - Phone 375 px: nav collapses to a menu, single column.
- `site-docs-page.svg`: three columns — section sidebar from nav.json (with Changelog), page text, and an "On this page" TOC from h2/h3. Prev/next links.
  - Phone: one column, nav in a menu. The diagram shows `user-docs` → generator → `/help/<slug>.md` plus the site pages.
- `in-app-help-menu.svg`: today's modal unchanged. The menu becomes GET STARTED / CONFIGURATION / USING LOG HUB / DATA AND SECURITY / CHANGELOG, with NEW badges on 6 pages.
  - "Your first session" is the default page.
  - An internal `install-hook.md` link switches the article and moves the menu highlight; `slug.md#anchor` works; external links open a new tab marked ↗.
  - Download .md appears only on `downloadable` pages, with the file name `artisyn-log-hub-install-hook.md`.
- `slide-opening-thesis.svg`: slide 1 is the title. Slide 2 has three columns: "You already control" ($2,900 / month, $140 / day, $8 / session, ✓), "The number does not say" (4 questions) and "Log Hub answers". Footer shows the site URL and `n / N`.
  - Palette: text `#111827`, secondary `#374151` / `#6b7280`, navy accent `#1e3a5f`, white slide on a light grey stage.
- `slide-content-template.svg`: block marker top-left, P/A–F progress pills top-right, a one-sentence headline, at most 3 bullets, one key figure ("78% … re-reading context") and a 464×300 visual slot. Columns stack on a phone.
  - Note 6 says "Light theme only", which conflicts with FR-3's dark mode via `prefers-color-scheme`. The requirements win.
- `deck-storyline.svg`: Title, Problem, then A (3 candidate slides), B (3), C (2), D (3), E (2), F (2). That is 17 candidates, more than the 15-slide cap, so pick the strongest.
- `readme-first-screen.svg`: title, then the dashed pitch block (thesis, 3 bullets, a links line "Docs (user-docs/) · Site · Deck"), then badges, description, disclaimer, the "Read What is collected" warning and a minimal Quick start.
- Features page: no wireframe exists (stated in Notes).
- The wireframe figures do not divide evenly:
  - $2,900 / $140 = 20.714… days.
  - $2,900 / $8 = 362.5 sessions.
  - $140 / $8 = 17.5 sessions.
  - The dataset has to choose numbers that are consistent (FR-7).

**Knowledgebase**
- `docs/knowledgebase/repo-local-packages.md`: the alias pattern FR-2 cites. Each alias goes in two places: `client/vite.config.ts` `resolve.alias` plus `server.fs.allow`, and `client/tsconfig.json` `paths` plus `include`. Docker `COPY packages/` before the client.
- `docs/knowledgebase/client-routing-and-layout.md:234` (HelpModal: lazy from MainNav, fetches `/help/<slug>.md`, default = first nav entry) and `:40`: the notice-hash consent. Both need updating.
- `docs/knowledgebase/client-component-map.md:74-86`: the `viewer/help/` and `public/help/` entries need updating.
- `docs/knowledgebase/static-asset-serving.md:132`: `/help/*.md` is served with revalidation (not immutable). `.md` is in the precompress allowlist (`client/scripts/precompress.cjs:34`), so the generated files are precompressed automatically.
- `docs/knowledgebase/release-pipeline.md:40`: points at `client/public/help/third-party-components.md`; repoint it. CI uses `node-version: 24`.
- `docs/knowledgebase/ci-security-scans.md:48,79-85,132-133`: the `workflow-lint` job runs actionlint and zizmor, report-only, with one retry. `pages.yml` is scanned automatically.
- `docs/knowledgebase/algorithms/README.md`: the doc-driven table-test pattern. Under the CLAUDE.md test policy, a script test is only allowed as an algorithm doc plus a `*.algo.test.js` (for example link rewrite/resolution and the nav-to-slug mapping).
- `docs/knowledgebase/test/scenarios.md` and `test/index.md`: tours, screen-registry and stand conventions.
- `docs/knowledgebase/algorithms/tool-usefulness-signals.md:33-35`: the signals are only `empty`, `retried`, `opened_file`. **`fell_back` was removed** (commit d89d7e0).
- `docs/knowledgebase/tool-monitoring.md`: the Tools/MCP tab is **shipped**. T-26 (`2026-06-19-mcp-invocation-log-tab`) is in `docs/tasks/done/`, and `tools` is in `REPO_MAIN_TABS` (`client/src/viewer/tab-ids.ts:43`).
- `docs/knowledgebase/authorization-and-authentificaiton.md`, `data-retention.md`, `hook-installation.md`: fact sources for the new authentication-modes, server-configuration and install pages.
- `docs/knowledgebase/legacy-design-decisions-map.md:56` (T-25 help modal row), `user-account-flows.md:98`, `db-tables.md:1212`: they mention `client/public/help/…` as the place to edit; repoint them.
- `docs/knowledgebase/index.md`: add the new page-set/generator KB article here.

**Existing patterns**

*In-app help*
- `client/src/viewer/help/articles/index.ts:1-73`: the `HelpArticle {slug,title,downloadable?}` and `HelpSection {section,articles}` types, `helpNav` and `helpDownloadFileName` (`artisyn-log-hub-<slug>.md`). Today there are 4 sections and 14 slugs.
- `client/src/viewer/help/HelpModal.tsx:15-16`: `defaultSlug = allArticles[0]`. Replace it with a `getting-started` constant.
  - `:39`: `fetch('/help/${slug}.md')` (root-absolute, fine in the app).
  - `:96-107`: Download .md.
  - `:109`: `<ReactMarkdown remarkPlugins={[remarkGfm]}>`. There is no `components.a` and no rehype plugin yet. `rehype-slug` and `github-slugger` are not in `client/bun.lock`, so they would be new client deps (and new rows in third-party-components).
- `client/src/viewer/pages/main/MainNav.tsx:15-16,99`: lazy HelpModal.
- `client/src/viewer/lib/notice-hash.ts:7,17`: `NOTICE_URL = '/help/data-collection-notice.md'`; the comment needs repointing.
  - The current notice hash, computed with the FNV-1a code, is **`b5eac945`**. It is the same for CRLF and LF because the text is normalised.
  - The working copy is CRLF (index LF, 3941 bytes CRLF). The generator only has to keep the trimmed LF text identical.

*Tests that read help files*
- `tests/e2e/helpers/notice-hash.ts:22-25` and `tests/scenarios/helpers/notice-hash.ts:18`: `NOTICE_PATH` points at `client/public/help/data-collection-notice.md`; change it to `user-docs/`.
- `tests/scenarios/tours/screen-registry.ts:119`: `const HELP = 'client/public/help'`. It is used in about 25 `docRef`s.
  - `:974-1002`: `HELP_ARTICLES` [slug, H1] → `HELP_ROWS`. Add the 6 new slugs (`install-server`, `install-hook`, `authentication-modes`, `server-configuration`, `trust-model`, `how-hook-works`) and change the `getting-started` H1.
  - For `install-hook` and `how-hook-works` the `docRef` must point to `hook/INSTALL_HOOK.md` / `hook/HOW_HOOK_WORKS.md`.
  - Those H1s are "Install Telemetry Hook" and "How the Telemetry Hook Works", not the nav titles.
- `tests/scenarios/tours/tour-10-registry.spec.ts:37,41,91-99`: compares `helpNav` slugs with `readdirSync(client/public/help)`. Change it to nav.json against `user-docs/*.md` plus `source` files.
  - Header comment at `:12`. It imports only "pure constant modules" (DD G3).
- `tests/scenarios/tours/tour-09-help-consent.spec.ts:23-27,51-70`: opens every help row by its nav title and checks H1 and Download count. This is **the scenario to extend** with steps for the default page, an internal link switch, an anchor, an unknown slug, an external link and offline.
- `tests/e2e/help-modal.spec.ts:22`: a legacy spec that clicks the button named 'Getting Started'. It breaks on the retitle.

*Build paths*
- `client/package.json` scripts: `"build": "vite build && node scripts/precompress.cjs"`, `"dev": "vite"`.
  - There is no prebuild/predev yet. I checked that bun 1.3.14 runs `prebuild`/`predev` for `bun run build`/`bun run dev`.
  - `client/scripts/precompress.cjs:7-12` explains why a client build step lives under `client/scripts/`: the Docker stage only copies `client/`. That is the rationale to reconsider, since the Dockerfile will now copy `user-docs/`.
- `scripts/build.js:47-59`: `build:clean` → parallel {hooks-installer, `build:client`, `build:server`} → `build:assets`. The generator goes as an ordered step before `build:client`; `run(script)` calls npm scripts.
- `scripts/scenarios/build-stand.mjs:36`: `INPUT_DIRS` (add `user-docs`; `hook` is already there).
  - `:38-43`: `BUILDER_FILES` (add the generator).
  - `:154-156`: calls `vite build` **directly, not `bun run build`**, so prebuild does not fire. Call the generator explicitly there.
- `Dockerfile:5-11` (client-build stage): `COPY packages/` then `COPY client/ ./` then `bun install --frozen-lockfile && bun run build`, on `node:24.22.1-slim` with bun.
  - Add `COPY user-docs/`, `hook/INSTALL_HOOK.md`, `hook/HOW_HOOK_WORKS.md` and the script. Paths are relative to `/app`.
  - The stage has no root `node_modules`, so the help generator must use Node built-ins only.
  - `.dockerignore` does not exclude these.
- `.github/workflows/checks.yml:47-81`: `npm ci --ignore-scripts`, then client/server installs and typechecks/tests. It does not build the client.
  - Pins: checkout `3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, setup-node `949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`, `node-version: 24`, `persist-credentials: false`, `permissions: contents: read`, `package-manager-cache: false`.
  - Root `package.json` has `"prepare": "node scripts/install-git-hooks.js"`, so `pages.yml` should use `npm ci --ignore-scripts` like checks.yml.

*Build-installer consumers (unchanged)*
- `scripts/build-hooks-installer.js:12,498`: reads `hook/INSTALL_HOOK.md` for the event drift check.
- `scripts/__tests__/build-hooks-installer.test.js` and `tests/scenarios/installer/s-inst-01.spec.ts:308-310` also stay unchanged.

*Script conventions*
- `scripts/__tests__/release-version.algo.test.js:1-21`: the `node --test` algo-doc table test template (`loadExamples('<doc>')`).
- `.claude/skills/nodejs-script/SKILL.md`: CommonJS, sync, built-ins only. The site renderer needs unified/remark, which is ESM-only. Precedents for an exemption:
  - `scripts/build.js:10-15` documents its own async exemption.
  - `scripts/scenarios/*.mjs` are ESM.
  - Node 24 can `require()` ESM, and unified has `processSync`.
  - Root `package.json` has no `"type"`. The remark versions in the client are remark-gfm 4.0.1, remark-parse 11.0.0, remark-rehype 11.1.2, unified 11.0.5.
- `scripts/docs-sensitive-scan.js:1-40`: existing rules for personal-mail, local-path and private-IP patterns. They can be reused for the FR-7 "no private data in the artifact" grep.

*FR-7 fact sources*
- `client/src/viewer/pages/repository/reports/report-catalog.ts:65-276`: **17 reports**. Summary 1, Activity 4, Code 2, Cost 4, Productivity 2, Harness 2, Attributes 2.
  - **All 17 are PDF-exportable**: 12 through `ReportDocumentShell`'s "Download as PDF", and Tool Analytics, Token Usage, Active Sessions, Productivity Counters and Claude Code Version Usage through `UsageReportDocument.tsx:166-171`. The inventory's "most PDF-exportable" is inaccurate.
- `client/src/viewer/pages/repository/session-log/summary/detectors/registry.ts:34+`: **7 detector ids**: `context-compression`, `context-ceiling-pressure`, `low-cache-read-ratio`, `change-surface-spread`, `change-surface-modules`, `change-surface-single-file-folders`, `claude-version`.
  - `change-surface-shared.ts` is a helper module, **not a detector id**; the inventory lists it wrongly.
- `server/.env.example:93`: `SESSION_RETENTION_DAYS=30`, which matches "default 30 days".
  - `:104`: `AUTH_MODE=password-confirm`.
  - `:106`: `PASSWORD_POLICY=long`.
  - `:133-150`: `SMTP_*` and `AZURE_*`.

*Content sources to move into `user-docs/`*
- `README.md` (314 lines), by section line: Quick start `:30` (admin check `:59`, hook `:71`), Other ways to run `:83` (source `:85`, Docker `:108`), Authentication modes `:128`, Configuration `:141`, What is collected `:160`, Trust model `:209`, Security notes `:229`.
  - These stay: For developers `:253`, Licence `:311`, Repository layout `:18`.
  - Badges are at `:3-4`.
- `client/public/help/security-hardening.md:46` (§3.1 "Authentication modes (`AUTH_MODE`)") **overlaps the new `authentication-modes` page**; deduplicate under FR-2.
- `client/public/help/getting-started.md:11` ("## Installing the Hook") and `connect-repository.md:12` ("## Step 1 — Install the hook") overlap the new `install-hook`; deduplicate.
- The only relative links in today's sources:
  - `hook/INSTALL_HOOK.md:495,682` link to `HOW_HOOK_WORKS.md`.
  - `hook/HOW_HOOK_WORKS.md:3` links to `INSTALL_HOOK.md`.
  - The rest are same-page anchors.
  - The two hook files are file names, not slugs. The generator and the site renderer must map a `source` file name to its slug (`how-hook-works`, `install-hook`), because the hook files stay unchanged.
  - `INSTALL_HOOK.md:9` has one external link (nodejs.org, an optional extra).
  - `component-reference.md`, `security-hardening.md` and both hook files contain raw HTML-like tags; these will not render (no rehype-raw).

*Repoint targets* (edit `client/public/help/` → `user-docs/`): `.claude/skills/security-check/SKILL.md:39`, `client/README.md:49`, `docs/third-party-components.md:25,169`, the KB lines listed above, and `docs/qaa-overview/scenarios/06-ui-tab-walk.md:100,183` (non-KB, optional).

**Open gaps**
1. **The alias import breaks the Node-side test imports.** `tests/tsconfig.json` has no `paths` and no `resolveJsonModule`. tour-09 and tour-10 import `client/src/viewer/help/articles/index.ts` as a pure module (DD G3), and none of today's pure modules imported by tests use an alias. If `index.ts` imports nav.json through a Vite/tsconfig alias, both Playwright and `npm run typecheck:tests` likely fail. Options: a relative JSON import, tests reading `user-docs/nav.json` directly, or adding `paths`/`resolveJsonModule` to `tests/tsconfig.json`.
2. **Script-test kind.** FR-2 says the site script is "tested by `npm run test:scripts`", but the CLAUDE.md test policy allows only algorithm-doc table tests there. The plan needs a new `docs/knowledgebase/algorithms/<x>.md` (link resolution and rewrite, the source-file-to-slug map, `{{RETENTION_DAYS}}` substitution) plus `scripts/__tests__/<x>.algo.test.js`.
3. **Module format of the generators.** The help generator must be built-ins only, because the Docker client stage has no root deps. The site renderer must use the unified/remark ESM packages. The plan must document the nodejs-script exemption (CJS with `require(esm)` and `processSync`, or `.mjs`). Also decide where the help generator lives (`scripts/` or `client/scripts/`) so the Docker `COPY` paths work.
4. **Fact corrections the plan must make:**
   - `fell back` is gone; signals are `empty`, `retried`, `opened file`.
   - All 17 reports export to PDF.
   - `change-surface-shared` is not a detector.
   - Tools/MCP (T-26) is already shipped, so the go-live dependency in Notes is already met.
5. **Deduplication** under the "no text twice" AC: `security-hardening.md` §3.1 against `authentication-modes`, and `getting-started.md` / `connect-repository.md` install steps against `install-hook`. No decision exists on which text survives.
6. **H1 versus nav title** for `install-hook` and `how-hook-works`. The hook files' H1s differ from the nav titles, and the tour-09 rows check the H1. Changing those H1s would touch the hook sources, which FR-2 keeps unchanged.
7. **HelpModal link handling has no precedent in the client.** That covers the `components.a` override, scroll-to-anchor inside the modal pane, rehype-slug in ReactMarkdown, and the unknown-slug `console.warn`. The tour walker may treat console warnings as failures; check that.
8. **The site renderer and theme are entirely new.** There is no static-site tooling, no reveal.js vendoring or SRI pattern, and no `site/` folder in the repo. A "no 404 inside the site", 375 px and 1280×720 layout check also has no harness; decide whether it is a scenario step or a script.
9. **The legacy e2e `tests/e2e/help-modal.spec.ts:22`** clicks 'Getting Started'. Either update it (legacy specs are frozen by policy) or accept that it gets replaced.
10. **`.gitignore` entry** for `client/public/help/*.md`. `.gitignore` has no such entry today; the tracked files would need `git rm --cached`, which the owner runs because git writes are not allowed to the agent.
11. **The wireframe figures are not mutually consistent** ($2,900 / $140 / $8). The dataset must pick totals that are.
