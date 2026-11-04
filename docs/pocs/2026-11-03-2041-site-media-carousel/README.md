# PoC: site media carousel and app demo GIF

Task: [2026-11-03-app-demo-gif](../../tasks/todo/2026-11-03-app-demo-gif/requirements.md)

## Questions

1. How do we capture good, repeatable media of the app: clean frames (no e-mail, no non-English
   text, no loading states, nothing cut mid-element), sharp enough for the site, small enough for
   the README?
2. How does a Steam-style carousel with 30 items look and behave on the real site home page
   (light, dark, phone, reduced motion), and how much does it load?

## How to run

From this folder, against a running Log Hub in auth mode `none` (read-only: the script only
identifies and browses, it never starts a server):

```sh
npm install
LOGHUB_URL=<log hub url> LOGHUB_EMAIL=<owner of the demo repo> LOGHUB_REPO=<repo id> \
SESSION_COST=<session id> SESSION_AGENTS=<session id> node capture.mjs stills
# same env
node capture.mjs clip
# from the repo root: npm run build:site   (writes tmp/site)
node preview.mjs
```

- `capture.mjs stills` — 8 scenes as 16:10 PNG, 2560×1600 → `out/`.
- `capture.mjs clip` — a 5-scene tour as GIF, 960×600 → `out/`.
- `preview.mjs` — writes `tmp/site/poc-carousel.html` (the built home page plus a "See it in
  action" section after the hero) and `tmp/site/assets/poc/`, renders thumbnails, opens the page
  over `file://` in several setups and saves screenshots to `result/`. Open
  `tmp/site/poc-carousel.html` in a browser to try it by hand.

Files: `capture.mjs`, `preview.mjs`, `carousel.css`, `carousel.js` (the carousel itself, vanilla,
no dependencies). Only `gifenc` and `pngjs` are installed, for the GIF; no ffmpeg, no Python.

## Result

### Capturing

- **"Presentation mode" via `addInitScript` makes frames clean without touching the app:** the
  left nav collapsed (`artisyn:leftNavCollapsed`), the top bar (identity e-mail, "Edit email", env
  name) hidden with one CSS rule, every e-mail in the DOM rewritten to `dev@example.com` by a
  MutationObserver (the session header shows the user). The observer must write only when the text
  changes — writing the same value re-triggers it forever (the first run hung).
- **Non-English prompts:** the demo repository's `master` branch has Russian prompts; the script
  folds that branch group. The `demo/pass*` sessions have English prompts.
- **Wait for data, park the mouse:** `networkidle` is not enough (Analytics showed "Loading…");
  wait until no "Loading…" text is on screen. After a click a hover card stays in the frame unless
  the mouse is moved to a corner. Analytics needs the `1m` range: the demo data is a month old.
- **Nothing cut, every frame 16:10:** the script measures the most overflowing scroll pane; if
  content does not fit 1280×800 CSS px, the viewport grows in both directions by the same factor
  (up to 1.5×) and deviceScaleFactor shrinks by it, so the output stays 2560×1600 (or 960×600 for
  the GIF). A pane that is still longer (session list, Session Map, Tools) gets a 72 px fade to white
  at its bottom edge instead of a hard cut. Of 8 scenes: 5 needed 1.5×, 1 needed 1.17×, 2 fitted.
  Stills are 70–300 KB each.
- **GIF:** a screenshot loop per scene (~15 fps grabbed, capped at 10 fps, identical frames merged):
  the 5-scene tour is 16 s, 53 frames, **1.63 MB** — within the 5 MB budget. (A first version
  without fitting merged down to 5 frames / 0.18 MB; fitted pages keep changing a few pixels, so
  fewer frames merge.)
- **Playwright `recordVideo` is not usable:** it records page loads, blank frames and the
  pre-cleanup state (the unfolded `master` group with Russian prompts was visible). Dropped; the
  site uses the same GIF as the README.

### Carousel

Screenshots in `result/`: `desktop-light.png`, `desktop-dark-item-05.png`,
`desktop-thumb-click-20.png`, `wide-shot-no-fill.png`, `autoplay-then-pause.png`,
`mobile-375.png`, `reduced-motion.png`.

| Setup | Media requested | Bytes | Check |
|---|---|---|---|
| Desktop 1440, light, first load | 20 (GIF + visible thumbs) | 1.7 MB | `01 / 30`, GIF playing |
| Desktop dark, ArrowRight ×4 | 25 | 2.7 MB | `05 / 30`, Session Map |
| Thumbnail 20 (an old, wide shot) | 31 | 1.9 MB | fitted on white, nothing cut |
| Autoplay from item 02, then Pause | 22 | 2.3 MB | after 5.8 s `03 / 30`; paused 6 s → still `03 / 30` |
| Phone 375 | 3 | 1.7 MB | `01 / 30`, arrows + pause, no strip |
| `prefers-reduced-motion` | 20 | 350 KB | starts paused, static first frame instead of the GIF |

30 items: 9 new captures + 21 existing `site/assets/shots/*.png`. All thumbnails (256×160 JPEG,
the item fitted on white) 142 KB; all full media 4.4 MB, loaded one at a time.

- **Frame:** every item fills the same 16:10 frame on white (the app's own background, in both
  site themes); the whole image is fitted in (`object-fit: contain`), never cropped. Thumbnails are
  rendered the same way, so the strip has no cut-off or grey tiles.
- **Controls:** prev/next buttons at the left and right edges of the frame and a pause/play button
  in its bottom-right corner, on desktop and phone. Autoplay: a still stays 5 s, the GIF stays for
  its own length (read from its frame delays). Under `prefers-reduced-motion` the carousel starts
  paused. Keyboard ArrowLeft/Right, thumbnail click and swipe work.
- **The existing 21 shots** are cropped panes of different sizes; on white they no longer look
  broken, but many sit small in the frame (e.g. `lines-per-hour`). Re-capturing all items by the
  script at one frame gives a uniform carousel; the old shots stay in Features and the deck.
- **Thumbnails must be separate small files** (about 5 KB each); using the full PNGs would load
  ~4 MB just for the strip.
- **Phone:** 30 position dots wrap into two rows — the `NN / 30` counter is the only position
  indicator. At 375 px a full-app frame is too small to read; the phone needs tap-to-open full size.
- **Weight:** the GIF is the heaviest first-load item (1.6 MB). Under `prefers-reduced-motion`
  the first load is 350 KB.
