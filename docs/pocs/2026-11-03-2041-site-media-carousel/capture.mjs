// capture.mjs — scripted capture of Log Hub screens for the site media carousel and the README GIF.
//
// Read-only: it only identifies (mode `none`) and browses an already running Log Hub. It never
// starts a server. Output goes to ./out (gitignored).
//
//   node capture.mjs stills   — one crisp PNG per scene (deviceScaleFactor 2)
//   node capture.mjs clip     — one short tour as GIF (screenshot loop, gifenc), 960x600
//
// Env (all required): LOGHUB_URL (a running Log Hub in auth mode `none`), LOGHUB_EMAIL (owner of
// the demo repository), LOGHUB_REPO (its id), SESSION_COST (a costly session with English prompts),
// SESSION_AGENTS (a session with a workflow and sub-agents).
import { chromium } from 'playwright';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'out');
const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name} (see the header of capture.mjs)`);
  return v;
};
const BASE = env('LOGHUB_URL').replace(/\/$/, '');
const EMAIL = env('LOGHUB_EMAIL');
const REPO = env('LOGHUB_REPO');
const S_COST = env('SESSION_COST');
const S_AGENTS = env('SESSION_AGENTS');

const mode = process.argv[2] ?? 'stills';
fs.mkdirSync(OUT, { recursive: true });

// "Presentation mode", injected before the app boots:
//  - left nav collapsed and the top bar hidden (it carries the identity e-mail and "Edit email");
//  - every e-mail in the DOM rewritten to a neutral one (the session header shows the user).
const PRESENTATION = `
  try { localStorage.setItem('artisyn:leftNavCollapsed', 'true');
        localStorage.setItem('artisyn:sessionListWidth', '300'); } catch {}
  const EMAIL_RE = /[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/g;
  const NEUTRAL = 'dev@example.com';
  // Write only when the text actually changes, or the observer would re-trigger itself forever.
  const fix = (n) => {
    const v = n.nodeValue;
    const next = v && v.replace(EMAIL_RE, (m) => (m === NEUTRAL ? m : NEUTRAL));
    if (next !== v) n.nodeValue = next;
  };
  const scrub = (root) => {
    if (root.nodeType === 3) return fix(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fix(n);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') fix(m.target);
      else m.addedNodes.forEach(scrub);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
  addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style');
    // MainNav is the first child of the shell column; the left nav wrapper is the first child of the row below it.
    s.textContent = '#root > div > :first-child { display: none !important; }' +
      '#root > div > div:nth-child(2) > :first-child { display: none !important; }' +
      '* { caret-color: transparent !important; }';
    document.head.append(s);
  });
`;

const sess = (id, tab) => `#/repos/${REPO}?session=${id}${tab ? `&tab=${tab}` : ''}`;

/**
 * Scenes. `hash` opens the screen; `click` (optional) is a tab/button label clicked after load;
 * `analyticsRange` picks the range button so the demo data (late October) is inside it.
 * Every scene is the whole app pane at 1280x800 CSS px (16:10, the carousel's frame).
 */
const SCENES = [
  { id: 'sessions-summary', hash: sess(S_COST) },
  { id: 'usage', hash: sess(S_COST, 'usage') },
  { id: 'change-surface', hash: sess(S_COST, 'change-surface') },
  { id: 'session-map', hash: sess(S_AGENTS, 'session-map') },
  { id: 'call-tree', hash: sess(S_AGENTS), click: 'Call Tree' },
  { id: 'context-growth', hash: sess(S_COST), click: 'Context Growth' },
  { id: 'analytics', hash: `#/repos/${REPO}?mtab=analytics`, click: '1m' },
  { id: 'tools', hash: `#/repos/${REPO}?mtab=tools` },
];

const BASE_W = 1280;
const BASE_H = 800;
const MAX_FIT = 1.5;

async function newPage(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(PRESENTATION);
  const r = await ctx.request.post(`${BASE}/api/v1/auth/identify`, { data: { email: EMAIL } });
  if (!r.ok()) throw new Error(`identify failed: ${r.status()}`);
  return { ctx, page: await ctx.newPage() };
}

/** Wait until no "Loading…" placeholder is on screen (charts load after networkidle). */
async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => !/Loading\.\.\.|Loading…/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function open(page, scene) {
  await page.goto(`${BASE}/${scene.hash}`);
  await settle(page);
  // Fold the branch groups whose sessions have non-English prompts (only `master` in the demo repo).
  if (await page.getByText('/adlc-demo:scratch take file').isVisible().catch(() => false)) {
    await page.getByText('master', { exact: true }).first().click();
  }
  if (scene.click) {
    await page.getByText(scene.click, { exact: true }).first().click();
    await settle(page);
  }
  // Park the mouse so no hover card or tooltip is left in the frame.
  const vp = page.viewportSize();
  await page.mouse.move(vp.width - 1, vp.height - 1);
  await page.waitForTimeout(400);
}

/** How many times taller than its box the most overflowing big scroll pane is (1 = everything fits). */
function overflow(page) {
  return page.evaluate(() => Math.max(1, ...[...document.querySelectorAll('body *')]
    .filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.clientHeight > 200 && e.clientWidth > 200)
    .map((e) => e.scrollHeight / e.clientHeight)));
}

/**
 * Open a scene so it fills the 16:10 frame with nothing cut mid-element: if a pane overflows, the
 * viewport grows by the same factor in both directions (up to MAX_FIT) and deviceScaleFactor
 * shrinks by it, so the output stays outW x outH pixels. A pane still longer than that gets a short
 * fade to white at its bottom edge instead of a hard cut.
 */
async function openFitted(browser, scene, outW) {
  const dpr = outW / BASE_W;
  let { ctx, page } = await newPage(browser, { viewport: { width: BASE_W, height: BASE_H }, deviceScaleFactor: dpr });
  await open(page, scene);
  const need = await overflow(page);
  let k = 1;
  if (need > 1.02) {
    k = Math.min(MAX_FIT, need);
    await ctx.close();
    ({ ctx, page } = await newPage(browser, {
      viewport: { width: Math.round(BASE_W * k), height: Math.round(BASE_H * k) }, deviceScaleFactor: dpr / k }));
    await open(page, scene);
  }
  const faded = await page.evaluate(() => {
    let n = 0;
    for (const e of document.querySelectorAll('body *')) {
      if (!/(auto|scroll)/.test(getComputedStyle(e).overflowY) || e.clientHeight <= 200 || e.scrollHeight <= e.clientHeight + 4) continue;
      e.style.maskImage = e.style.webkitMaskImage = 'linear-gradient(to bottom, #000 calc(100% - 72px), transparent)';
      n++;
    }
    return n;
  });
  return { ctx, page, k, faded };
}

async function stills() {
  const browser = await chromium.launch();
  for (const s of SCENES) {
    const { ctx, page, k, faded } = await openFitted(browser, s, 2560);
    const file = path.join(OUT, `${s.id}.png`);
    await page.screenshot({ path: file });
    console.log(`${s.id}.png  fit x${k.toFixed(2)}  faded panes ${faded}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
    await ctx.close();
  }
  await browser.close();
}

async function clip() {
  // A screenshot loop per scene, encoded with gifenc. Every scene is fitted like the stills, at a
  // 960x600 output (deviceScaleFactor 0.75 at 1280x800), so no resize step is needed.
  // (Playwright's recordVideo was tried and dropped: it records page loads and pre-cleanup frames.)
  const browser = await chromium.launch();
  const tour = [
    { ...SCENES[0], hold: 3000 },
    { ...SCENES[1], hold: 3000 },
    { ...SCENES[2], hold: 3000 },
    { ...SCENES[3], hold: 4000 },
    { ...SCENES[6], hold: 3000 },
  ];
  const frames = [];
  for (const step of tour) {
    const { ctx, page } = await openFitted(browser, step, 960);
    const end = Date.now() + step.hold;
    while (Date.now() < end) {
      const t = Date.now();
      frames.push({ buf: await page.screenshot({ type: 'png' }), t, scene: step.id });
    }
    frames.push({ end: true, t: Date.now() });
    await ctx.close();
  }
  await browser.close();

  // GIF: a frame lasts until the next frame of the same scene (the last one until its scene's end),
  // capped at MAX_FPS; identical consecutive frames are merged; one palette per frame.
  const MAX_FPS = 10;
  const kept = [];
  for (const f of frames) {
    const prev = kept.at(-1);
    if (f.end) { if (prev) prev.until = f.t; continue; }
    if (prev && !prev.until && (f.t - prev.t < 1000 / MAX_FPS || f.buf.equals(prev.buf))) continue;
    if (prev && !prev.until) prev.until = f.t;
    kept.push(f);
  }
  const gif = GIFEncoder();
  for (const f of kept) {
    const png = PNG.sync.read(f.buf);
    const palette = quantize(png.data, 256);
    gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, { palette, delay: f.until - f.t });
  }
  gif.finish();
  const gifFile = path.join(OUT, 'tour.gif');
  fs.writeFileSync(gifFile, gif.bytes());
  const total = kept.reduce((s, f) => s + f.until - f.t, 0);
  console.log(`tour.gif  ${(total / 1000).toFixed(1)} s, ${kept.length} frames, ${(fs.statSync(gifFile).size / 1048576).toFixed(2)} MB`);
}

if (mode === 'stills') await stills();
else if (mode === 'clip') await clip();
else throw new Error(`unknown mode ${mode}`);
