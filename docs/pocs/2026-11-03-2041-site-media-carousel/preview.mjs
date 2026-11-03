// preview.mjs — put the carousel into the real built home page and check it in a headless browser.
//
// Needs `npm run build:site` (repo root) first: it reads <repo>/tmp/site/index.html and writes
//   tmp/site/poc-carousel.html            the home page with a "See it in action" section after the hero
//   tmp/site/assets/poc/...               carousel.css/js, the media from ./out, generated thumbnails
// then opens it over file:// (no server) and saves screenshots to ./result plus a measurements line.
// tmp/ is gitignored; nothing under site/ is touched.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const SITE = path.join(repo, 'tmp', 'site');
const POC = path.join(SITE, 'assets', 'poc');
const OUT = path.join(here, 'out');
const RESULT = path.join(here, 'result');
const home = path.join(SITE, 'index.html');
if (!fs.existsSync(home)) throw new Error('tmp/site/index.html missing: run `npm run build:site` from the repo root first');
if (!fs.existsSync(path.join(OUT, 'tour.gif'))) throw new Error('./out is empty: run `node capture.mjs stills` and `node capture.mjs clip` first');

fs.mkdirSync(path.join(POC, 'thumbs'), { recursive: true });
fs.mkdirSync(RESULT, { recursive: true });
for (const f of ['carousel.css', 'carousel.js']) fs.copyFileSync(path.join(here, f), path.join(POC, f));
for (const f of fs.readdirSync(OUT)) fs.copyFileSync(path.join(OUT, f), path.join(POC, f));

// Captions: new captures (this PoC) first, then the existing site shots (docs/knowledgebase/user-docs-and-site.md).
const NEW = [
  // The cleaned GIF, not tour.webm: recordVideo also records page loads and pre-cleanup frames.
  ['tour.gif', 'img', 'A short tour: session, context, change surface, agent map, analytics', 'Session → tabs'],
  ['sessions-summary.png', 'img', 'Sessions by branch and the Summary hub of a $27 session', 'Repository → Sessions → Summary'],
  ['usage.png', 'img', 'Where the context window went, turn by turn', 'Session → Usage'],
  ['change-surface.png', 'img', 'Which files and folders one session changed', 'Session → Change surface'],
  ['session-map.png', 'img', 'Agent map: a review workflow and its seven agents', 'Session → Session Map'],
  ['call-tree.png', 'img', 'Call tree: every token and dollar by component', 'Session → Call Tree'],
  ['context-growth.png', 'img', 'Context growth over the session', 'Session → Context Growth'],
  ['analytics.png', 'img', 'Work time per branch over a month', 'Repository → Analytics'],
  ['tools.png', 'img', 'MCP and CLI tool calls with failures', 'Repository → Tools/MCP'],
];
const OLD = {
  'summary-hub.png': 'Summary tiles and “where to look next”', 'nav-lenses.png': 'Session tabs: the View select and “More”',
  'nav-chart-tabs.png': 'Call Tree as a session tab of its own', 'all-views-map.png': 'All views map, filtered “cost”',
  'context-usage.png': 'Context usage', 'change-surface.png': 'Change surface (Features)', 'analytics.png': 'Analytics (Features)',
  'okf-usage.png': 'Knowledge-base (OKF) usage', 'tool-analytics.png': 'Tool analytics', 'agent-tree.png': 'Agent tree',
  'call-tree.png': 'Call tree (deck)', 'context-growth-start.png': 'Context growth: start', 'context-growth-later.png': 'Context growth: later',
  'cost-by-branch.png': 'Cost by branch', 'harness-usage.png': 'Harness usage', 'lines-per-hour.png': 'Lines per hour',
  'metric-list.png': 'Metric list', 'sessions-by-cost.png': 'Sessions by cost', 'timeline.png': 'Timeline',
  'tool-heatmap.png': 'Tool heatmap', 'tools-mcp.png': 'Tools / MCP',
};
/** Total play time of a GIF: the sum of its frame delays (Graphic Control Extensions, centiseconds). */
function gifDurationMs(file) {
  const b = fs.readFileSync(file);
  let cs = 0;
  for (let i = 0; i + 5 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04) cs += b.readUInt16LE(i + 4);
  return cs * 10;
}

const items = [
  ...NEW.map(([f, , caption, where]) => {
    const file = path.join(POC, f);
    const clip = f.endsWith('.gif');
    return { file, src: `assets/poc/${f}`, caption, where, clip,
      still: clip ? 'assets/poc/sessions-summary.png' : undefined, duration: clip ? gifDurationMs(file) : undefined };
  }),
  ...fs.readdirSync(path.join(SITE, 'assets', 'shots')).filter((f) => f.endsWith('.png')).map((f) => ({
    file: path.join(SITE, 'assets', 'shots', f), src: `assets/shots/${f}`, caption: OLD[f] ?? f, where: 'existing site shot' })),
];

const browser = await chromium.launch();

// Thumbnails: 256x160 JPEG, the whole item fitted in on white (like the stage), rendered by the browser itself.
{
  const page = await browser.newPage({ viewport: { width: 256, height: 160 } });
  // A file:// page, so it may load file:// images (about:blank may not).
  const thumbPage = path.join(POC, 'thumb.html');
  fs.writeFileSync(thumbPage, '<body style="margin:0;background:#fff"><img style="display:block;width:256px;height:160px;object-fit:contain"></body>');
  await page.goto(pathToFileURL(thumbPage).href);
  for (const it of items) {
    const name = path.basename(it.file).replace(/\.\w+$/, '.jpg');
    const img = it.clip ? path.join(POC, 'sessions-summary.png') : it.file;
    await page.locator('img').evaluate((i, src) => { i.src = src; return i.decode(); }, pathToFileURL(img).href);
    await page.screenshot({ path: path.join(POC, 'thumbs', name), type: 'jpeg', quality: 80 });
    it.thumb = `assets/poc/thumbs/${name}`;
  }
  await page.close();
}

const section = `
<section class="media-section" aria-labelledby="media-title">
  <h2 id="media-title">See it in action</h2>
  <div class="mc" data-mc tabindex="0" aria-roledescription="carousel" aria-label="Log Hub screens">
    <div class="mc-stage">
      <button class="mc-btn mc-prev" type="button" aria-label="Previous">‹</button>
      <button class="mc-btn mc-next" type="button" aria-label="Next">›</button>
      <button class="mc-btn mc-pause" type="button" aria-pressed="false" aria-label="Pause slideshow">❚❚</button>
    </div>
    <div class="mc-meta"><span class="mc-caption"></span><span><span class="mc-where"></span> · <span class="mc-counter"></span></span></div>
    <div class="mc-strip"></div>
  </div>
</section>
<script type="application/json" id="mc-items">${JSON.stringify(items.map(({ file, ...rest }) => rest))}</script>
<script src="assets/poc/carousel.js" defer></script>
`;
let html = fs.readFileSync(home, 'utf8');
const heroEnd = html.indexOf('</section>', html.indexOf('class="hero"'));
if (heroEnd < 0) throw new Error('hero section not found in tmp/site/index.html');
html = html.slice(0, heroEnd + '</section>'.length) + section + html.slice(heroEnd + '</section>'.length);
html = html.replace('</head>', '<link rel="stylesheet" href="assets/poc/carousel.css">\n</head>');
const previewFile = path.join(SITE, 'poc-carousel.html');
fs.writeFileSync(previewFile, html);
const url = pathToFileURL(previewFile).href;

/** Open the preview, scroll to the carousel, return the bytes of every poc/shots file the page requested. */
async function check(name, ctxOpts, act) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const requested = new Set();
  page.on('request', (r) => { if (/\/assets\/(poc|shots)\//.test(r.url())) requested.add(fileURLToPath(r.url())); });
  await page.goto(url);
  await page.locator('.mc-stage img, .mc-stage video').first().waitFor();
  await page.waitForTimeout(1500);
  await page.locator('#media-title').scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, -20));
  if (act) await act(page);
  // A thumbnail click may scroll the page; bring the whole carousel back into view for the screenshot.
  await page.locator('#media-title').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(RESULT, `${name}.png`) });
  const bytes = [...requested].reduce((s, f) => s + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
  const counter = await page.locator('.mc-counter').textContent();
  const shown = await page.evaluate(() => document.querySelector('.mc-stage img')?.src.split('/').pop());
  const paused = await page.locator('.mc-pause').getAttribute('aria-pressed');
  console.log(`${name}: ${requested.size} media files requested, ${(bytes / 1024).toFixed(0)} KB, counter ${counter}, stage shows ${shown}, paused ${paused}`);
  await ctx.close();
}

await check('desktop-light', { viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
await check('desktop-dark-item-05', { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' }, async (page) => {
  await page.locator('[data-mc]').focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
});
await check('desktop-thumb-click-20', { viewport: { width: 1440, height: 900 }, colorScheme: 'light' }, async (page) => {
  await page.locator('.mc-thumb').nth(19).click();
});
// Autoplay: from a still (item 2) the carousel moves on after 5 s; after Pause it stays put.
await check('autoplay-then-pause', { viewport: { width: 1440, height: 900 }, colorScheme: 'light' }, async (page) => {
  await page.locator('.mc-thumb').nth(1).click();
  await page.waitForTimeout(5800);
  const moved = await page.locator('.mc-counter').textContent();
  await page.locator('.mc-pause').click();
  await page.waitForTimeout(6000);
  const held = await page.locator('.mc-counter').textContent();
  console.log(`  autoplay: after 5.8 s on item 02 -> ${moved}; paused 6 s -> ${held}`);
});
await check('wide-shot-no-fill', { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' }, async (page) => {
  const i = await page.evaluate(() => JSON.parse(document.getElementById('mc-items').textContent).findIndex((x) => x.src.endsWith('lines-per-hour.png')));
  await page.locator('.mc-thumb').nth(i).click();
});
await check('mobile-375', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
await check('reduced-motion', { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' });

await browser.close();
const thumbs = fs.readdirSync(path.join(POC, 'thumbs'));
const thumbKb = thumbs.reduce((s, f) => s + fs.statSync(path.join(POC, 'thumbs', f)).size, 0) / 1024;
const fullKb = items.reduce((s, it) => s + fs.statSync(it.file).size, 0) / 1024;
console.log(`items: ${items.length}; all thumbnails ${thumbKb.toFixed(0)} KB; all full media ${(fullKb / 1024).toFixed(1)} MB`);
