/**
 * reports.ts — REPO-GOLD loading and the Analytics / Reports screens, for the S-COST, S-ANLT and
 * S-REPT scenarios (`docs/qaa-overview/scenarios/03` §4).
 *
 *  - `uploadRepoGold(api, db, owner, fixtures)` loads golden fixtures into one repository (by default
 *    all nine, i.e. the ten roots of REPO-GOLD) and returns the fixture-relative → loaded-copy date
 *    mapping, the API range A..A+13d and a root id per `expected.json` key (`gs06a`, `gs06b`, …).
 *  - `openReport(page, …)` deep-links the Reports tab (`mtab=reports&report=…&startDate=…`); the
 *    report generates from the URL, so no Generate click is needed for the committed parameters.
 *  - `downloadPdfText(page)` clicks «Download as PDF» and returns the PDF's text (`pdf-text.ts`).
 *
 * Dates: the Reports and Analytics screens turn their `YYYY-MM-DD` bounds into local midnight /
 * end-of-day. Specs that use them pin the browser to UTC (`test.use({ timezoneId: 'UTC' })`) so the
 * UI range equals the API range the spec computes.
 */
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Pool } from 'pg';
import type { ScenarioUser } from '../fixtures';
import {
  GOLDEN_FIXTURE_IDS,
  loadExpected,
  loadRepoGoldExpected,
  shiftGoldenTime,
  type GoldenRootExpected,
  type RepoGoldExpected,
} from './golden';
import { extractPdfText } from './pdf-text';
import { uploadGoldenRepo, type GoldenRepo } from './session-view';
import { skipNewUserNudge } from './teams';

export interface RepoGold extends GoldenRepo {
  /** `tests/golden/repo-gold.expected.json`. */
  totals: RepoGoldExpected;
  /** Whole days between the fixtures' anchor `A` and the loaded copy. */
  deltaDays: number;
  /** `expected.json` root by its key (`gs01` … `gs09`, `gs06a`, `gs06b`). */
  expected: Map<string, GoldenRootExpected>;
  /** Uploaded root session id by its key. */
  sid(key: string): string;
  /** The key of an uploaded root session id. */
  keyOf(sessionId: string): string;
  /** A fixture-relative ISO time on the loaded copy. */
  at(iso: string): Date;
  /** A fixture-relative `YYYY-MM-DD` day on the loaded copy, as `YYYY-MM-DD`. */
  day(fixtureDay: string): string;
  /** API bounds of A..A+13d (`startDate`/`endDate`, ISO). */
  range: { startDate: string; endDate: string };
}

/** Uploads golden fixtures (default: all of REPO-GOLD) into one repository owned by `owner`. */
export async function uploadRepoGold(
  api: APIRequestContext,
  db: Pool,
  owner: ScenarioUser,
  fixtures: readonly string[] = GOLDEN_FIXTURE_IDS,
): Promise<RepoGold> {
  const repo = await uploadGoldenRepo(api, db, owner, [...fixtures]);
  const deltaDays = repo.loaded[fixtures[0]].deltaDays;
  const expected = new Map<string, GoldenRootExpected>();
  const ids = new Map<string, string>();
  for (const f of fixtures) {
    const exp = loadExpected(f);
    for (const root of repo.loaded[f].roots) {
      const e = exp.roots.find((r) => r.key === root.key);
      if (!e) throw new Error(`${f}/expected.json has no root "${root.key}"`);
      expected.set(root.key, e);
      ids.set(root.key, root.sessionId);
    }
  }
  const totals = loadRepoGoldExpected();
  const at = (iso: string) => shiftGoldenTime(iso, deltaDays);
  return {
    ...repo,
    totals,
    deltaDays,
    expected,
    sid: (key) => {
      const id = ids.get(key);
      if (!id) throw new Error(`no uploaded root "${key}"`);
      return id;
    },
    keyOf: (sessionId) => {
      const hit = [...ids.entries()].find(([, id]) => id === sessionId);
      if (!hit) throw new Error(`session ${sessionId} is not a golden root`);
      return hit[0];
    },
    at,
    day: (fixtureDay) => at(`${fixtureDay}T00:00:00.000Z`).toISOString().slice(0, 10),
    range: { startDate: at(totals.range.start).toISOString(), endDate: at(totals.range.end).toISOString() },
  };
}

/** `GET /api/v1/repositories/:id<route>` as `user`, asserting 200. */
export async function repoGet<T>(
  user: ScenarioUser,
  repoId: number,
  route: string,
  params: Record<string, string> = {},
): Promise<T> {
  const res = await user.api.get(`/api/v1/repositories/${repoId}${route}`, { params });
  expect(res.status(), `GET ${route} ${JSON.stringify(params)}: ${res.status()}`).toBe(200);
  return (await res.json()) as T;
}

export interface ReportParams {
  startDate: string;
  endDate: string;
  branches?: string[];
  groupBy?: 'branch' | 'user';
}

/** Signs `user` in and opens one report of `repoId` with the given (committed) parameters. */
export async function openReport(
  page: Page,
  user: ScenarioUser,
  repoId: number,
  report: string,
  params: ReportParams,
): Promise<void> {
  await skipNewUserNudge(page.context());
  await user.signIn(page);
  const q = new URLSearchParams({ mtab: 'reports', report, startDate: params.startDate, endDate: params.endDate });
  if (params.branches?.length) q.set('branches', params.branches.join(','));
  if (params.groupBy) q.set('groupBy', params.groupBy);
  await page.goto(`/#/repos/${repoId}?${q.toString()}`);
  await expect(page.getByRole('button', { name: 'Download as PDF' })).toBeEnabled({ timeout: 15_000 });
}

/** Signs `user` in and opens the Analytics tab of `repoId` with `ar=custom` and the given URL state. */
export async function openAnalytics(
  page: Page,
  user: ScenarioUser,
  repoId: number,
  state: { from: string; to: string; view?: string; layout?: 'horizontal'; groupBy?: 'branch' | 'user' },
): Promise<void> {
  await skipNewUserNudge(page.context());
  await user.signIn(page);
  const q = new URLSearchParams({ mtab: 'analytics', ar: 'custom', af: state.from, at: state.to });
  if (state.view) q.set('av', state.view);
  if (state.layout) q.set('al', state.layout);
  if (state.groupBy) q.set('ag', state.groupBy);
  await page.goto(`/#/repos/${repoId}?${q.toString()}`);
}

/** Clicks «Download as PDF» and returns the downloaded file's name and text. */
export async function downloadPdfText(page: Page): Promise<{ filename: string; text: string }> {
  const button = page.getByRole('button', { name: 'Download as PDF' });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const file = await download.path();
  if (!file) throw new Error('the PDF download produced no file');
  return { filename: download.suggestedFilename(), text: extractPdfText(file) };
}

/** An Executive Summary KPI tile (`Total AI Cost`, `Total Sessions`, …) by its exact label. */
export function kpiTile(page: Page, label: string): Locator {
  return page
    .getByText(label, { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "relative") and contains(@class, "overflow-hidden")]')
    .first();
}

/** The value cells of a report KPI table row (`Cache read ratio`, `Avg Cost / Line`, …). */
export function kpiRowValues(page: Page, label: string): Locator {
  return page
    .locator('tr')
    .filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^\\s*(↳\\s*)?${escapeRe(label)}\\s*$`) }) })
    .first()
    .locator('td:not(:first-child)');
}

/** A `<section>` of a report by its `<h2>` heading. */
export function reportSection(page: Page, heading: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
