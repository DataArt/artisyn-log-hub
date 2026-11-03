// S-SITE-01. The static Log Hub site and the "Why Log Hub" deck: built, served under a base path,
// navigable, responsive, dark-mode aware, with no leaked e-mails or local paths
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
const TOP_NAV = ['Home', 'Features', 'Get started', 'Configuration', 'Using Log Hub', 'Data & security', 'Questions', 'Deck', 'GitHub ↗'];

/** An external request may only go to jsDelivr with an exact `name@x.y.z` version. */
const VERSIONED_CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+\//;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.xml': 'application/xml; charset=utf-8',
};

/** Text files of the build output that the artifact grep reads. */
const TEXT_EXT = new Set(['.html', '.css', '.js', '.json', '.md', '.svg', '.txt', '.xml']);

/** Published site root and og-image values — must equal SITE_URL / OG_IMAGE_* in scripts/site/layout.mjs. */
const SITE_URL = 'https://dataart.github.io/artisyn-log-hub/';
const SITE_NAME = 'Artisyn Log Hub';
const OG_IMAGE_URL = `${SITE_URL}assets/og-image.png`;
const OG_IMAGE_ALT = 'Log Hub cost flow: model to user to branch';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Not mailboxes: the SSH remote form of a git URL used as an example in how-hook-works. */
const EMAIL_ALLOWED = new Set(['git@github.com']);
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

test('@S-SITE-01 static site and deck: built, served under a base path, navigable, responsive @mode-a', async ({ page }) => {
  test.setTimeout(240_000);

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

    await test.step('2. every non-deck page has the same top nav, and every nav target answers 200', async () => {
      await page.setViewportSize({ width: 1280, height: 720 });
      for (const url of pages) {
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
        if (label !== 'Deck') await expect(page.locator('nav.site-nav a[aria-current="page"]'), label).toHaveText(label);
        await page.goto(`${server.base}index.html`);
      }
    });

    await test.step('3. Home: the thesis, three questions and links to the deck, Features and Get started', async () => {
      await page.goto(`${server.base}index.html`);
      await expect(page.locator('h1')).toContainText('Is that good?');
      await expect(page.locator('.hero .lead').first()).toContainText('right and useful');
      await expect(page.locator('.hero')).toContainText('Log Hub answers the next questions');
      await expect(page.locator('.cards .card')).toHaveCount(3);
      await expect(page.locator('main a[href="deck/index.html"]')).not.toHaveCount(0);
      await expect(page.locator('main a[href^="features.html"]')).not.toHaveCount(0);
      await expect(page.locator('main a[href="docs/install-server.html"]')).not.toHaveCount(0);
    });

    await test.step('4. Features: eight blocks A–H, each with its question', async () => {
      await page.goto(`${server.base}features.html`);
      for (const block of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
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

    await test.step('6. dark mode: prefers-color-scheme changes the background of the site and the deck', async () => {
      for (const p of ['index.html', 'docs/install-server.html', 'deck/index.html']) {
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

    const slideCount = await test.step('9. deck: 10–20 slides, every slide fits 1280×720, arrows move between slides', async () => {
      await page.goto(`${server.base}deck/index.html`);
      await page.waitForFunction(() => document.querySelector('.reveal.ready') !== null);
      const count = await page.locator('.reveal .slides > section').count();
      expect(count).toBeGreaterThanOrEqual(10);
      expect(count).toBeLessThanOrEqual(20);
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
            const copy = body.cloneNode(true) as HTMLElement;
            copy.querySelectorAll('.illustrative').forEach((n) => n.remove());
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

    await test.step('11. every figure block carries the "Illustrative example" label (deck and site)', async () => {
      const unlabeled = async (selector: string) =>
        page.locator(selector).evaluateAll((els) =>
          els.filter((el) => !el.querySelector('.illustrative')).map((el) => (el.textContent ?? '').trim().slice(0, 60)),
        );
      expect(await page.locator('.deck-figure').count()).toBeGreaterThan(0);
      expect(await unlabeled('.deck-figure'), 'deck').toEqual([]);
      for (const p of ['index.html', 'features.html']) {
        await page.goto(`${server.base}${p}`);
        expect(await page.locator('.figure-block').count(), p).toBeGreaterThan(0);
        expect(await unlabeled('.figure-block'), p).toEqual([]);
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
    });

    await test.step('17. favicon and apple-touch-icon are real files, og-image is 1200×630', async () => {
      for (const rel of builtHtml) {
        const html = fs.readFileSync(path.join(SITE_DIR, rel), 'utf8');
        expect(html.includes('href="data:,"'), `${rel}: empty data: icon`).toBe(false);
      }
      const favicon = `${server.base}assets/favicon.svg`;
      const touchIcon = `${server.base}assets/apple-touch-icon.png`;
      for (const p of ['index.html', 'deck/index.html']) {
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
  } finally {
    await server.close();
  }
});
