// S-SLIFE-09. Session metrics count the whole agent tree, not just the root
// (docs/qaa-overview/scenarios/02-repos-sessions.md §S-SLIFE-09; no mode in the design → A and C,
// DD SC4).
//
// Data: the golden fixtures instead of the design's hand-made R/C1/C2/G/P (impl-plan chunk 16:
// «на GS-02»). GS-02 is the delegator R — root → A → B (grandchild) and root → D, the root writes
// no line itself — and GS-01 is P, a plain session without sub-agents. Both go into one repository
// on `main` through POST /api/v2/logs (DD D2, SC3); every expected number is read from their
// `expected.json` (DD D3), so the design's 75/0/82/7 become:
//   - R: lines written 36 (A 6 + B 25 + D 5), own 0, tree cost 0.1173, work time 180 s;
//   - P: lines written = own = 19, cost 0.0825, work time 165 s;
//   - `main`: lines 55, own 19, work time 345 s (R and P do not overlap; R's sub-agents run inside
//     R's own turns, so they add no time — the union, not the sum of agent durations).
//
// Code facts that differ from the design text:
//   - the timeline's tree `filesEditedWritten` is the sum of the per-node counters
//     (`SUM(session_stats.files_edited_written)`, session-tree-metrics.sql.ts): A 1 + B 2 + D 1 = 4,
//     although B and A both touch invoice.ts (3 distinct files — that union is the change surface).
//   - the branch route's cost is the tree cost (R tree + P), the same as the session rows.
//
// Replaces:
//   - server/test/session-tree-metrics.e2e-spec.ts (15)
//   - server/test/repositories-analytics.e2e-spec.ts («totalCost includes grandchild», «cache rollup
//     3-level»: 2)
//   - server/test/repo-details.e2e-spec.ts (subagentStats: 3)
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  defaultGoldenBase,
  goldenRunId,
  loadExpected,
  uploadGolden,
  type GoldenRootExpected,
} from '../helpers/golden';
import { usd4 } from '../helpers/session-view';
import { skipNewUserNudge } from '../helpers/teams';

const DAY_MS = 24 * 60 * 60 * 1000;

interface TimelineRow {
  sessionId: string;
  totalCost: number | null;
  linesChanged: number;
  linesChangedOwn: number;
  filesEditedWritten: number;
  filesEditedWrittenOwn: number;
  workTimeMs: number;
}
interface BranchRow {
  branch: string;
  sessionCount: number;
  totalLinesChanged: number;
  totalLinesChangedOwn: number;
  totalWorkTimeMs: number;
  totalCost: number | null;
}
interface NodeStats {
  linesChanged: number;
  filesEditedWritten: number;
}
interface LogsResponse {
  subagents: Array<{ sessionId: string; parentSessionId: string | null }>;
  subagentStats: Record<string, NodeStats>;
  rootStats: NodeStats | null;
}
interface ExecutiveSummary {
  totalCost: number;
  totalSessions: number;
  totalLinesChanged: number;
  avgCostPerLine: number;
}

test('@S-SLIFE-09 session metrics count the whole agent tree, not just the root @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await users.user('user', { label: 'sl09-owner' });
  const R = loadExpected('gs-02').roots[0];
  const P = loadExpected('gs-01').roots[0];
  const node = (key: string) => R.nodes.find((n) => n.key === key)!;
  const nodeLines = (key: string) => node(key).lines!;
  const treeLines = R.lines.written;
  const branchLines = treeLines + P.lines.written;
  const branchOwn = R.lines.writtenOwn + P.lines.writtenOwn;
  const totalCost = R.costUsd! + P.costUsd!;

  const loaded = await test.step('setup: GS-02 (R, the delegator) and GS-01 (P, no sub-agents) in one repository', async () => {
    const key = await createApiKey(owner.api);
    const runId = goldenRunId();
    const base = defaultGoldenBase();
    const queue = { db, userId: owner.id };
    const r = await uploadGolden(api, key.key, 'gs-02', { runId, base, queue });
    const p = await uploadGolden(api, key.key, 'gs-01', { runId, base, queue });
    const repos = (await (await owner.api.get('/api/v1/repositories')).json()) as Array<{ id: number; repoUrl: string }>;
    const repo = repos.find((x) => x.repoUrl === r.repoUrl.replace(/\.git$/, ''));
    if (!repo) throw new Error(`repository ${r.repoUrl} not listed`);
    const ids = new Map<string, string>([['root', r.roots[0].sessionId], ...r.roots[0].subagents.map((s) => [s.key, s.sessionId] as [string, string])]);
    return {
      repoId: repo.id,
      rootId: r.roots[0].sessionId,
      plainId: p.roots[0].sessionId,
      ids,
      range: { startDate: base.toISOString(), endDate: new Date(base.getTime() + 14 * DAY_MS).toISOString() },
    };
  });

  const base = `/api/v1/repositories/${loaded.repoId}`;
  const get = async <T>(route: string, params: Record<string, string> = {}): Promise<T> => {
    const res = await owner.api.get(`${base}${route}`, { params });
    expect(res.status(), route).toBe(200);
    return (await res.json()) as T;
  };
  const sid = (key: string) => loaded.ids.get(key)!;

  const readAll = async () => ({
    timeline: await get<TimelineRow[]>('/analytics/timeline', loaded.range),
    branches: await get<BranchRow[]>('/sessions/branches', loaded.range),
    logs: await get<LogsResponse>(`/sessions/${encodeURIComponent(loaded.rootId)}/logs`),
    exec: await get<ExecutiveSummary>('/reports/executive-summary', loaded.range),
  });
  const first = await readAll();

  const checkTimeline = (rows: TimelineRow[], root: GoldenRootExpected, plain: GoldenRootExpected) => {
    expect(rows.map((r) => r.sessionId).sort(), 'only root sessions are timeline rows').toEqual([loaded.rootId, loaded.plainId].sort());
    const r = rows.find((x) => x.sessionId === loaded.rootId)!;
    const p = rows.find((x) => x.sessionId === loaded.plainId)!;
    expect(r.linesChanged).toBe(treeLines);
    expect(r.linesChangedOwn).toBe(root.lines.writtenOwn);
    expect(r.filesEditedWritten).toBe(['a', 'b', 'd'].reduce((n, k) => n + nodeLines(k).filesEditedWritten, 0));
    expect(r.filesEditedWrittenOwn).toBe(0);
    expect(r.totalCost).toBeCloseTo(root.costUsd!, 6);
    expect(r.workTimeMs).toBe(root.workTimeMs);
    expect(p.linesChanged).toBe(plain.lines.written);
    expect(p.linesChangedOwn).toBe(plain.lines.written);
    expect(p.totalCost).toBeCloseTo(plain.costUsd!, 6);
  };

  await test.step(`1. timeline: R lines ${treeLines} (own 0), tree cost with the grandchild; P lines = own; sub-agents are no rows`, async () => {
    checkTimeline(first.timeline, R, P);
  });

  await test.step(`2. branches: main lines ${branchLines}, own ${branchOwn}, cost R tree + P; work time is the union of the roots, not the sum of agents`, async () => {
    expect(first.branches).toHaveLength(1);
    const main = first.branches[0];
    expect(main).toMatchObject({
      branch: 'main',
      sessionCount: 2,
      totalLinesChanged: branchLines,
      totalLinesChangedOwn: branchOwn,
      totalWorkTimeMs: R.workTimeMs + P.workTimeMs,
    });
    expect(main.totalCost).toBeCloseTo(totalCost, 6);
  });

  await test.step('3. R’s logs: A, B, D carry their own lines; they add up to the tree; B is nested under A', async () => {
    const stats = first.logs.subagentStats;
    for (const k of ['a', 'b', 'd']) expect(stats[sid(k)]?.linesChanged, k).toBe(nodeLines(k).written);
    const sum = Object.values(stats).reduce((n, s) => n + s.linesChanged, 0) + (first.logs.rootStats?.linesChanged ?? 0);
    expect(sum).toBe(treeLines);
    const parentOf = (k: string) => first.logs.subagents.find((s) => s.sessionId === sid(k))?.parentSessionId;
    expect(parentOf('a')).toBe(loaded.rootId);
    expect(parentOf('b')).toBe(sid('a'));
    expect(parentOf('d')).toBe(loaded.rootId);
  });

  await test.step(`4. executive summary: ${branchLines} lines and cost per line on the same (tree) scale`, async () => {
    expect(first.exec.totalSessions).toBe(2);
    expect(first.exec.totalLinesChanged).toBe(branchLines);
    expect(first.exec.totalCost).toBeCloseTo(totalCost, 6);
    expect(first.exec.avgCostPerLine).toBeCloseTo(totalCost / branchLines, 6);
  });

  await test.step('5. UI: R shows «+sub-agents» by the cost, Code impact = tree lines next to Delegation 3 agents, and B under A in the Agent Tree', async () => {
    await skipNewUserNudge(page.context());
    await owner.signIn(page);
    await page.goto(`/#/repos/${loaded.repoId}?session=${encodeURIComponent(loaded.rootId)}`);
    const band = page.getByTestId('summary-executive-band');
    await expect(band).toBeVisible();
    await expect(page.getByText('+sub-agents').first()).toBeVisible();
    await expect(band).toContainText(`${treeLines} lines`);
    await expect(band).toContainText('3 agents');

    await page.getByTestId('tab-session-charts').click();
    await page.getByTestId('tab-chart-agent-tree').click();
    const agent = (k: string) => page.locator(`g[data-testid="agent-tree-node"][data-agent-id="${sid(k).replace(/^agent-/, '')}"]`);
    for (const k of ['a', 'b', 'd']) await expect(agent(k), k).toHaveCount(1);
    const slug = async (k: string) => ((await agent(k).getAttribute('aria-label')) ?? '').replace(/^Agent node: /, '');
    const [a, b, d] = [await slug('a'), await slug('b'), await slug('d')];
    await expect(page.getByLabel(`Connection from ${a} to ${b}`, { exact: true })).toHaveCount(1);
    await expect(page.getByLabel(`Connection from main to ${a}`, { exact: true })).toHaveCount(1);
    await expect(page.getByLabel(`Connection from main to ${d}`, { exact: true })).toHaveCount(1);
    await expect(page.getByLabel(`Connection from main to ${b}`, { exact: true })).toHaveCount(0);
  });

  await test.step('5b. UI: «main» header cost = sum of its session rows', async () => {
    await page.goto(`/#/repos/${loaded.repoId}`);
    // Session rows carry the branch name too — only the group header is not a session-item.
    const header = page.locator('button:not([data-testid="session-item"])', { has: page.locator('span.font-mono', { hasText: /^main$/ }) });
    await expect(header).toContainText(usd4(totalCost));
    // `main` is the only (first) branch, so it is open by default — no click needed.
    const costs = page.getByTestId('session-item-cost');
    await expect(costs).toHaveCount(2);
    const sum = (await costs.allTextContents())
      .map((t) => parseFloat(/\$([0-9.]+)/.exec(t)?.[1] ?? 'NaN'))
      .reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(totalCost, 3);
  });

  await test.step('6. all four endpoints again: the same numbers, nothing recounted or doubled', async () => {
    const again = await readAll();
    checkTimeline(again.timeline, R, P);
    expect(again.branches).toEqual(first.branches);
    expect(again.logs.subagentStats).toEqual(first.logs.subagentStats);
    expect(again.exec).toEqual(first.exec);
  });
});
