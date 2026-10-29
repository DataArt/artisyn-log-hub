// Tour 10 — the screen registry does not rot (impl-plan DD G6;
// docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3 story 10, §2.4 layer A). No browser, no stand.
//
// Imports the client's own pure constant modules (DD G3: no React, router, CSS or assets, so
// Playwright's TS transform loads them from Node) and compares what the app has with what the
// registry covers, in both directions:
//   - routes:     APP_ROUTES (client/src/app-routes.ts)                      ↔ rows' `route`
//   - tabs:       SESSION_TABS, REPO_MAIN_TABS, ADMIN_TABS, SETTINGS_TABS,
//                 TEAM_TABS, API_KEYS_TABS, CHART_TABS (client/src/viewer/tab-ids.ts) ↔ rows' `tab`
//   - analytics:  VIEW_OPTIONS (analytics-state.ts)                           ↔ `analytics:<view>`
//   - reports:    ALL_REPORTS (report-catalog.ts)                             ↔ `report:<id>`
//   - help:       user-docs/nav.json (read via helpers/help-nav)                ↔ `help:<slug>`;
//                 its slugs ↔ user-docs/*.md plus the `source` files, and every relative link of
//                 every page resolves (scripts/user-docs/links.js, the help generator's own rules)
// A new route / tab / view / report / article without a row fails («add a row to
// screen-registry.ts»), and so does a row for something the app no longer has.
//
// It also keeps the registry itself sound: unique ids, an anchor on every row, only the params
// its story provides, a spec file per story, `docRef` files and headings that exist (block J cuts
// the docs by them), and help rows whose anchor is the article's real `# heading`.
//
// The runtime half of 06 §2.4 (layer B: rendered tab triggers vs registry rows) runs inside the
// tours (`expectTabsOnScreen`).
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures';
import { APP_ROUTES } from '../../../client/src/app-routes';
import {
  ADMIN_TABS,
  API_KEYS_TABS,
  CHART_TABS,
  REPO_MAIN_TABS,
  SESSION_TABS,
  SETTINGS_TABS,
  TEAM_TABS,
} from '../../../client/src/viewer/tab-ids';
import { VIEW_OPTIONS } from '../../../client/src/viewer/pages/repository/analytics/analytics-state';
import { ALL_REPORTS } from '../../../client/src/viewer/pages/repository/reports/report-catalog';
import { findLinks, helpNav, helpPageFile, helpPages, resolveLink } from '../helpers/help-nav';
import { SCREEN_REGISTRY, STORY_PARAMS, coverageKeys, rowParams, type TourId } from './screen-registry';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const USER_DOCS = path.join(ROOT, 'user-docs');

const TAB_SOURCES: Record<string, readonly string[]> = {
  session: SESSION_TABS,
  repo: REPO_MAIN_TABS,
  admin: ADMIN_TABS,
  settings: SETTINGS_TABS,
  team: TEAM_TABS,
  apikeys: API_KEYS_TABS,
  chart: CHART_TABS,
};

/** Everything the app has that needs a registry row, as coverage keys. */
function appKeys(): Set<string> {
  const keys = new Set<string>();
  for (const route of APP_ROUTES) keys.add(`route:${route}`);
  for (const [group, ids] of Object.entries(TAB_SOURCES)) for (const id of ids) keys.add(`tab:${group}:${id}`);
  for (const view of VIEW_OPTIONS) keys.add(`analytics:${view.value}`);
  for (const report of ALL_REPORTS) keys.add(`report:${report.id}`);
  for (const section of helpNav) for (const article of section.articles) keys.add(`help:${article.slug}`);
  return keys;
}

function registryKeys(): Set<string> {
  return new Set(SCREEN_REGISTRY.flatMap(coverageKeys));
}

/** Heading texts (without `#`s) of a Markdown file, fenced code blocks skipped. */
function headings(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

test.describe('@TOUR-10 registry completeness (meta) @mode-a', () => {
  test('every route, tab, analytics view, report and help article of the app has a registry row, and no row is stale', () => {
    const app = appKeys();
    const covered = registryKeys();
    const missing = [...app].filter((k) => !covered.has(k)).sort();
    const stale = [...covered].filter((k) => !app.has(k)).sort();
    expect(missing, 'the app has these, the registry does not — add a row to tests/scenarios/tours/screen-registry.ts').toEqual([]);
    expect(stale, 'the registry covers these, the app no longer has them — remove or fix the row').toEqual([]);
  });

  test('help: nav.json lists exactly user-docs/*.md plus its source files', () => {
    const files = fs
      .readdirSync(USER_DOCS)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length));
    const sourced = helpNav.flatMap((s) => s.articles.filter((a) => a.source).map((a) => a.slug));
    const nav = helpNav.flatMap((s) => s.articles.filter((a) => !a.source).map((a) => a.slug)).sort();
    expect(nav, 'nav.json entries without `source` vs user-docs/*.md files').toEqual(files.sort());
    const missing = sourced.filter((slug) => !fs.existsSync(path.join(ROOT, helpPageFile(slug))));
    expect(missing, 'nav.json `source` files that do not exist').toEqual([]);
  });

  test('help: every relative link of every page resolves to a page of the set', () => {
    const problems: string[] = [];
    for (const page of helpPages) {
      for (const href of findLinks(fs.readFileSync(page.file, 'utf8'))) {
        if (resolveLink(href, page.file, { pages: helpPages }).kind === 'unresolved') {
          problems.push(`${helpPageFile(page.slug)}: ${href}`);
        }
      }
    }
    expect(problems, 'unresolved links (fix the link or add the page to user-docs/nav.json)').toEqual([]);
  });

  test('rows: unique ids, an anchor each, valid modes, only the params of their story, a spec per story', () => {
    const ids = SCREEN_REGISTRY.map((r) => r.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i), 'duplicate row ids').toEqual([]);

    const problems: string[] = [];
    for (const row of SCREEN_REGISTRY) {
      if (!row.expectText && !row.expectTestId && !row.expectSelector && !row.expectUrl) problems.push(`${row.id}: no anchor`);
      if (row.modes.length === 0 || row.modes.some((m) => !['a', 'b', 'c'].includes(m))) problems.push(`${row.id}: bad modes`);
      if (!row.title.trim()) problems.push(`${row.id}: no title`);
      if (row.dataOptional && !row.emptyText && !row.expectText && !row.expectSelector) {
        problems.push(`${row.id}: dataOptional needs a meaningful empty-state anchor`);
      }
      const allowed = new Set(STORY_PARAMS[row.story]);
      for (const p of rowParams(row)) if (!allowed.has(p)) problems.push(`${row.id}: param {${p}} is not provided by ${row.story}`);
    }
    expect(problems).toEqual([]);

    const specs = fs.readdirSync(__dirname);
    const stories = Object.keys(STORY_PARAMS) as TourId[];
    for (const story of stories) {
      expect(SCREEN_REGISTRY.some((r) => r.story === story), `${story} has rows`).toBe(true);
      expect(specs.some((f) => f.startsWith(`${story}-`) && f.endsWith('.spec.ts')), `${story} has a spec file`).toBe(true);
    }
  });

  test('docRef: every referenced file and heading exists', () => {
    const problems: string[] = [];
    for (const row of SCREEN_REGISTRY) {
      if (!row.docRef) continue;
      const file = path.join(ROOT, row.docRef.file);
      if (!fs.existsSync(file)) {
        problems.push(`${row.id}: ${row.docRef.file} does not exist`);
        continue;
      }
      if (row.docRef.heading && !headings(fs.readFileSync(file, 'utf8')).includes(row.docRef.heading)) {
        problems.push(`${row.id}: no heading «${row.docRef.heading}» in ${row.docRef.file}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("help rows: the anchor is the article's first # heading", () => {
    const problems: string[] = [];
    for (const row of SCREEN_REGISTRY.filter((r) => r.id.startsWith('help.'))) {
      const slug = row.id.slice('help.'.length);
      const md = fs.readFileSync(path.join(ROOT, helpPageFile(slug)), 'utf8');
      const h1 = /^#\s+(.+?)\s*$/m.exec(md)?.[1];
      if (row.expectText !== h1) problems.push(`${row.id}: expectText «${row.expectText}» vs # heading «${h1}»`);
    }
    expect(problems).toEqual([]);
  });
});
