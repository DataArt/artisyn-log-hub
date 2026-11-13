// S-SITE-01. The static Log Hub site, the "Why Log Hub" deck and the one-pager: built, served under
// a base path, navigable, responsive, dark-mode aware, with no leaked e-mails or local paths; the
// one-pager fits one 1280×720 screen and one landscape PDF page at A4 and at Letter
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-SITE-01; layer UI, mode A).
//
// The site is not part of the stand: the scenario builds it itself with
// `node scripts/site/build-site.mjs --out tmp/scenarios/site` and serves the output with a Node
// `http` static server under BASE_PATH (`/artisyn-log-hub/`, the GitHub Pages base path, DD-19a)
// so relative links are proven not to depend on the site root. The stand fixtures are not used;
// the scenario carries `@mode-a` only so it runs once.
//
// The deck loads reveal.js 5.2.1 from cdn.jsdelivr.net (DD-23), so the deck steps need internet
// access — exactly like the published site does.
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { REPO_ROOT, helpNav, helpPages } from '../helpers/help-nav';

/** GitHub Pages base path of the site (DD-19a); the site must work below it. */
const BASE_PATH = '/artisyn-log-hub/';
const SITE_DIR = path.join(REPO_ROOT, 'tmp', 'scenarios', 'site');
const REPO_URL = 'https://github.com/DataArt/artisyn-log-hub';
const RELEASES_URL = `${REPO_URL}/releases`;

/** Top-nav labels in order (DD-20). */
const TOP_NAV = ['Home', 'Features', 'Get started', 'Configuration', 'Using Log Hub', 'Data & security', 'FAQ', 'Deck', 'One-pager', 'GitHub ↗'];

/** The one-pager (site/log-hub-onepager/), relative to the site root. */
const ONEPAGER = 'log-hub-onepager/index.html';

/** An external request may only go to jsDelivr with an exact `name@x.y.z` version. */
const VERSIONED_CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+\//;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.xml': 'application/xml; charset=utf-8',
};

/** Text files of the build output that the artifact grep reads. */
const TEXT_EXT = new Set(['.html', '.css', '.js', '.json', '.md', '.svg', '.txt', '.xml']);

/** Published site root and og-image values — must equal SITE_URL / OG_IMAGE_* in scripts/site/layout.mjs. */
const SITE_URL = 'https://dataart.github.io/artisyn-log-hub/';
const SITE_NAME = 'Artisyn Log Hub';
const OG_IMAGE_URL = `${SITE_URL}assets/og-image.png`;
const OG_IMAGE_ALT = 'Artisyn Log Hub: It ran alone for 10 minutes, cost $8 and shipped the feature. All good? Quality, cost, speed, autonomy, safety';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * Not real mailboxes: the SSH remote form of a git URL used as an example in how-hook-works, and
 * the RFC 2606 reserved-domain placeholders of the small-team-setup `.env` examples.
 */
const EMAIL_ALLOWED = new Set(['git@github.com', 'loghub@example.com', 'you@example.com']);
/** Absolute local paths: a Windows drive, a macOS or Linux home folder. */
const LOCAL_PATH = /\b[A-Za-z]:\\[^\s<"']*|\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+/g;
/** Fictional example home folders the docs use on purpose (tuning-your-setup, how-hook-works). */
const LOCAL_PATH_ALLOWED = new Set(['/home/me', '/home/jane']);

interface SiteServer {
  base: string;
  close(): Promise<void>;
}

function startSiteServer(root: string): Promise<SiteServer> {
  const server = http.createServer((req, res) => {
    const notFound = () => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    };
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return notFound();
    }
    if (!pathname.startsWith(BASE_PATH)) return notFound();
    let rel = pathname.slice(BASE_PATH.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, rel);
    const inside = path.relative(root, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return notFound();
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      // Like GitHub Pages: a miss at any depth under the site answers 404 with the site's 404.html.
      const page404 = path.join(root, '404.html');
      if (!fs.existsSync(page404)) return notFound();
      res.writeHead(404, { 'Content-Type': CONTENT_TYPES['.html'] });
      return res.end(fs.readFileSync(page404));
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}${BASE_PATH}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function decodeAttr(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Canonical URL of a site file (path relative to the site root), as layout.mjs canonicalUrl() builds it. */
function canonical(relPath: string): string {
  const p = relPath.replace(/\\/g, '/');
  if (p === 'index.html') return SITE_URL;
  if (p.endsWith('/index.html')) return SITE_URL + p.slice(0, -'index.html'.length);
  return SITE_URL + p;
}

/** Decoded `content` of every `<meta {attr}="{key}" content="…">` in `html`. */
function metaContent(html: string, attr: 'name' | 'property', key: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<meta\s+([^>]*)>/g)) {
    const attrs = m[1];
    const k = new RegExp(`(?:^|\\s)${attr}="([^"]*)"`).exec(attrs)?.[1];
    if (k === undefined || decodeAttr(k) !== key) continue;
    const content = /(?:^|\s)content="([^"]*)"/.exec(attrs)?.[1];
    if (content !== undefined) out.push(decodeAttr(content));
  }
  return out;
}

/** Decoded `href` of every `<link rel="{rel}" …>` in `html`. */
function linkHrefs(html: string, rel: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\s+([^>]*)>/g)) {
    if (/(?:^|\s)rel="([^"]*)"/.exec(m[1])?.[1] !== rel) continue;
    const href = /(?:^|\s)href="([^"]*)"/.exec(m[1])?.[1];
    if (href !== undefined) out.push(decodeAttr(href));
  }
  return out;
}

/** Width and height of a PNG from its IHDR chunk (bytes 16–23, big-endian). */
function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  expect(buf.subarray(1, 4).toString('latin1'), `${file}: PNG signature`).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

interface GifInfo {
  width: number;
  height: number;
  /** NETSCAPE2.0 loop count (0 = forever); null when the block is absent. */
  loop: number | null;
  frames: number;
  /** Sum of the Graphic Control Extension delays, in ms. */
  durationMs: number;
}

/** Walk the blocks of a GIF89a file: logical size (bytes 6–9, little-endian), loop count, frame delays. */
function gifInfo(file: string): GifInfo {
  const buf = fs.readFileSync(file);
  expect(buf.subarray(0, 6).toString('latin1'), `${file}: GIF signature`).toBe('GIF89a');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const colorTable = (packed: number) => ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  const skipSubBlocks = (at: number) => {
    let i = at;
    while (buf[i] !== 0) i += buf[i] + 1;
    return i + 1;
  };
  let i = 13 + colorTable(buf[10]);
  let loop: number | null = null;
  let frames = 0;
  let delayCs = 0;
  while (i < buf.length && buf[i] !== 0x3b) {
    if (buf[i] === 0x21) {
      const label = buf[i + 1];
      if (label === 0xf9) delayCs += buf.readUInt16LE(i + 4);
      if (label === 0xff && buf.subarray(i + 3, i + 14).toString('latin1') === 'NETSCAPE2.0' && buf[i + 15] === 1) {
        loop = buf.readUInt16LE(i + 16);
      }
      i = skipSubBlocks(i + 2);
    } else if (buf[i] === 0x2c) {
      frames += 1;
      i = skipSubBlocks(i + 10 + colorTable(buf[i + 9]) + 1);
    } else {
      throw new Error(`${file}: unexpected GIF block 0x${buf[i].toString(16)} at ${i}`);
    }
  }
  expect(buf[i], `${file}: GIF trailer`).toBe(0x3b);
  return { width, height, loop, frames, durationMs: delayCs * 10 };
}

/** One entry of site/assets/demo/items.json (written by scripts/site/record-demo.mjs). */
interface DemoItem {
  id: string;
  kind: 'tour' | 'still' | 'clip';
  src: string;
  still?: string;
  thumb: string;
  duration?: number;
  caption: string;
  where: string;
  alt: string;
}

interface CrawlResult {
  /** Local URL (no hash) → HTTP status. */
  status: Map<string, number>;
  /** Local HTML URL → its source. */
  html: Map<string, string>;
  /** `from → href` of local links whose target answered something other than 200. */
  broken: string[];
  /** `from → href` of local links whose `#fragment` has no element with that id. */
  missingAnchors: string[];
  /** External link targets (not fetched). */
  external: Set<string>;
}

async function crawl(start: string, origin: string): Promise<CrawlResult> {
  const status = new Map<string, number>();
  const html = new Map<string, string>();
  const refs: Array<{ from: string; href: string; target: string; hash: string }> = [];
  const external = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const url = queue.shift() as string;
    if (status.has(url)) continue;
    const res = await fetch(url);
    status.set(url, res.status);
    const type = res.headers.get('content-type') ?? '';
    const body = await res.text();
    if (res.status !== 200 || !type.startsWith('text/html')) continue;
    html.set(url, body);
    for (const m of body.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const href = decodeAttr(m[1]);
      if (href.startsWith('data:') || href.startsWith('mailto:')) continue;
      const abs = new URL(href, url);
      if (abs.origin !== origin) {
        external.add(abs.href);
        continue;
      }
      const hash = decodeURIComponent(abs.hash.slice(1));
      abs.hash = '';
      refs.push({ from: url, href, target: abs.href, hash });
      if (!status.has(abs.href)) queue.push(abs.href);
    }
  }
  const broken: string[] = [];
  const missingAnchors: string[] = [];
  for (const r of refs) {
    if (status.get(r.target) !== 200) {
      broken.push(`${r.from} → ${r.href} (${status.get(r.target)})`);
      continue;
    }
    const target = html.get(r.target);
    if (r.hash && target !== undefined && !target.includes(`id="${r.hash}"`)) {
      missingAnchors.push(`${r.from} → ${r.href}`);
    }
  }
  return { status, html, broken, missingAnchors, external };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/** No horizontal page scroll and the body font size, at the current viewport. */
async function layoutMetrics(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    fontSize: parseFloat(getComputedStyle(document.body).fontSize),
  }));
}

async function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test('@S-SITE-01 static site and deck: built, served under a base path, navigable, responsive @mode-a', async ({ page, browser }) => {
  test.setTimeout(300_000);

  await test.step('0. build-site.mjs writes the site into tmp/scenarios/site/', async () => {
    const run = spawnSync(process.execPath, ['scripts/site/build-site.mjs', '--out', 'tmp/scenarios/site'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(run.status, `build-site failed:\n${run.stdout}\n${run.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(SITE_DIR, 'index.html'))).toBe(true);
  });

  const server = await startSiteServer(SITE_DIR);
  const origin = new URL(server.base).origin;
  const requests: string[] = [];
  page.context().on('request', (req) => requests.push(req.url()));

  try {
    const site = await test.step('1. the crawl from Home reaches every page and finds no broken link or anchor', async () => {
      const result = await crawl(`${server.base}index.html`, origin);
      expect(result.broken, 'local links that do not answer 200').toEqual([]);
      expect(result.missingAnchors, 'local links to a #fragment the target page lacks').toEqual([]);
      const expected = [
        'index.html',
        'features.html',
        'questions.html',
        'deck/index.html',
        ONEPAGER,
        ...helpPages.map((p) => `docs/${p.slug}.html`),
      ].map((p) => `${server.base}${p}`);
      for (const url of expected) expect(result.html.has(url), `reachable: ${url}`).toBe(true);
      // Every external link of the site is https (GitHub, releases, the CDN) — or the reader's own
      // freshly installed server on localhost (install-server: "Open http://localhost:5003").
      for (const ext of result.external) {
        expect(ext.startsWith('https://') || /^http:\/\/localhost(?::\d+)?\//.test(ext), ext).toBe(true);
      }
      return result;
    });

    const pages = [...site.html.keys()].filter((u) => !u.startsWith(`${server.base}deck/`));
    // The one-pager is standalone like the deck: no site top nav.
    const navPages = pages.filter((u) => !u.startsWith(`${server.base}log-hub-onepager/`));

    await test.step('2. every page except the deck and the one-pager has the same top nav, and every nav target answers 200', async () => {
      await page.setViewportSize({ width: 1280, height: 720 });
      for (const url of navPages) {
        await page.goto(url);
        const links = await page.locator('nav.site-nav a').evaluateAll((as) =>
          as.map((a) => ({ text: (a.textContent ?? '').trim(), href: (a as HTMLAnchorElement).href })),
        );
        expect(links.map((l) => l.text), url).toEqual(TOP_NAV);
        for (const l of links) {
          if (l.href.startsWith(origin)) expect(site.status.get(l.href), `${url}: ${l.text}`).toBe(200);
          else expect(l.href, `${url}: ${l.text}`).toBe(REPO_URL);
        }
      }
      // Clicking through the top nav from Home lands on each target.
      await page.goto(`${server.base}index.html`);
      for (const label of TOP_NAV.slice(1, -1)) {
        await page.locator('nav.site-nav a', { hasText: label }).first().click();
        await page.waitForLoadState('load');
        expect(page.url().startsWith(server.base), label).toBe(true);
        if (label !== 'Deck' && label !== 'One-pager') await expect(page.locator('nav.site-nav a[aria-current="page"]'), label).toHaveText(label);
        await page.goto(`${server.base}index.html`);
      }
    });

    await test.step('3. Home: the hook with dataset figures, five dimension tiles, the anatomy strip, six cards and links to the deck, the one-pager, Features and Get started', async () => {
      await page.goto(`${server.base}index.html`);
      const ds = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'site', 'data', 'example-dataset.json'), 'utf8')) as {
        session: { durationMin: number; total: number; outcome: string };
      };
      const h1 = page.locator('h1');
      await expect(h1).toContainText(`It ran alone for ${ds.session.durationMin} minutes`);
      await expect(h1).toContainText(`$${Math.round(ds.session.total)}`);
      await expect(h1).toContainText(ds.session.outcome);
      await expect(h1).toContainText('All good?');
      await expect(page.locator('.hero .lead').first()).toContainText('harness');
      await expect(page.locator('.hero')).toContainText('right and useful');
      await expect(page.locator('.hero')).toContainText('Log Hub answers the next questions');
      // Five dimension tiles in the hero, each a link into a Features block that exists.
      const tiles = page.locator('.hero .dimensions a.dimension');
      await expect(tiles).toHaveCount(5);
      const tileTargets = await tiles.evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
      expect(tileTargets).toEqual(['features.html#c', 'features.html#a', 'features.html#i', 'features.html#i', 'features.html#e']);
      // The harness anatomy strip: nine elements, each linking to the view that shows it.
      await expect(page.locator('section.anatomy li')).toHaveCount(9);
      await expect(page.locator('section.anatomy li a[href^="features.html#"]')).toHaveCount(9);
      // Six cards: five dimensions plus team scale; speed and autonomy both lead to block I.
      await expect(page.locator('.cards .card')).toHaveCount(6);
      await expect(page.locator('.cards .card a[href="features.html#i"]')).toHaveCount(2);
      await expect(page.locator('.cards .card a[href="features.html#d"]')).toHaveCount(1);
      await expect(page.locator('main a[href="deck/index.html"]')).not.toHaveCount(0);
      await expect(page.locator(`main a[href="${ONEPAGER}"]`)).not.toHaveCount(0);
      await expect(page.locator('main a[href^="features.html"]')).not.toHaveCount(0);
      await expect(page.locator('main a[href="docs/install-server.html"]')).not.toHaveCount(0);
    });

    await test.step('4. Features: nine blocks A–I, each with its question', async () => {
      await page.goto(`${server.base}features.html`);
      await expect(page.locator('h1')).toHaveText('Nine questions Log Hub answers');
      for (const block of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
        const marker = page.locator(`section#${block} h2 .block-marker`);
        await expect(marker, block).toHaveText(block.toUpperCase());
        await expect(page.locator(`section#${block} h2`), block).toContainText('?');
      }
    });

    await test.step('5. docs pages: sidebar with every page, TOC whose anchors exist, repo and releases links', async () => {
      let tocPages = 0;
      for (const p of helpPages) {
        const html = site.html.get(`${server.base}docs/${p.slug}.html`) as string;
        const sidebar = /<aside class="docs-sidebar"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? '';
        expect(sidebar.length, `${p.slug}: sidebar`).toBeGreaterThan(0);
        for (const other of helpPages) {
          expect(sidebar.includes(`href="../docs/${other.slug}.html"`), `${p.slug} sidebar → ${other.slug}`).toBe(true);
        }
        expect(html.includes(`href="${REPO_URL}"`), `${p.slug}: repo link`).toBe(true);
        expect(html.includes(`href="${RELEASES_URL}"`), `${p.slug}: releases link`).toBe(true);
        const toc = /<nav class="docs-toc"[\s\S]*?<\/nav>/.exec(html)?.[0];
        if (!toc) continue;
        tocPages += 1;
        const anchors = [...toc.matchAll(/href="#([^"]+)"/g)].map((m) => decodeAttr(m[1]));
        expect(anchors.length, `${p.slug}: TOC entries`).toBeGreaterThanOrEqual(3);
        for (const a of anchors) expect(html.includes(`id="${a}"`), `${p.slug}: TOC #${a}`).toBe(true);
      }
      // The long pages have one (install-server has several h2 sections).
      expect(tocPages).toBeGreaterThan(0);
      expect(site.html.get(`${server.base}docs/install-server.html`)?.includes('class="docs-toc"'), 'install-server TOC').toBe(true);
      // The sidebar groups follow nav.json.
      await page.goto(`${server.base}docs/install-server.html`);
      await expect(page.locator('.docs-sidebar .docs-group-title')).toHaveText(helpNav.map((s) => s.section));
      await expect(page.locator('.docs-sidebar a[aria-current="page"]')).toHaveText('Install the server');
    });

    await test.step('6. dark mode: prefers-color-scheme changes the background of the site, the deck and the one-pager', async () => {
      for (const p of ['index.html', 'docs/install-server.html', 'deck/index.html', ONEPAGER]) {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(`${server.base}${p}`);
        const light = await bodyBackground(page);
        await page.emulateMedia({ colorScheme: 'dark' });
        const dark = await bodyBackground(page);
        expect(dark, p).not.toBe(light);
      }
      await page.emulateMedia({ colorScheme: 'light' });
    });

    await test.step('7. 375 px: no horizontal scroll, body ≥ 16 px, the Menu button opens the nav', async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      for (const url of pages) {
        await page.goto(url);
        const m = await layoutMetrics(page);
        expect(m.scrollWidth, `${url}: horizontal scroll at 375 px`).toBeLessThanOrEqual(m.clientWidth);
        expect(m.fontSize, `${url}: body font size`).toBeGreaterThanOrEqual(16);
      }
      await page.goto(`${server.base}index.html`);
      await expect(page.locator('nav.site-nav')).toBeHidden();
      await page.getByRole('button', { name: 'Menu' }).click();
      await expect(page.locator('nav.site-nav')).toBeVisible();
    });

    await test.step('8. 1280×720: no horizontal scroll on any page', async () => {
      await page.setViewportSize({ width: 1280, height: 720 });
      for (const url of pages) {
        await page.goto(url);
        const m = await layoutMetrics(page);
        expect(m.scrollWidth, `${url}: horizontal scroll at 1280 px`).toBeLessThanOrEqual(m.clientWidth);
      }
    });

    const slideCount = await test.step('9. deck: 10–36 slides, every slide fits 1280×720, arrows move between slides, the closing slide links to the one-pager', async () => {
      await page.goto(`${server.base}deck/index.html`);
      await page.waitForFunction(() => document.querySelector('.reveal.ready') !== null);
      const closing = await page.locator('.closing-links a').evaluateAll((as) =>
        as.map((a) => ({ text: (a.textContent ?? '').trim(), href: a.getAttribute('href') })),
      );
      expect(closing.map((l) => l.text)).toEqual(['Get started', 'Home', 'Features', 'One-pager', 'GitHub ↗']);
      expect(closing[3].href).toBe(`../${ONEPAGER}`);
      const count = await page.locator('.reveal .slides > section').count();
      expect(count).toBeGreaterThanOrEqual(10);
      expect(count).toBeLessThanOrEqual(36);
      for (let i = 0; i < count; i++) {
        const overflow = await page.evaluate((idx) => {
          const frame = document.querySelectorAll('.reveal .slides > section')[idx].querySelector('.slide-frame');
          if (!frame) return 'no .slide-frame';
          (window as unknown as { Reveal: { slide(h: number): void } }).Reveal.slide(idx);
          const over = frame.scrollHeight - frame.clientHeight > 1 || frame.scrollWidth - frame.clientWidth > 1;
          return over ? `${frame.scrollWidth}×${frame.scrollHeight} in ${frame.clientWidth}×${frame.clientHeight}` : '';
        }, i);
        expect(overflow, `slide ${i + 1} overflows`).toBe('');
      }
      await page.goto(`${server.base}deck/index.html#/0`);
      await page.waitForFunction(() => document.querySelector('.reveal.ready') !== null);
      const current = () =>
        page.evaluate(() => (window as unknown as { Reveal: { getIndices(): { h: number } } }).Reveal.getIndices().h);
      expect(await current()).toBe(0);
      await page.keyboard.press('ArrowRight');
      await expect.poll(current).toBe(1);
      await expect(page).toHaveURL(/#\/1$/);
      await page.keyboard.press('ArrowRight');
      await expect.poll(current).toBe(2);
      await page.keyboard.press('ArrowLeft');
      await expect.poll(current).toBe(1);
      return count;
    });

    await test.step('10. deck: content slides have one headline, ≤ 3 bullets and ≤ 40 words of body', async () => {
      const slides = await page.locator('.reveal .slides > section.content-slide').evaluateAll((els) =>
        els.map((el) => {
          const body = el.querySelector('.slide-body') as HTMLElement | null;
          let words = 0;
          if (body) {
            // Text in a dataset figure block or a visual slot is not body text.
            const copy = body.cloneNode(true) as HTMLElement;
            copy.querySelectorAll('.deck-figure, .visual-slot').forEach((n) => n.remove());
            words = (copy.textContent ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
          }
          return {
            block: el.getAttribute('data-block'),
            headlines: el.querySelectorAll('.headline').length,
            bullets: body ? body.querySelectorAll('li').length : -1,
            words,
          };
        }),
      );
      expect(slides.length).toBeGreaterThanOrEqual(6);
      for (const [i, s] of slides.entries()) {
        const what = `content slide ${i + 1} (${s.block})`;
        expect(s.headlines, what).toBe(1);
        expect(s.bullets, what).toBeGreaterThan(0);
        expect(s.bullets, what).toBeLessThanOrEqual(3);
        expect(s.words, what).toBeLessThanOrEqual(40);
      }
    });

    await test.step('11. no "Illustrative example" label and no speaker notes anywhere (deck, Home, Features)', async () => {
      // Dataset figures are an ordinary worked example: the blocks exist, with no hedging label.
      expect(await page.locator('.deck-figure').count()).toBeGreaterThan(0);
      expect(await page.locator('.reveal').evaluate((e) => e.textContent ?? '')).not.toMatch(/illustrative example/i);
      expect(await page.locator('.illustrative').count(), 'deck .illustrative').toBe(0);
      expect(await page.locator('aside.notes').count(), 'deck speaker notes').toBe(0);
      for (const p of ['index.html', 'features.html']) {
        await page.goto(`${server.base}${p}`);
        expect(await page.locator('.figure-block').count(), p).toBeGreaterThan(0);
        expect(await page.locator('main').evaluate((e) => e.textContent ?? ''), p).not.toMatch(/illustrative example/i);
        expect(await page.locator('.illustrative').count(), `${p} .illustrative`).toBe(0);
      }
    });

    await test.step('12. deck ?print-pdf renders every slide as a PDF page, without the exit link', async () => {
      await page.goto(`${server.base}deck/index.html?print-pdf`);
      await page.waitForFunction(() => document.documentElement.classList.contains('print-pdf'));
      await expect(page.locator('.pdf-page')).toHaveCount(slideCount);
      await expect(page.locator('.deck-exit')).toBeHidden();
      await expect(page.locator('.pdf-page').first()).toContainText('Artisyn Log Hub');
    });

    await test.step('13. requests went only to the local server or to versioned cdn.jsdelivr.net URLs', async () => {
      const foreign = requests.filter(
        (u) => !u.startsWith(`${origin}/`) && !u.startsWith('data:') && !VERSIONED_CDN.test(u),
      );
      expect(foreign).toEqual([]);
      expect(requests.some((u) => VERSIONED_CDN.test(u)), 'the deck loaded reveal.js from jsDelivr').toBe(true);
    });

    await test.step('14. artifact grep: no e-mail address and no absolute local path in the built site', async () => {
      const ownPaths = [REPO_ROOT, os.homedir()]
        .filter((p) => p.length > 3)
        .flatMap((p) => [p, p.split(path.sep).join('/'), p.split(path.sep).join('\\\\')]);
      const hits: string[] = [];
      for (const file of listFiles(SITE_DIR)) {
        if (!TEXT_EXT.has(path.extname(file))) continue;
        const text = fs.readFileSync(file, 'utf8');
        const where = path.relative(SITE_DIR, file);
        for (const m of text.matchAll(EMAIL)) if (!EMAIL_ALLOWED.has(m[0])) hits.push(`${where}: e-mail ${m[0]}`);
        for (const m of text.matchAll(LOCAL_PATH)) if (!LOCAL_PATH_ALLOWED.has(m[0])) hits.push(`${where}: path ${m[0]}`);
        for (const p of ownPaths) if (text.includes(p)) hits.push(`${where}: build machine path ${p}`);
      }
      expect(hits).toEqual([]);
    });

    const builtHtml = listFiles(SITE_DIR)
      .filter((f) => path.extname(f) === '.html')
      .map((f) => path.relative(SITE_DIR, f).split(path.sep).join('/'));

    await test.step('15. sitemap.xml lists every indexable page in canonical form', async () => {
      const res = await fetch(`${server.base}sitemap.xml`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toMatch(/^application\/xml/);
      const xml = await res.text();
      await page.goto(`${server.base}index.html`);
      const parsed = await page.evaluate((src) => {
        const doc = new DOMParser().parseFromString(src, 'application/xml');
        const ns = 'http://www.sitemaps.org/schemas/sitemap/0.9';
        return {
          parseError: doc.getElementsByTagName('parsererror').length > 0,
          rootName: doc.documentElement.localName,
          rootNs: doc.documentElement.namespaceURI,
          locs: [...doc.getElementsByTagNameNS(ns, 'loc')].map((n) => (n.textContent ?? '').trim()),
          extras: ['lastmod', 'changefreq', 'priority'].reduce((n, t) => n + doc.getElementsByTagNameNS(ns, t).length, 0),
        };
      }, xml);
      expect(parsed.parseError, 'sitemap.xml parses').toBe(false);
      expect(parsed.rootName).toBe('urlset');
      expect(parsed.rootNs).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
      expect(parsed.extras, 'no lastmod / changefreq / priority').toBe(0);
      const expected = builtHtml.filter((p) => p !== '404.html').map(canonical).sort();
      expect(expected.length).toBeGreaterThan(0);
      expect([...parsed.locs].sort()).toEqual(expected);
      expect(parsed.locs, 'the one-pager is in the sitemap').toContain(`${SITE_URL}log-hub-onepager/`);
    });

    await test.step('16. every page has a unique description, canonical and matching og/twitter tags', async () => {
      const seen = new Map<string, string>();
      for (const [url, html] of site.html) {
        const rel = url.slice(server.base.length);
        const title = decodeAttr(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '');
        expect(title, `${rel}: title`).not.toBe('');
        const descriptions = metaContent(html, 'name', 'description');
        expect(descriptions, `${rel}: exactly one description`).toHaveLength(1);
        const d = descriptions[0];
        expect(d.length, `${rel}: description length`).toBeGreaterThanOrEqual(50);
        expect(d.length, `${rel}: description length`).toBeLessThanOrEqual(160);
        expect(seen.get(d), `${rel}: description duplicates ${seen.get(d)}`).toBeUndefined();
        seen.set(d, rel);
        const c = canonical(rel);
        expect(linkHrefs(html, 'canonical'), `${rel}: canonical`).toEqual([c]);
        expect(metaContent(html, 'property', 'og:title'), `${rel}: og:title`).toEqual([title]);
        expect(metaContent(html, 'property', 'og:description'), `${rel}: og:description`).toEqual([d]);
        expect(metaContent(html, 'property', 'og:url'), `${rel}: og:url`).toEqual([c]);
        expect(metaContent(html, 'property', 'og:image'), `${rel}: og:image`).toEqual([OG_IMAGE_URL]);
        expect(metaContent(html, 'property', 'og:image:width'), `${rel}: og:image:width`).toEqual(['1200']);
        expect(metaContent(html, 'property', 'og:image:height'), `${rel}: og:image:height`).toEqual(['630']);
        expect(metaContent(html, 'property', 'og:image:alt'), `${rel}: og:image:alt`).toEqual([OG_IMAGE_ALT]);
        expect(metaContent(html, 'property', 'og:type'), `${rel}: og:type`).toEqual(['website']);
        expect(metaContent(html, 'property', 'og:site_name'), `${rel}: og:site_name`).toEqual([SITE_NAME]);
        expect(metaContent(html, 'name', 'twitter:card'), `${rel}: twitter:card`).toEqual(['summary_large_image']);
      }
      expect(site.html.has(`${server.base}deck/index.html`), 'the deck is among the checked pages').toBe(true);
      expect(site.html.has(`${server.base}${ONEPAGER}`), 'the one-pager is among the checked pages').toBe(true);
    });

    await test.step('17. favicon and apple-touch-icon are real files, og-image is 1200×630', async () => {
      for (const rel of builtHtml) {
        const html = fs.readFileSync(path.join(SITE_DIR, rel), 'utf8');
        expect(html.includes('href="data:,"'), `${rel}: empty data: icon`).toBe(false);
      }
      const favicon = `${server.base}assets/favicon.svg`;
      const touchIcon = `${server.base}assets/apple-touch-icon.png`;
      for (const p of ['index.html', 'deck/index.html', ONEPAGER]) {
        const pageUrl = `${server.base}${p}`;
        const html = site.html.get(pageUrl) as string;
        const icons = linkHrefs(html, 'icon').map((h) => new URL(h, pageUrl).href);
        expect(icons, `${p}: <link rel="icon">`).toEqual([favicon]);
        const touch = linkHrefs(html, 'apple-touch-icon').map((h) => new URL(h, pageUrl).href);
        expect(touch, `${p}: <link rel="apple-touch-icon">`).toEqual([touchIcon]);
      }
      expect(site.status.get(favicon), 'favicon status').toBe(200);
      expect(site.status.get(touchIcon), 'apple-touch-icon status').toBe(200);
      const built = fs.readFileSync(path.join(SITE_DIR, 'assets', 'favicon.svg'));
      const source = fs.readFileSync(path.join(REPO_ROOT, 'client', 'public', 'favicon.svg'));
      expect(built.equals(source), 'site favicon is byte-equal to client/public/favicon.svg').toBe(true);
      expect(pngSize(path.join(SITE_DIR, 'assets', 'og-image.png'))).toEqual({ width: 1200, height: 630 });
      expect(pngSize(path.join(SITE_DIR, 'assets', 'apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
    });

    await test.step('18. 404.html: noindex, no canonical, absolute URLs, styled from a nested missing URL', async () => {
      const missing = `${server.base}docs/no/such/deeper/page.html`;
      const res = await fetch(missing);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').toMatch(/^text\/html/);
      const html = await res.text();
      expect(decodeAttr(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '')).toBe('Page not found — Artisyn Log Hub');
      expect(metaContent(html, 'name', 'robots')).toEqual(['noindex']);
      expect(linkHrefs(html, 'canonical'), 'no canonical').toEqual([]);
      expect(/<meta\s[^>]*property="og:/.test(html), 'no og: meta').toBe(false);
      expect(metaContent(html, 'name', 'description'), 'no description').toEqual([]);
      expect(html.includes('aria-current'), 'no aria-current').toBe(false);
      const relative: string[] = [];
      for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
        const href = decodeAttr(m[1]);
        if (href.startsWith('#') || href.startsWith('data:') || href.startsWith('mailto:')) continue;
        if (new URL(href, SITE_URL).href.startsWith(SITE_URL) && !href.startsWith(SITE_URL)) relative.push(href);
      }
      expect(relative, 'local href/src not absolute under SITE_URL').toEqual([]);

      // Served from the published origin (routed to the local build), the 404 page is styled and has its icon.
      const routed = new Map<string, number>();
      await page.route(`${SITE_URL}**`, async (route) => {
        const url = new URL(route.request().url());
        const rel = decodeURIComponent(url.pathname).slice(new URL(SITE_URL).pathname.length);
        const file = path.resolve(SITE_DIR, rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel);
        const inside = path.relative(SITE_DIR, file);
        const ok = !inside.startsWith('..') && !path.isAbsolute(inside) && fs.existsSync(file) && fs.statSync(file).isFile();
        routed.set(`${url.origin}${url.pathname}`, ok ? 200 : 404);
        if (!ok) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
        return route.fulfill({
          status: 200,
          contentType: CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
          body: fs.readFileSync(file),
        });
      });
      try {
        await page.setViewportSize({ width: 1280, height: 720 });
        const nav = await page.goto(missing);
        expect(nav?.status()).toBe(404);
        await expect(page).toHaveTitle('Page not found — Artisyn Log Hub');
        await expect(page.locator('.not-found h1')).toHaveText('This page does not exist.');
        // theme.css is applied: .not-found gets its max-width (the browser default is none).
        await expect
          .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.not-found') as Element).maxWidth))
          .toBe('720px');
        expect(routed.get(`${SITE_URL}assets/theme.css`), 'theme.css served').toBe(200);
        const iconLoaded = await page.evaluate(() => {
          const href = (document.querySelector('link[rel="icon"]') as HTMLLinkElement).href;
          return new Promise<boolean>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = href;
          });
        });
        expect(iconLoaded, 'the favicon loads').toBe(true);
        expect(routed.get(`${SITE_URL}assets/favicon.svg`), 'favicon status').toBe(200);
      } finally {
        await page.unroute(`${SITE_URL}**`);
      }
    });

    await test.step('19. Home media carousel: items.json, media files, tour GIF, first load, autoplay, reduced motion, 375 px', async () => {
      const home = `${server.base}index.html`;
      const homeHtml = site.html.get(home) as string;
      // The section sits after the hero (the crawl saw the page; the DOM order is checked in the browser below).
      expect(homeHtml.includes('class="media-section"'), 'Home has the media section').toBe(true);

      const res = await fetch(`${server.base}assets/demo/items.json`);
      expect(res.status, 'items.json status').toBe(200);
      const items = (await res.json()) as DemoItem[];
      expect(Array.isArray(items), 'items.json is an array').toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(30);
      expect(items[0].kind).toBe('tour');
      expect(items[0].src).toBe('assets/demo/app-tour.gif');
      // The crawl does not read JSON paths: every src / still / thumb must answer 200 with its media type.
      const media = new Set<string>();
      for (const it of items) for (const p of [it.src, it.still, it.thumb]) if (p) media.add(p);
      for (const p of media) {
        const r = await fetch(`${server.base}${p}`);
        expect(r.status, `${p} status`).toBe(200);
        expect(r.headers.get('content-type'), `${p} content-type`).toBe(CONTENT_TYPES[path.extname(p)]);
        await r.arrayBuffer();
      }

      const tourFile = path.join(SITE_DIR, 'assets', 'demo', 'app-tour.gif');
      const tour = gifInfo(tourFile);
      expect({ width: tour.width, height: tour.height }, 'app-tour.gif logical size').toEqual({ width: 960, height: 600 });
      expect(tour.loop, 'app-tour.gif NETSCAPE2.0 loop count').toBe(0);
      expect(fs.statSync(tourFile).size, 'app-tour.gif bytes').toBeLessThanOrEqual(5_000_000);
      expect(tour.durationMs, 'app-tour.gif duration').toBeGreaterThanOrEqual(22_000);
      expect(tour.durationMs, 'app-tour.gif duration').toBeLessThanOrEqual(28_000);

      const nn = String(items.length).padStart(2, '0');
      const stageLoaded = (p: Page, srcEnd: string) =>
        p.waitForFunction((end) => {
          const img = document.querySelector('.mc-stage img.mc-media') as HTMLImageElement | null;
          return img !== null && img.getAttribute('src')?.endsWith(end) === true && img.complete && img.naturalWidth > 0;
        }, srcEnd);

      // Desktop first load: only the tour GIF is requested as full media (thumbnails and items.json aside).
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      try {
        const dp = await desktop.newPage();
        const demoRequests: string[] = [];
        dp.on('request', (req) => {
          const u = req.url();
          if (u.startsWith(`${server.base}assets/demo/`) && !u.includes('/thumbs/') && /\.(gif|png)$/.test(u)) demoRequests.push(u);
        });
        await dp.goto(home);
        const mc = dp.locator('.media-section [data-mc]');
        await expect(mc).toHaveCount(1);
        const afterHero = await dp.evaluate(() => {
          const hero = document.querySelector('.hero');
          const section = document.querySelector('.media-section');
          return hero !== null && section !== null && (hero.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        });
        expect(afterHero, '.media-section follows .hero').toBe(true);
        const counter = dp.locator('.mc-counter');
        await expect(counter).toHaveText(`01 / ${nn}`);
        await stageLoaded(dp, 'app-tour.gif');
        expect(demoRequests, 'full media requested on first load').toEqual([`${server.base}assets/demo/app-tour.gif`]);

        // Autoplay: a still stays 5 s after its image has loaded, then the next item comes.
        expect(items[1].kind, 'item 2 is a still').toBe('still');
        await dp.locator('.mc-strip .mc-thumb').nth(1).click();
        await expect(counter).toHaveText(`02 / ${nn}`);
        await stageLoaded(dp, items[1].src);
        const t0 = Date.now();
        await expect(counter).toHaveText(`03 / ${nn}`, { timeout: 8000 });
        expect(Date.now() - t0, 'the still stayed before advancing').toBeGreaterThanOrEqual(4500);
        // Pause stops the slideshow.
        const pause = dp.locator('.mc-pause');
        await pause.click();
        await expect(pause).toHaveAttribute('aria-pressed', 'true');
        await dp.waitForTimeout(6000);
        await expect(counter).toHaveText(`03 / ${nn}`);
      } finally {
        await desktop.close();
      }

      // Reduced motion: starts paused and the tour shows its still first frame.
      const reduced = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      try {
        const rp = await reduced.newPage();
        await rp.goto(home);
        await expect(rp.locator('.mc-pause')).toHaveAttribute('aria-pressed', 'true');
        await expect(rp.locator('.mc-stage img.mc-media')).toHaveAttribute('src', /app-tour\.png$/);
      } finally {
        await reduced.close();
      }

      // 375 px: the strip is hidden, the controls and the counter stay (no horizontal scroll is step 7).
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(home);
      await expect(page.locator('.mc-counter')).toHaveText(`01 / ${nn}`);
      await expect(page.locator('.mc-strip')).toBeHidden();
      for (const sel of ['.mc-prev', '.mc-next', '.mc-pause', '.mc-counter']) await expect(page.locator(sel), sel).toBeVisible();
    });

    await test.step('20. one-pager: content, one screen at 1280×720, 360 px, no external request, light print, one-page landscape PDF at A4 and Letter', async () => {
      const url = `${server.base}${ONEPAGER}`;
      const firstRequest = requests.length;
      await page.emulateMedia({ media: 'screen', colorScheme: 'light' });
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(url);

      // Content: the hook from the dataset, eight groups, the screenshot, four links, the footer.
      expect((site.html.get(url) as string).includes('{{'), 'no unfilled placeholder').toBe(false);
      const ds = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'site', 'data', 'example-dataset.json'), 'utf8')) as {
        session: { durationMin: number; total: number; outcome: string };
      };
      const h1 = page.locator('h1');
      await expect(h1).toContainText(`It ran alone for ${ds.session.durationMin} minutes`);
      await expect(h1).toContainText(`$${Math.round(ds.session.total)}`);
      await expect(h1).toContainText(ds.session.outcome);
      await expect(h1).toContainText('All good?');
      const groups = await page.locator('.op-groups li').evaluateAll((lis) => lis.map((li) => li.getAttribute('data-group')));
      expect(groups).toEqual(['cost', 'speed', 'context', 'quality', 'team', 'tools', 'safety', 'trust']);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const img = document.querySelector('.op-shot img') as HTMLImageElement | null;
            return img !== null && img.getAttribute('src') === '../assets/shots/spend-budget.png' && img.complete && img.naturalWidth > 0;
          }),
        )
        .toBe(true);
      await expect(page.locator('.op-footer')).toHaveText('Open source by DataArt · MIT · not affiliated with Anthropic');
      await expect(page.locator('a.op-back')).toHaveAttribute('href', '../index.html');
      const links = await page.locator('.op-links a').evaluateAll((as) =>
        as.map((a) => ({ text: (a.textContent ?? '').trim(), href: a.getAttribute('href') })),
      );
      expect(links).toEqual([SITE_URL, REPO_URL, RELEASES_URL, `${SITE_URL}deck/`].map((u) => ({ text: u, href: u })));

      // One screen: no page scroll in either direction and the footer inside the viewport.
      const fit = await page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        footerBottom: (document.querySelector('.op-footer') as Element).getBoundingClientRect().bottom,
      }));
      expect(fit.scrollHeight, 'vertical scroll at 1280×720').toBeLessThanOrEqual(fit.clientHeight);
      expect(fit.scrollWidth, 'horizontal scroll at 1280×720').toBeLessThanOrEqual(fit.clientWidth);
      expect(fit.footerBottom, 'footer inside the 720 px viewport').toBeLessThanOrEqual(720);

      await page.setViewportSize({ width: 360, height: 800 });
      const narrow = await layoutMetrics(page);
      expect(narrow.scrollWidth, 'horizontal scroll at 360 px').toBeLessThanOrEqual(narrow.clientWidth);
      expect(narrow.fontSize, 'body font size at 360 px').toBeGreaterThanOrEqual(16);

      // Print is light whatever the reader's color scheme, without the back link.
      const printColors = async (colorScheme: 'light' | 'dark') => {
        await page.emulateMedia({ media: 'print', colorScheme });
        return page.evaluate(() => {
          const cs = getComputedStyle(document.body);
          return { color: cs.color, backgroundColor: cs.backgroundColor };
        });
      };
      const printLight = await printColors('light');
      expect(await printColors('dark'), 'print colors under a dark scheme').toEqual(printLight);
      await expect(page.locator('.op-back')).toBeHidden();
      // The printable area of a landscape A4 and Letter page at 10 mm margins.
      for (const viewport of [{ width: 1047, height: 718 }, { width: 980, height: 740 }]) {
        await page.setViewportSize(viewport);
        const m = await layoutMetrics(page);
        expect(m.scrollWidth, `horizontal scroll in print at ${viewport.width} px`).toBeLessThanOrEqual(m.clientWidth);
      }

      // "Save as PDF" gives one landscape page (dark scheme still emulated).
      for (const format of ['A4', 'Letter'] as const) {
        const pdf = await page.pdf({ format, landscape: true });
        const pdfPages = pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? [];
        expect(pdfPages.length, `${format} landscape PDF pages`).toBe(1);
      }

      const foreign = requests.slice(firstRequest).filter((u) => !u.startsWith(`${origin}/`));
      expect(foreign, 'the one-pager requests nothing outside the site').toEqual([]);

      await page.emulateMedia({ media: 'screen', colorScheme: 'light' });
      await page.setViewportSize({ width: 1280, height: 720 });
    });
  } finally {
    await server.close();
  }
});
