**Requirements summary**
The task adds three things. First, a reusable Node script `scripts/site/record-demo.mjs` that drives Playwright read-only against local prod's demo repo (`adlc-demo-app`) and encodes GIFs with `gifenc`. It is not part of `build:site` or any health check. Second, an 8-scene, about 25 s app tour GIF that loops forever, at 960×600, ≤ 10 fps and ≤ 5 MB, stored at `site/assets/demo/app-tour.gif`. It is embedded in `README.md` after the intro and the Docs · Site · Deck links. Third, a "See it in action" section directly below the hero on the site home page: a Steam-style vanilla JS/CSS carousel with 30+ items (the tour, about 20 stills, about 10 clips of 5–8 s). Every item is captured by the same script at 1280×800 CSS px with DPR 2, has its own 256×160 JPEG thumbnail, and is fitted uncropped into a white 16:10 frame. Controls are prev/next and pause, arrow keys, and autoplay (5 s per still, a clip's own length). Under `prefers-reduced-motion` it starts paused and shows a static first-frame PNG. Below 768 px it uses swipe, an `NN / NN` counter and tap to open full size. Only the current item's full media loads. Capture uses "presentation mode" (nav collapsed, top bar hidden, e-mails rewritten to `dev@example.com`, non-English branch groups folded), waits until no "Loading…" text is shown, parks the mouse, and fits up to 1.5× plus a bottom fade. Tooling is Node only. AC-7: the new media are listed in the KB Screenshots table.

**Wireframes**
- `wireframes/readme-demo-gif-storyboard.svg`:
  - The GIF goes after the intro and the Docs · Site · Deck links, before the badges.
  - Alt text sample: "Log Hub tour: repositories, sessions by cost, session summary, context growth, call tree, map replay…".
  - Storyboard: 01 Home repos → 02 Sessions by $ → 03 Summary hub → 04 Context growth (4 s) → 05 Call tree → 06 Map replay (5 s) → 07 Change surface → 08 Cost by branch.
  - Its timeline ends at 28 s, which conflicts with the requirement of about 25 s (8×3 s = 24 s; with the 4 s and 5 s scenes it is 27 s).
  - It shows a visible cursor, click pulses and a caption overlay. The requirements say to park the mouse, so those are superseded.
  - Plain cuts, no fades.
- `site-home-media-carousel.svg` (desktop):
  - Filter chips (All/Cost/Harness/Replay/Team), "autoplay off", "pause on hover" and a first-frame PNG with a "Play" button. All of these are superseded by the requirements and the PoC.
  - Still valid: "▶ GIF" badge on thumbnails, active thumbnail with a green frame scrolled into view, the `07 / 32` counter, the "where in the app" line, and one data file listing items (path, caption, group, kind).
  - "One item only → no strip/arrows/counter" is an edge case the PoC does not handle.
  - The existing three cards stay under the carousel.
- `site-home-media-carousel-mobile.svg` (375 px): dots and hidden arrows are superseded (the requirements keep arrows and use only the counter). Still valid: tap to full screen, caption wraps, 16 px gutters, no horizontal scroll.
- PoC visual reference: `docs/pocs/2026-11-03-2041-site-media-carousel/result/*.png` (desktop-light, dark, mobile-375, reduced-motion and others).

**Knowledgebase**
- `docs/knowledgebase/user-docs-and-site.md`:
  - `build-site.mjs` copies `site/assets/**` byte-for-byte to `assets/`.
  - All links must be relative (except `404.html`).
  - No external scripts besides pinned Mermaid and reveal.js.
  - "Old digital" style; light/dark via `prefers-color-scheme`; the 768 px breakpoint.
  - Screenshot rule: English UI only, no e-mail, user name or local path.
  - Screenshots table (lines ~210–225) is where AC-7 rows go. Its Input/Output table also lists `site/assets/` contents and needs a `demo/` mention.
  - It also describes one-off PNG renders by hand (precedent for media generated outside the build).
  - `pages.yml` deploys on a `site/**` change; `README.md` is not a site input.
- `docs/knowledgebase/session-map.md:139-166`: replay speeds 1×/10×/60×/300× (default 60×), a Play/Pause button (`SessionMapTimeline.tsx:262`), the `smSel` URL param.
- `docs/knowledgebase/test/index.md` and the CLAUDE.md test policy: only extend the existing scenario `@S-SITE-01`. No unit tests. The script itself is a manual tool and gets no test.
- `.claude/skills/nodejs-script/SKILL.md`: the CJS/sync/no-deps rule. `build-site.mjs:14-16` documents the ESM exemption precedent ("unified/remark are ESM-only; precedent `scripts/scenarios/*.mjs`"). `record-demo.mjs` needs the same justification (Playwright is async; `gifenc` dependency).
- `docs/kb-local/local-prod.md`: local prod at `http://localhost:5003`, `AUTH_MODE=none`, identify via `POST /api/v1/auth/identify`, sessions visible only to the owner's e-mail. Never put these values in tracked files; the script takes them from env vars.

**Existing patterns**
- `docs/pocs/2026-11-03-2041-site-media-carousel/capture.mjs` (direct base for `record-demo.mjs`):
  - `:39-69` presentation-mode `addInitScript`: `artisyn:leftNavCollapsed`, `artisyn:sessionListWidth`, an e-mail MutationObserver that writes only when the text changes, CSS that hides `#root > div > :first-child`, caret hidden.
  - `:93-99` `newPage` = context, init script, then `ctx.request.post('/api/v1/auth/identify')`.
  - `:102-106` `settle`: networkidle plus waiting for no "Loading…".
  - `:108-123` `open`: folds `master` when Russian prompt text is visible, clicks a label, parks the mouse in the corner.
  - `:126-161` `overflow` and `openFitted`: viewport ×k ≤ 1.5, dpr/k, 72 px mask fade.
  - `:175-222` GIF: screenshot loop, 10 fps cap, merges identical buffers, one palette per frame, `delay` = time until the next frame.
  - It uses `pngjs` to decode the screenshots.
- `docs/pocs/.../preview.mjs`:
  - `:52-57` `gifDurationMs`: sums the Graphic Control Extension delays (gives `duration` for autoplay).
  - `:73-87` thumbnails: a 256×160 `file://` page with `object-fit:contain` on `#fff`, screenshotted as JPEG q80.
  - `:89-104` section markup plus `<script type="application/json" id="mc-items">`.
  - `:115-161` the checks (request counting, autoplay/pause, 375 px, reduced motion). These are a template for the scenario step.
- `docs/pocs/.../carousel.js:1-97` and `carousel.css:1-157`: the full carousel (lazy thumbnails, one media element on stage, the timer starts on `load`, `visibilitychange`, pointer swipe with `touch-action: pan-y`, reduced motion means paused and uses `still`). The CSS hard-codes `#fff` in `.mc-stage` and `.mc-thumb`.
- `site/pages/home.html:1-77`: the hero `<section class="hero">`; the new section goes after `:77`. `:79` is `<section class="cards">`; `@S-SITE-01` step 3 asserts exactly 3 `.cards .card`, so the new section must not reuse those classes.
- `scripts/site/layout.mjs:181-208` `page()`: one stylesheet (`assets/theme.css`) and `assets/site.js`, no per-page head hook. Carousel CSS therefore goes into `theme.css`, or a `<link>`/`<script defer>` inside the home body fragment.
- `scripts/site/build-site.mjs:353-366`: home body goes through `fillAll` (only `{{ds:` and `{{site:` are treated as placeholders, so inline JSON is safe). `:370-389` copies `site/assets/**` as-is, so `site/assets/demo/**` and a `carousel.js`/`.css` ship with no build change.
- `site/assets/theme.css:5-62`: tokens `--surface`, `--border`, `--border-soft`, `--text-3`, `--accent`, `--focus`, `--label-text`, `--mono`, `--wide-max: 1200px`, `--radius: 2px`, dark overrides at `:38`. Breakpoints at `:835/845/856` (1023/899/767 px).
- `site/assets/site.js:1-20`: ES5 IIFE style for site scripts.
- `tests/scenarios/platform/s-site-01.spec.ts` (the scenario to extend):
  - `:35-43` `CONTENT_TYPES` has no `.gif` or `.jpg`, so they would be served as `application/octet-stream`. Add them.
  - `:44` `TEXT_EXT` includes `.json`, so the items JSON is covered by the step 14 e-mail/path grep.
  - `:179` crawl matches only `href=`/`src=` attributes, so JSON item paths are not checked.
  - Steps 7 and 8 check no horizontal scroll at 375 px and 1280 px.
  - `:126-131` `pngSize` (IHDR) can be reused; a GIF needs its own size check from header bytes 6–9.
  - `test.setTimeout(240_000)` at `:230`.
- `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md:623-649`: the S-SITE-01 step list must be updated with any new step.
- `docs/third-party-components.md:135-157` section 4a "Documentation site renderer": add a `gifenc` 1.0.3 MIT row (and `pngjs` 7.0.0 MIT if kept). Keep `user-docs/third-party-components.md` in sync.
- Root `package.json:40-55`: `@playwright/test` ^1.60.0 is a devDependency and `node_modules/playwright` is present via it. `gifenc` and `pngjs` are not installed at the root, so `gifenc` must be added to devDependencies (CI `pages.yml` runs `npm ci --ignore-scripts`).
- Client deep links for scenes:
  - Analytics: `#/repos/<id>?mtab=analytics&ar=1m&ag=branch&av=cost` (`analytics-url.ts:56-75`). `al=horizontal` gives the ranked layout used by the old `sessions-by-cost.png` ("cost per session ranked").
  - Session tabs: `?session=<id>&tab=` with `summary|usage|session-map|context-growth|call-tree|change-surface|tools` (`client/src/viewer/tab-ids.ts:14-55`).
  - Repository tabs: `mtab=` (`:58-69`).
  - Repo list: the hash router's `ROUTE.main` (`client/src/main.tsx:279`).
- Storage keys used by presentation mode: `artisyn:leftNavCollapsed` (`AppShell.tsx:14`) and `artisyn:sessionListWidth` (`RepositorySessionsPanel.tsx:130`).

**Measured values**
- PoC `out/tour.gif`: 960×600, 53 frames, 16,150 ms, 1,709,555 bytes = 1.6304 MiB. The NETSCAPE2.0 block holds loop count 0, so it loops forever (gifenc's default `repeat: 0`).
- gifenc rounds `delay` to 10 ms units (`Math.round(delay/10)`).
- At the PoC's byte rate (105,855 bytes/s), 25 s comes to 2,646,370 bytes, under the 5 MB budget (5,242,880 bytes if MiB, 5,000,000 if decimal).
- 10 fps over 25 s allows at most 250 frames.
- Fit geometry:
  - Stills: 1280×800 at DPR 2 gives 2560×1600. At 1.5× fit the viewport is 1920×1200 at DPR 4/3, which keeps 2560×1600.
  - GIF: DPR 0.75 at 1280×800, or DPR 0.5 at 1920×1200, gives 960×600.
  - Thumbnails: 256×160, ratio 1.6 (exactly 16:10).
- PoC stills: 74,542–306,613 bytes each. PoC thumbnails: 142 KB in total for 30.

**Open gaps**
1. **"Session list sorted by cost" has no UI.** The session list has only view modes branch/date/user/plain (`SessionListPanel.tsx:27`) and no cost sort. Pick a substitute, such as Analytics Cost with `al=horizontal` (as the old shot did), or the branch list with cost-threshold highlighting.
2. **PNG decoding for gifenc.** The PoC uses `pngjs`, but FR-1/FR-6 name only `gifenc`. Either add `pngjs` as a devDependency (plus a third-party row), or get raw RGBA in-browser (a canvas `getImageData` in a helper page) to avoid it.
3. **Items data source.** Options are inline JSON in `home.html`, a file under `site/assets/demo/`, or one generated by `record-demo.mjs`. The wireframe asks for "one data file". The scene/item list (captions, "where in the app", clip durations) has to live somewhere the script and the page share.
4. **First-frame PNG for reduced motion.** The PoC substitutes `sessions-summary.png`. The script must write a real first frame (e.g. `app-tour.png`) and a still per clip. No naming scheme exists yet.
5. **Mobile tap to open full size** is not in the PoC: open the media in a new tab vs. a lightbox.
6. **"Only `theme.css` tokens"** conflicts with the PoC's hard-coded `#fff`. Add a token (e.g. a frame background that stays white in both themes) to `theme.css`.
7. **Carousel CSS/JS location.** `layout.mjs` `page()` has no per-page head slot. Choose between folding into `theme.css` plus `<script defer>` in the body fragment, or adding an option to `page()`.
8. **About 30 new scenes.** The PoC has 8 stills and a 5-scene clip. The full list of about 20 stills and about 10 clips (5–8 s, what moves in each) is not defined anywhere. Clips need a motion action per scene (e.g. Session Map Play at a chosen speed, a Call Tree expand).
9. **Non-English text beyond the `master` fold.** The PoC uses a hard-coded probe string (`'/adlc-demo:scratch take file'`). A general check for Cyrillic text in the frame before capture is not implemented.
10. **Scenario coverage for the carousel.** `@S-SITE-01` has no step for it. It needs:
    - ≥ 30 items, and every item and thumbnail file exists (the crawl does not see JSON paths);
    - a GIF header check: 960×600, loops, ≤ 5 MB;
    - first load fetches only the first media plus visible thumbnails;
    - autoplay of 5 s then pause;
    - reduced-motion still;
    - 375 px with no horizontal scroll;
    - adding `.gif`/`.jpg` to `CONTENT_TYPES`.
    The autoplay wait adds about 6 s or more to the 240 s timeout. AC-2 (no PII or non-English text inside the image pixels) can only be checked by eye.
11. **Script structure and CLI.** There is no repo precedent for a Playwright capture script under `scripts/` (only PoCs). To decide:
    - env var names (the PoC's `LOGHUB_URL`, `LOGHUB_EMAIL`, `LOGHUB_REPO`, `SESSION_*`);
    - output guards that write only its own listed files under `site/assets/demo/`;
    - whether a "refuse to start servers" note is needed;
    - whether it lives as `.mjs` with a documented ESM/async exemption.
12. **Storyboard length.** The wireframe's 28 s vs. the required ~25 s, and per-scene hold times, need a decision.
13. **Repo size.** About 30 stills at 70–300 KB plus about 11 GIFs get committed. No budget for the total media weight is stated (the PoC's full set was 4.4 MB).
