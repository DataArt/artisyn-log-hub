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
};

/** Text files of the build output that the artifact grep reads. */
const TEXT_EXT = new Set(['.html', '.css', '.js', '.json', '.md', '.svg', '.txt']);

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
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound();
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

    await test.step('4. Features: six blocks A–F, each with its question', async () => {
      await page.goto(`${server.base}features.html`);
      for (const block of ['a', 'b', 'c', 'd', 'e', 'f']) {
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
  } finally {
    await server.close();
  }
});
