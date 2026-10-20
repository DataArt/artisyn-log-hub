/**
 * session-view.ts — loading golden sessions for one owner and reading the session detail pane
 * (Summary, Info, Logs, Statistics, Change surface, Raw Logs) for the S-SESS scenarios.
 *
 *  - `uploadGoldenRepo(api, db, owner, fixtures)` uploads the given golden fixtures with a fresh API
 *    key into one repository (one shared run id) and returns its id and every session id.
 *  - `openSession(page, …)` navigates the SPA straight to a session (`?session=`, `&tab=`).
 *  - Readers address the UI the way a person reads it — a label and the value next to it — so a
 *    restyle that keeps the labels keeps the scenario green.
 *  - `usd4` / `pct1` / `hms` format `expected.json` literals the way the UI prints them. They are
 *    display formats only: the numbers themselves always come from `expected.json` (DD D3).
 */
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Pool } from 'pg';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from './api-key';
import { defaultGoldenBase, goldenRunId, materializeGolden, uploadGolden, type UploadedGolden } from './golden';
import { skipNewUserNudge } from './teams';

export interface GoldenRepo {
  repoId: number;
  repoUrl: string;
  runId: string;
  /** Every uploaded fixture by id (`gs-01`, …). */
  loaded: Record<string, UploadedGolden>;
  /** Root session id of a single-root fixture. */
  rootId(fixtureId: string): string;
  /** Sub-agent session id by its `upload.json` key (`a`, `b`, …) in a single-root fixture. */
  agentId(fixtureId: string, key: string): string;
}

/** Uploads `fixtures` as `owner` (one API key, one run id → one repository) and finds the repository. */
export async function uploadGoldenRepo(
  api: APIRequestContext,
  db: Pool,
  owner: ScenarioUser,
  fixtures: string[],
): Promise<GoldenRepo> {
  const key = await createApiKey(owner.api);
  const runId = goldenRunId();
  const base = defaultGoldenBase();
  const loaded: Record<string, UploadedGolden> = {};
  for (const id of fixtures) {
    loaded[id] = await uploadGolden(api, key.key, id, { runId, base, queue: { db, userId: owner.id } });
  }
  const repoUrl = loaded[fixtures[0]].repoUrl.replace(/\.git$/, '');
  const res = await owner.api.get('/api/v1/repositories');
  expect(res.status(), 'GET /api/v1/repositories').toBe(200);
  const repo = ((await res.json()) as Array<{ id: number; repoUrl: string }>).find((r) => r.repoUrl === repoUrl);
  if (!repo) throw new Error(`golden repository ${repoUrl} is not listed for ${owner.email}`);
  const single = (fixtureId: string) => {
    const g = loaded[fixtureId];
    if (!g || g.roots.length !== 1) throw new Error(`${fixtureId} was not uploaded or has more than one root`);
    return g.roots[0];
  };
  return {
    repoId: repo.id,
    repoUrl,
    runId,
    loaded,
    rootId: (fixtureId) => single(fixtureId).sessionId,
    agentId: (fixtureId, k) => {
      const agent = single(fixtureId).subagents.find((s) => s.key === k);
      if (!agent) throw new Error(`${fixtureId} has no sub-agent "${k}"`);
      return agent.sessionId;
    },
  };
}

/** NDJSON line counts of a single-root fixture's `artisyn` and `claude` logs, as uploaded. */
export function rootLineCounts(fixtureId: string): { artisyn: number; claude: number } {
  const { uploads } = materializeGolden(fixtureId);
  const lines = (type: string) =>
    uploads
      .filter((u) => u.type === type)
      .reduce((n, u) => n + u.body.split('\n').filter((l) => l.trim() !== '').length, 0);
  return { artisyn: lines('artisyn'), claude: lines('claude') };
}

/** Signs `user` in on `page` (the new-user nudge skipped) and opens one session of `repoId`. */
export async function openSession(
  page: Page,
  user: ScenarioUser,
  repoId: number,
  sessionId: string,
  { tab, teamId }: { tab?: string; teamId?: number } = {},
): Promise<void> {
  await skipNewUserNudge(page.context());
  await user.signIn(page);
  const scope = teamId !== undefined ? `/#/teams/${teamId}/repos/${repoId}` : `/#/repos/${repoId}`;
  await page.goto(`${scope}?session=${encodeURIComponent(sessionId)}${tab ? `&tab=${tab}` : ''}`);
}

/** `0.0825` → `$0.0825`, as every cost cell of the session pane prints it. */
export function usd4(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** `0.571429` → `57.1%`. */
export function pct1(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** `165000` → `0:02:45`. */
export function hms(ms: number): string {
  const s = Math.round(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** `3000` → `3,000` (en-US grouping, as the token cells print it). */
export function int(n: number): string {
  return n.toLocaleString('en-US');
}

/** A Summary tile (Cost, Turns, Code impact, Delegation, Session shape, Change surface) by its label. */
export function summaryTile(page: Page, label: string): Locator {
  return page
    .getByTestId('summary-executive-band')
    .locator(`xpath=.//button[normalize-space()="${label}"]/ancestor::div[contains(@class,"flex-1")][1]`);
}

/** The value cell next to a label row of the Info tab (`Prompts`, `Cost / line`, …). */
export function infoValue(page: Page, label: string): Locator {
  return page.locator(`xpath=//span[normalize-space()="${label}"]/following-sibling::*[1]`).first();
}

/** The last cell of an Info tab table row (`Calculated total`, `Main thread`, …). */
export function infoTableValue(page: Page, label: string): Locator {
  return page.locator(`xpath=//td[normalize-space()="${label}"]/following-sibling::td[last()]`).first();
}

/** A tool's row in the Statistics tab's Tool analytics table. */
export function toolRow(page: Page, tool: string): Locator {
  return page
    .getByTestId('session-usage-tab')
    .locator('tr')
    .filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^\\s*${tool}\\s*$`) }) });
}

/** The big number of a Statistics "Productivity counters" card (`Commits`, `Lines added (diff-based)`, …). */
export function usageCounter(page: Page, label: string): Locator {
  return page
    .getByTestId('session-usage-tab')
    .locator(`xpath=.//button[normalize-space()="${label}"]/parent::div/following-sibling::div[1]`)
    .first();
}

/** The top-level prompt turns of the Logs tab, in order. */
export function logTurns(page: Page): Locator {
  return page.locator('.divide-y > div > [data-turn-index]');
}

/** A token metric of a Logs turn header (`In`, `Out`, `cache_r`, `cache_w`, `cache_ratio`, `Cost`). */
export function turnMetric(turn: Locator, label: string): Locator {
  return turn.locator(`xpath=.//span[normalize-space()="${label}"]/following-sibling::span[1]`).first();
}

/** `1,500` / `$0.0276` / `57.1%` → number. */
export function num(text: string): number {
  return Number(text.replace(/[$,%\s]/g, ''));
}
