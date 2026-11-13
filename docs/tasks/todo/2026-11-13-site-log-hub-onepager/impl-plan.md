# Implementation plan — 2026-11-13 Site One-Pager (log-hub-onepager)

## TL;DR

- New standalone site page `site/log-hub-onepager/` (`index.html` + `onepager.css`) → built to
  `log-hub-onepager/index.html`; one landscape screen at 1280 × 720, one landscape PDF page at A4
  and at Letter.
- `scripts/site/build-site.mjs`: the deck loop gets one more standalone folder; no new function,
  no new validation rule (the deck's title / description / placeholder checks apply as they are).
- Links to the page: top nav item "One-pager" after "Deck" (`layout.mjs`), a Home hero button, a
  fifth link on the deck's closing slide.
- Tests: only the existing scenario `@S-SITE-01` is extended (changed steps + one new step 20).
- No new npm package, no server / client / hook / DB / API change. Site-only; the product and the
  in-app help do not depend on it.

## Reference

- Requirements: [requirements.md](requirements.md)
- Checked before planning: [research/pdf-page-count.md](research/pdf-page-count.md)
- KB: `docs/knowledgebase/user-docs-and-site.md` (site renderer, deck, study sources, shots)

## Design Decisions

- **DD-1 Build.** The page is a third entry of the standalone loop in `build-site.mjs:371`
  (`[site/log-hub-onepager, 'log-hub-onepager', fill = true]`). That gives it placeholder filling,
  the `<title>` / `<meta name="description">` checks, the shared description validation and the
  sitemap entry (`canonicalUrl` → `…/log-hub-onepager/`) with no other code.
- **DD-2 Own stylesheet.** Page rules live in `site/log-hub-onepager/onepager.css` (like
  `deck/deck.css`), loaded after `../assets/theme.css`; `theme.css` is not changed. Class prefix
  `op-`.
- **DD-3 One layout, scaled.** Every size on the sheet is in `em` relative to `.op-sheet`
  (`font-size: 16px` on screen). Print sets `.op-sheet { font-size: 12px }`: the printable area at
  10 mm margins is ≈ 1047 × 718 px (A4 landscape) and ≈ 980 × 740 px (Letter landscape), i.e. the
  1280 × 720 layout at 0.75. `body` keeps the theme's 16 px.
- **DD-4 Print is light.** Checked: an emulated dark scheme stays active in print unless the
  tokens are re-declared. `onepager.css` repeats the light `:root` color tokens of `theme.css`
  (lines 8–29 and `--frame-bg`) under `@media print { :root { … } }`. Blocks are separated by
  borders, never by a fill, so the sheet reads with background graphics off.
- **DD-5 Screenshot.** `site/assets/shots/spend-budget.png` (743 × 570), caption
  `Repository → Spend`: budget bar, burn rate, forecast, daily spend.
- **DD-6 Study figure.** The one already on Home: "up to five times" (UC Berkeley and Arena,
  2026), in its own sentence. First thing to drop if the sheet does not fit (FR-3 order).
- **DD-7 One-page test.** `page.pdf({ format, landscape: true })` and a regex count of
  `/Type /Page` objects (checked: exact for 1–3 pages, A4 and Letter). No PDF library.
- **DD-8 Local link form.** Links to the page use `log-hub-onepager/index.html` (like
  `deck/index.html`), so the site still works from a plain static server. The four links printed
  on the sheet are absolute (`{{site:…}}`).
- **DD-9 Scenario page lists.** In `s-site-01.spec.ts`, `pages` (width checks) stays "every
  non-deck page", so the one-pager is in steps 7 and 8; a new `navPages` (= `pages` without
  `log-hub-onepager/`) is used by step 2.

## Page content (exact copy, American spelling)

`<title>` and `og:title`: `Artisyn Log Hub one-pager — your Claude Code harness, measured`

Description (142 chars, also `og:description`):
`Artisyn Log Hub on one page: what it measures in Claude Code sessions, the eight questions it answers, how it is deployed and where to get it.`

| Block | Copy |
|---|---|
| Back link (screen only) | `← Log Hub site` → `../index.html` |
| Brand / tag | `Artisyn Log Hub` · `Your Claude Code harness, measured` |
| Hook (`h1`) | `It ran alone for {{ds:session.durationMin}} minutes, cost {{ds:session.total\|usd0}} and {{ds:session.outcome}}. All good?` |
| Thesis | `A harness — CLAUDE.md, rules, skills, hooks, agents, MCP servers, a knowledge base — decides what a Claude Code session costs and delivers, yet it is tuned as a black box. Log Hub shows what each part does.` |
| Study sentence | `With the same model, the harness alone changes the cost per task up to five times at similar success rates (UC Berkeley and Arena, 2026).` |
| Groups label | `What Log Hub answers` |
| 01 · cost | `Where the money goes: per session, branch, skill and tool, with budgets and a forecast.` |
| 02 · speed | `How long the agent worked alone, and where the time went.` |
| 03 · context | `What your harness loads into every session, and what the agent actually uses.` |
| 04 · quality | `Which of your checks ran in a session, and with what result.` |
| 05 · team | `Trends, reports and anomalies across every session and developer.` |
| 06 · tools | `Which MCP servers and CLI tools work, fail or are never called.` |
| 07 · safety | `What the agent read, ran and sent — traceable afterwards.` |
| 08 · trust | `Log Hub's own data: what is collected, who can see it, how long it is kept.` |
| Screenshot | `../assets/shots/spend-budget.png`, `width="743" height="570"`, alt = the alt used in `site/pages/features.html:79`, caption `Repository → Spend` |
| How it runs 1 | `Self-hosted` — `Runs on your own server with Docker and PostgreSQL.` |
| How it runs 2 | `Data stays on your host` — `Session data is stored in your own database; there is no hosted service.` |
| How it runs 3 | `Network-isolated` — `Works with no internet access: the app, its help and its docs ship together.` |
| Links label | `Get it` |
| Links | `Site` `{{site:url}}` · `GitHub` `{{site:repo}}` · `Releases` `{{site:releases}}` · `Deck` `{{site:url}}deck/` — the URL is both the `href` and the visible text |
| Footer | `Open source by DataArt · MIT · not affiliated with Anthropic` |

Shortened group lines, used only if the sheet does not fit after the study sentence is dropped
(the deck-map wording): `Was {{ds:session.total|usd0}} a lot?` · `How fast, how far alone?` ·
`What it loads, what it uses` · `Did its checks run and pass?` · `Across every session` ·
`Does this tool work?` · `What the agent read and sent` · `Log Hub's own data`.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `site/log-hub-onepager/index.html` | new | Hand-written standalone page: head as in `site/deck/index.html:4-34` (no reveal links), body per "Page content" |
| `site/log-hub-onepager/onepager.css` | new | Sheet layout, `≤ 999px` stacked layout, `@page`, `@media print` |
| `scripts/site/build-site.mjs` | modify | Third tuple in the standalone loop (`:371`); header comment (`:4-25`) and the `:370` comment name the page |
| `scripts/site/layout.mjs` | modify | `topNav` (`:104`): "One-pager" item after "Deck" |
| `site/pages/home.html` | modify | Hero actions (`:15`): "One-pager" button after the deck button |
| `site/deck/index.html` | modify | Closing slide (`:848`): fifth `closing-links` item after "Features" |
| `tests/scenarios/platform/s-site-01.spec.ts` | modify | `TOP_NAV`, steps 1, 2, 3, 6, 9, 15, 16, 17, new step 20, header comment |
| `docs/knowledgebase/user-docs-and-site.md` | modify | Front matter, input/output row, head rules, top nav, shots row, study row, new "One-pager" section |
| `docs/knowledgebase/index.md` | modify | The "User Docs and Site" line names the one-pager |
| `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` | modify | §S-SITE-01 title, steps 1, 2, 3, 6, 9, 15–17, new step 20, "What we lose" |
| `docs/tasks/todo/2026-11-13-site-log-hub-onepager/research/pdf-page-count.md` | done | Planning note (already written) |

## Test coverage plan

Only kind 3 (scenario) applies; no algorithm doc and no route is touched.

| Item | Kind | Extends |
|---|---|---|
| Page built, reachable, links resolve, nav item, Home and deck links | Scenario | `@S-SITE-01` steps 1, 2, 3, 9 |
| Dark mode on screen | Scenario | `@S-SITE-01` step 6 |
| No horizontal scroll at 375 px and 1280 px | Scenario | `@S-SITE-01` steps 7, 8 (page is in `pages`, no code change) |
| Sitemap entry, head tags, icons | Scenario | `@S-SITE-01` steps 15, 16, 17 |
| Content, one screen at 1280 × 720, 360 px, no external request, light print, one-page PDF at A4 and Letter | Scenario | `@S-SITE-01` new step 20 |

Not tested (as today for the deck): the build's fail paths (missing / out-of-range / duplicate
description) — guarded by the build itself and the CI site check.

Commands: `npm run build:site` (build step), `npm run typecheck:tests`, and while iterating
`npm run test:scenarios -- --mode a --only scenarios --grep "@S-SITE-01"`.

## Visual/UX notes

Screen ≥ 1000 px wide (target 1280 × 720, sheet padding 1em, max-width 1280px, centered):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← Log Hub site      Artisyn Log Hub      // YOUR CLAUDE CODE HARNESS, …  │  header row
│ It ran alone for 10 minutes, cost $8 and shipped the feature. All good?  │  h1, mono, ~1.6em, one line
│ Thesis sentence. Study sentence.                                         │  ≤ 2 lines
├───────────────────────────────────────────┬──────────────────────────────┤
│ WHAT LOG HUB ANSWERS                      │ ┌──────────────────────────┐ │
│ 01·COST  line        02·SPEED  line       │ │  spend-budget.png        │ │
│ 03·CONTEXT line      04·QUALITY line      │ │  (height-limited, ~22em) │ │
│ 05·TEAM  line        06·TOOLS  line       │ └──────────────────────────┘ │
│ 07·SAFETY line       08·TRUST  line       │ Repository → Spend           │
├───────────────────────────────────────────┼──────────────────────────────┤
│ HOW IT RUNS  [Self-hosted][Data][Network] │ GET IT  Site url · GitHub url│
│                                           │         Releases url · Deck  │  2 × 2, mono ~0.8em
├───────────────────────────────────────────┴──────────────────────────────┤
│ Open source by DataArt · MIT · not affiliated with Anthropic             │
└──────────────────────────────────────────────────────────────────────────┘
```

- Site look: tokens of `theme.css`, mono labels (`.eyebrow` style), square corners, 1px borders;
  reuse `figure.shot`. Group label color `--accent`, group text `--text-2`.
- No `overflow: hidden`, no fixed height on the sheet or its blocks — a too-long sheet must show
  as a scroll / second page, so the scenario catches it.
- The screenshot is sized by `max-height` in `em` with `width: auto; object-fit: contain`, never
  upscaled past 743 px.
- Below 1000 px: one column in source order (header, hook, thesis, groups in one column,
  screenshot, how it runs, links, footer); vertical scroll is fine; URLs wrap
  (`overflow-wrap: anywhere`).
- Print: same grid as the wide screen regardless of width; back link hidden; body background
  image off; `break-inside: avoid` on every block; link URLs stay visible text.
- Visual check after the build (Playwright MCP, `use-playwright` skill, the built `tmp/site`
  served by a local static server): 1280 × 720 light and dark, 360 px, and print-media emulation.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Page, build and entry links | 7 | — |
| 2 | Scenario `@S-SITE-01` | 7 | needs chunk 1 |
| 3 | Docs | 4 | describes chunks 1–2 |

### Chunk 1 — Page, build and entry links

- [ ] Create `site/log-hub-onepager/index.html`: `<head>` copied from `site/deck/index.html:4-34` without the comment and reveal links, title/description/og values from this plan's "Page content", canonical and `og:url` `{{site:url}}log-hub-onepager/`, stylesheets `../assets/theme.css` then `onepager.css`. No `<script>`.
- [ ] In the same file write the body from "Page content": `a.op-back`, `main.op-sheet` with `header.op-head`, `h1.op-hook`, `p.op-thesis` (thesis + study sentence in `span.op-study`), `ol.op-groups > li[data-group]` ×8, `figure.shot.op-shot`, `ul.op-runs` ×3, `ul.op-links` ×4 (`a` text = its absolute `href`), `p.op-footer`.
- [ ] Create `site/log-hub-onepager/onepager.css` per "Visual/UX notes" and DD-3: `.op-sheet { font-size: 16px }`, all other sizes in `em`; wide grid under `@media (min-width: 1000px)`, stacked single column below; no `overflow: hidden`, no fixed heights.
- [ ] In `onepager.css` add print rules: `@page { size: landscape; margin: 10mm; }`; `@media print` with `:root { … }` repeating the light color tokens of `site/assets/theme.css:8-29,37`, `body { background: #fff; }`, `.op-sheet { font-size: 12px; }` in the wide grid, `.op-back { display: none; }`, `break-inside: avoid` on every block.
- [ ] `scripts/site/build-site.mjs:371`: add `[path.join(SITE_DIR, 'log-hub-onepager'), 'log-hub-onepager', true]` to the loop array before the assets tuple; update the `:370` comment and the header comment (`:4-25`: output list, placeholder and description lines) to name the one-pager.
- [ ] Add entry links: `scripts/site/layout.mjs` after `:104` `navLink(`${prefix}log-hub-onepager/index.html`, 'One-pager', false)`; `site/pages/home.html` after `:15` `<a class="button" href="log-hub-onepager/index.html">One-pager</a>`; `site/deck/index.html` after `:848` `<li><a href="../log-hub-onepager/index.html">One-pager</a></li>`.
- [ ] Run `npm run build:site`, serve `tmp/site` and tune `onepager.css` until 1280 × 720 shows no vertical scroll with the footer in view. If it cannot fit: remove `span.op-study`, then switch to the shortened group lines from "Page content". Never drop the hook, groups, screenshot or links.

### Chunk 2 — Scenario `@S-SITE-01`

- [ ] `tests/scenarios/platform/s-site-01.spec.ts`: `TOP_NAV` gains `'One-pager'` after `'Deck'`; step 1 `expected` gains `'log-hub-onepager/index.html'`; after `pages` add `navPages = pages.filter(u => !u.startsWith(`${server.base}log-hub-onepager/`))` and loop step 2 over it; skip the `aria-current` check for `'One-pager'` as for `'Deck'`.
- [ ] Step 3: assert `main a[href="log-hub-onepager/index.html"]` exists on Home. Step 9 (after the deck loads): assert `.closing-links a` texts equal `['Get started', 'Home', 'Features', 'One-pager', 'GitHub ↗']` and the fourth `href` attribute is `../log-hub-onepager/index.html`.
- [ ] Step 6: add `'log-hub-onepager/index.html'` to the page list. Step 15: assert `parsed.locs` contains `${SITE_URL}log-hub-onepager/`. Step 16: assert `site.html` has the one-pager URL. Step 17: add the page to the `['index.html', 'deck/index.html']` icon list. Update the step titles and the file header comment.
- [ ] Add step `20. one-pager: content, one screen at 1280×720, 360 px` after step 19: at 1280 × 720 open the page; assert no `{{` in the HTML, `h1` hook from the dataset (as step 3), `.op-groups li` `data-group` order cost…trust, loaded `spend-budget.png`, footer text, back link `../index.html`, four `.op-links a` whose text equals `href` (`SITE_URL`, `REPO_URL`, `RELEASES_URL`, `${SITE_URL}deck/`).
- [ ] Same step: assert `documentElement.scrollHeight ≤ clientHeight`, `scrollWidth ≤ clientWidth` and `.op-footer` bottom ≤ 720; at 360 × 800 assert no horizontal scroll and body font ≥ 16 px; assert every request recorded in `requests` during this step starts with `${origin}/`.
- [ ] Same step, print media: with `emulateMedia({ media: 'print' })` body `color` and `backgroundColor` are equal for `colorScheme` light and dark, and `.op-back` is hidden; at viewports 1047 × 718 and 980 × 740 there is no horizontal scroll.
- [ ] Same step, PDF: with `colorScheme: 'dark'` emulated, `page.pdf({ format, landscape: true })` for `'A4'` and `'Letter'` each has exactly one match of `/\/Type\s*\/Page(?![a-zA-Z])/g` in `buffer.toString('latin1')`. Then reset media to screen/light and the viewport to 1280 × 720.

### Chunk 3 — Docs

- [ ] `docs/knowledgebase/user-docs-and-site.md`: front-matter description and timestamp; input/output row `site/log-hub-onepager/` → `log-hub-onepager/`; head-tag paragraph and top-nav list name the page; shots row for `spend-budget.png` and the HarnessTax study row gain "one-pager".
- [ ] Same file: new `## One-pager` section after `## Deck` — source files, content blocks, `em` scaling (16 px screen, 12 px print), one screen at 1280 × 720, `@page` landscape, light tokens in print, fit order (study sentence, then short group lines), entry links, `@S-SITE-01` step 20.
- [ ] `docs/knowledgebase/index.md`: the "User Docs and Site" line mentions the one-pager ("the GitHub Pages site/deck/one-pager").
- [ ] `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` §S-SITE-01 (`:623-650`): mirror the changed steps 1, 2, 3, 6, 9, 15, 16, 17 and add step 20 (content, one screen, 360 px, no external request, light print, one-page landscape PDF at A4 and Letter); in "What we lose" replace "the PDF file itself is not produced" with the deck-only wording.
