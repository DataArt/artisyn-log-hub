// S-SESS-01. A plain session: Summary, Info and Statistics show the same numbers as the API
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-SESS-01; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-01 (one root, sonnet-4-6, three prompts, legacy usage without `cache_creation`), uploaded
// through POST /api/v2/logs (DD SC3). Every number is read from tests/golden/gs-01-simple/expected.json
// (DD D3); `usd4`/`pct1`/`hms` only print a literal the way the UI does.
//
// Code facts that differ from the design text:
//   - Info «Lines / autonomous hr» is rounded to a whole line: the design's 19 / (165 / 3600) = 414.5
//     shows as «415 lines/hr»; «Cost / autonomous hr» prints four decimals («$1.8000 /hr»).
//   - Info's total row is «Calculated total» (the design's «Calculated approx. total» is the per-turn
//     cost tooltip, checked in S-SESS-03).
//   - Statistics shows tokens by cache TTL and by service tier (K-rounded), not as four plain rows;
//     failures of a clean tool read «—».
//   - The API's `main` holds the artisyn lines too: its length is the artisyn + claude line count.
//
// Replaces:
//   - client/src/viewer/__tests__/unit/session-info-derive.test.ts (20)
//   - client/src/viewer/__tests__/unit/session-usage-derive.test.ts (38, part)
//   - client/src/viewer/__tests__/unit/session-summary-derive.test.ts (29, part)
//   - client/src/viewer/__tests__/unit/log-parser.test.ts (totalWorkTimeMs, maxContextTokens, model in
//     summary, per-turn token scoping, linesChanged, file access count, sessionSummary.fileStats: ≈ 40)
//   - server/src/logs/claude-extractor.spec.ts (tokens, work time, commits/PR, lines: ≈ 45)
//   - client/src/viewer/__tests__/components/session-summary-tab.test.tsx (16, part)
//   - client/src/viewer/__tests__/components/session-info-tab.test.tsx (22, part)
//   - client/src/viewer/__tests__/unit/tree-code-impact.test.ts (10, single root)
//   - tests/e2e/summary-tab.spec.ts (11, part)
import { test, expect } from '../fixtures';
import { loadExpected } from '../helpers/golden';
import {
  hms,
  infoTableValue,
  infoValue,
  int,
  logTurns,
  openSession,
  pct1,
  rootLineCounts,
  summaryTile,
  toolRow,
  turnMetric,
  uploadGoldenRepo,
  usageCounter,
  usd4,
} from '../helpers/session-view';

const FIRST_PROMPT = 'Add a /health endpoint to the app and document it';

interface SessionRow {
  sessionId: string;
  firstPrompt: string | null;
  gitBranch: string | null;
  totalCost: number | null;
}
interface LogsResponse {
  main: Array<Record<string, unknown>>;
  subagents: unknown[];
  subagentStats: Record<string, unknown>;
}

test('@S-SESS-01 plain session: Summary, Info and Statistics show the same numbers as the API @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(120_000);
  const E = loadExpected('gs-01').roots[0];
  const owner = await users.user('user', { label: 'ss01-owner' });

  const repo = await test.step('1. upload GS-01 (artisyn + claude) and wait for it to land', async () => {
    return uploadGoldenRepo(api, db, owner, ['gs-01']);
  });
  const sid = repo.rootId('gs-01');
  const base = `/api/v1/repositories/${repo.repoId}`;

  await test.step(`2. GET /sessions: totalCost ${E.costUsd}, branch ${E.branch}, firstPrompt of the first prompt line`, async () => {
    const res = await owner.api.get(`${base}/sessions`);
    expect(res.status()).toBe(200);
    const rows = (await res.json()) as SessionRow[];
    expect(rows.map((r) => r.sessionId)).toEqual([sid]);
    expect(rows[0].totalCost).toBeCloseTo(E.costUsd!, 6);
    expect(rows[0].gitBranch).toBe(E.branch);
    expect(rows[0].firstPrompt).toBe(FIRST_PROMPT);
  });

  await test.step('3. open the session: Summary is the default tab; the list row shows the same cost', async () => {
    await openSession(page, owner, repo.repoId, sid);
    await expect(page.getByTestId('summary-executive-band')).toBeVisible();
    expect(page.url()).not.toContain('tab=');
    const item = page.getByTestId('session-item').filter({ hasText: FIRST_PROMPT });
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId('session-item-cost')).toContainText(usd4(E.costUsd!));
  });

  await test.step('4. Summary tiles: Cost, Turns, Code impact, Session shape, Change surface', async () => {
    await expect(summaryTile(page, 'Cost')).toContainText(usd4(E.costUsd!));
    await expect(summaryTile(page, 'Turns')).toContainText(`${E.prompts} prompts`);
    await expect(summaryTile(page, 'Code impact')).toContainText(`${E.lines.written} lines`);
    await expect(summaryTile(page, 'Code impact')).toContainText(
      `+${E.lines.added} / −${E.lines.removed} · ${E.changeSurface.changedFiles} files`,
    );
    await expect(summaryTile(page, 'Session shape')).toContainText(E.model);
    await expect(summaryTile(page, 'Session shape')).toContainText(`${hms(E.workTimeMs)} work time`);
    const cs = summaryTile(page, 'Change surface');
    await expect(cs).toContainText(`Concentration ${E.changeSurface.concentration} / 100`);
    await expect(cs).toContainText(E.changeSurface.band!);
  });

  await test.step('5. Info: prompts (isMeta not counted), work time, duration, lines, productivity, cache ratio, total', async () => {
    await page.getByTestId('tab-session-info').click();
    await expect(page).toHaveURL(/tab=info/);
    await expect(infoValue(page, 'Prompts')).toHaveText(String(E.prompts));
    await expect(infoValue(page, 'Autonomous work time')).toHaveText(hms(E.workTimeMs));
    await expect(infoValue(page, 'Duration')).toHaveText(hms(E.durationMs));
    await expect(infoValue(page, 'Edit/write calls')).toContainText(String(E.lines.editWriteCalls));
    await expect(infoValue(page, 'Lines changed')).toContainText(String(E.lines.written));
    // 19 lines / (165 s / 3600) = 414.5 → printed as a whole line count.
    await expect(infoValue(page, 'Lines / autonomous hr')).toHaveText('415 lines/hr');
    // 0.0825 / (165 s / 3600) = 1.8.
    await expect(infoValue(page, 'Cost / autonomous hr')).toHaveText('$1.8000 /hr');
    // 0.0825 / 19 = 0.00434.
    await expect(infoValue(page, 'Cost / line')).toHaveText('$0.0043');
    await expect(infoValue(page, 'Cache read ratio')).toHaveText(pct1(E.cacheRatio.own!));
    await expect(infoTableValue(page, 'Calculated total')).toHaveText(usd4(E.costUsd!));
  });

  await test.step('6. Statistics: tokens by TTL and tier, tool table (calls, no failures)', async () => {
    await page.getByTestId('tab-session-usage').click();
    const tab = page.getByTestId('session-usage-tab');
    await expect(tab).toBeVisible();
    const tools = Object.entries(E.tools);
    const totalCalls = tools.reduce((n, [, t]) => n + t.calls, 0);
    await expect(tab).toContainText(`${totalCalls} tool calls`);
    for (const [tool, t] of tools) {
      const row = toolRow(page, tool);
      await expect(row, tool).toHaveCount(1);
      await expect(row.locator('td').nth(1), `${tool} calls`).toHaveText(String(t.calls));
      await expect(row.locator('td').nth(3), `${tool} failures`).toHaveText(t.failures === 0 ? '—' : String(t.failures));
    }
    const k = (n: number) => (n === 0 ? '0' : `${(n / 1000).toFixed(1)}K`);
    const tok = E.tokens.own;
    await expect(tab.locator('tr', { hasText: '5-minute TTL' })).toContainText(k(tok.cacheWrite5m));
    await expect(tab.locator('tr', { hasText: '1-hour TTL' })).toContainText(k(tok.cacheWrite1h));
    const tier = tab.locator('tr', { hasText: 'standard' });
    await expect(tier.locator('td')).toHaveText([
      'standard',
      k(tok.input),
      k(tok.output),
      k(tok.cacheRead),
      k(tok.cacheWrite5m + tok.cacheWrite1h),
    ]);
    await expect(usageCounter(page, 'Lines added (diff-based)')).toHaveText(String(E.lines.added));
    await expect(usageCounter(page, 'Lines removed (diff-based)')).toHaveText(String(E.lines.removed));
    await expect(usageCounter(page, 'Commits')).toHaveText(String(E.commits));
    await expect(usageCounter(page, 'Pull requests')).toHaveText(String(E.pullRequests));
  });

  await test.step('7. Logs: three turns with the per-prompt cost and cache_ratio of expected.json', async () => {
    await page.getByTestId('tab-session-logs').click();
    const turns = logTurns(page);
    const perPrompt = E.perPrompt as Array<{ workTimeMs: number; costUsd: number; cacheRatio: number; tokens: { input: number } }>;
    await expect(turns).toHaveCount(perPrompt.length);
    for (const [i, p] of perPrompt.entries()) {
      const turn = turns.nth(i);
      await expect(turnMetric(turn, 'Cost'), `turn ${i + 1} cost`).toHaveText(usd4(p.costUsd));
      await expect(turnMetric(turn, 'cache_ratio'), `turn ${i + 1} cache_ratio`).toHaveText(pct1(p.cacheRatio));
      await expect(turnMetric(turn, 'In'), `turn ${i + 1} input`).toHaveText(int(p.tokens.input));
      await expect(turn, `turn ${i + 1} work time`).toContainText(hms(p.workTimeMs));
    }
    await expect(turns.first()).toContainText(FIRST_PROMPT);
  });

  await test.step('8. GET .../logs: no sub-agents; every uploaded line is there', async () => {
    const res = await owner.api.get(`${base}/sessions/${encodeURIComponent(sid)}/logs`);
    expect(res.status()).toBe(200);
    const logs = (await res.json()) as LogsResponse;
    expect(logs.subagents).toEqual([]);
    expect(logs.subagentStats).toEqual({});
    const lines = rootLineCounts('gs-01');
    expect(logs.main).toHaveLength(lines.artisyn + lines.claude);
    const meta = logs.main.filter((e) => e.type === 'user' && e.isMeta === true);
    expect(meta, 'the isMeta line is stored, just not counted as a prompt').toHaveLength(
      (E.nonQualifyingUserLines as { isMeta: number }).isMeta,
    );
  });
});
