// S-SESS-04. A delegator with sub-agents three levels deep: nesting and the cost of the tree
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-SESS-04; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-02 — root (sonnet-4-6) → A (haiku) → B (haiku, the grandchild) and root → D (opus-5),
// uploaded the way the hook sends it: the root logs, then each sub-agent as `claude-subagent` with
// its `parentSessionId` (B's parent is A, not the root). POST /api/v2/logs (DD SC3); the numbers come
// from tests/golden/gs-02-delegator/expected.json (DD D3).
//
// Code facts that differ from the design text:
//   - Summary prints Delegation as a whole percent: 0.667519 → «67% of cost» (design 66.8 %).
//   - In Logs a turn's sub-agents are listed under «Agents» by the Agent call's description; the
//     grandchild B appears inside A's expanded block, under A's own «Agents».
//   - The turn header prints «main + sub-agents = total» as three cost figures; the sub-agent part is
//     the sum of that turn's agents (A + B for P1, D for P2).
//
// Replaces:
//   - client/src/viewer/__tests__/unit/log-parser.test.ts (sub-agent nesting, cross-transcript nesting,
//     collectDescendantAgentIds, …FromParentMap, buildAgentParentMap, buildChildrenByParentMap,
//     sub-agent with no non-empty prompt, absent from completionMap, agent_progress, workflow-agent
//     token fold double-count, buildAgentNodesForIds ×5: ≈ 55)
//   - server/test/session-tree-metrics.e2e-spec.ts (15)
//   - server/test/session-cost-consistency.e2e-spec.ts (grandchild case: ≈ 2)
//   - server/src/logs/session-tree-metrics.sql.spec.ts (12)
//   - client/src/viewer/__tests__/unit/tree-code-impact.test.ts (10, tree)
//   - client/src/viewer/__tests__/components/CallTreeView.test.tsx («+subagent»: ≈ 3)
import { test, expect } from '../fixtures';
import { loadExpected } from '../helpers/golden';
import {
  hms,
  infoTableValue,
  infoValue,
  logTurns,
  openSession,
  summaryTile,
  toolRow,
  uploadGoldenRepo,
  usd4,
} from '../helpers/session-view';

interface PerPrompt {
  costUsd: number;
  costWithSubagentsUsd: number;
  subagents: string[];
}
interface LogsResponse {
  subagents: Array<{ sessionId: string; parentSessionId: string | null }>;
  subagentStats: Record<string, unknown>;
}

test('@S-SESS-04 delegator three levels deep: nesting and the cost of the tree @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(120_000);
  const E = loadExpected('gs-02').roots[0];
  const node = (key: string) => E.nodes.find((n) => n.key === key)!;
  const perPrompt = E.perPrompt as PerPrompt[];
  const owner = await users.user('user', { label: 'ss04-owner' });

  const repo = await test.step('1. upload GS-02: the root, then A → root, B → A, D → root as claude-subagent', async () =>
    uploadGoldenRepo(api, db, owner, ['gs-02']),
  );
  const sid = repo.rootId('gs-02');
  const id = (k: string) => repo.agentId('gs-02', k);
  const base = `/api/v1/repositories/${repo.repoId}`;

  await test.step('2. GET .../logs: subagents A, B, D; B’s parent is A, not the root', async () => {
    const res = await owner.api.get(`${base}/sessions/${encodeURIComponent(sid)}/logs`);
    expect(res.status()).toBe(200);
    const logs = (await res.json()) as LogsResponse;
    expect(logs.subagents.map((s) => s.sessionId).sort()).toEqual(['a', 'b', 'd'].map(id).sort());
    const parent = (k: string) => logs.subagents.find((s) => s.sessionId === id(k))?.parentSessionId;
    expect(parent('a')).toBe(sid);
    expect(parent('b')).toBe(id(node('b').parent!));
    expect(parent('d')).toBe(sid);
    expect(Object.keys(logs.subagentStats).sort()).toEqual(['a', 'b', 'd'].map(id).sort());
  });

  await test.step(`3. GET .../sessions: one root row, totalCost ${E.costUsd} including the grandchild; no rows for A, B, D`, async () => {
    const res = await owner.api.get(`${base}/sessions`);
    expect(res.status()).toBe(200);
    const rows = (await res.json()) as Array<{ sessionId: string; totalCost: number | null; costBreakdown: { mainCost: number; subagentCost: number } }>;
    expect(rows.map((r) => r.sessionId)).toEqual([sid]);
    expect(rows[0].totalCost).toBeCloseTo(E.costUsd!, 6);
    expect(rows[0].costBreakdown.mainCost).toBeCloseTo(E.ownCostUsd!, 6);
    expect(rows[0].costBreakdown.subagentCost).toBeCloseTo(['a', 'b', 'd'].reduce((n, k) => n + node(k).costUsd!, 0), 6);
  });

  await test.step('4. Logs: P1 lists A under Agents; A expanded shows B under its own Agents (nesting 2)', async () => {
    await openSession(page, owner, repo.repoId, sid, { tab: 'logs' });
    const turns = logTurns(page);
    await expect(turns).toHaveCount(E.prompts);
    const p1 = turns.first();
    await expect(p1.getByText('Extract invoice tax module')).toBeVisible();
    await expect(p1.getByText('Create tax module')).toHaveCount(0);
    await p1.getByText('Extract invoice tax module').click();
    await expect(p1.getByText(id('a'), { exact: true })).toBeVisible();
    const b = p1.getByText('Create tax module');
    await expect(b).toBeVisible();
    await b.click();
    await expect(p1.getByText(id('b'), { exact: true })).toBeVisible();
    await expect(turns.nth(1).getByText('Add tax preview route')).toBeVisible();
  });

  await test.step('5. turn headers: main + sub-agents = total, each sub-agent counted once', async () => {
    const turns = logTurns(page);
    for (const [i, p] of perPrompt.entries()) {
      const sub = p.subagents.reduce((n, k) => n + node(k).costUsd!, 0);
      const header = turns.nth(i).locator(`xpath=.//span[normalize-space()="="]/parent::*`).first();
      await expect(header, `P${i + 1}`).toHaveText(`${usd4(p.costUsd)}+${usd4(sub)}=${usd4(p.costWithSubagentsUsd)}`);
      expect(p.costUsd + sub).toBeCloseTo(p.costWithSubagentsUsd, 6);
    }
    expect(perPrompt.reduce((n, p) => n + p.costWithSubagentsUsd, 0)).toBeCloseTo(E.costUsd!, 6);
  });

  await test.step('6. Info: Sub-agents spawned 3, Lines changed 36 (not 0), Cost / line, Lines / autonomous hr, work time not stretched', async () => {
    await page.getByTestId('tab-session-info').click();
    await expect(infoValue(page, 'Sub-agents spawned')).toHaveText(String(E.subAgentsSpawned));
    await expect(infoValue(page, 'Lines changed')).toContainText(String(E.lines.written));
    await expect(infoValue(page, 'Lines changed')).toContainText(`${E.lines.writtenOwn} own · ${E.lines.written} in 3 sub-agents`);
    await expect(infoValue(page, 'Cost / line')).toHaveText(usd4(E.costPerLineUsd as number));
    await expect(infoValue(page, 'Lines / autonomous hr')).toHaveText(`${E.linesPerAutonomousHour as number} lines/hr`);
    await expect(infoValue(page, 'Autonomous work time')).toHaveText(hms(E.workTimeMs));
    await expect(infoTableValue(page, 'Main thread')).toHaveText(usd4(E.ownCostUsd!));
    await expect(infoTableValue(page, 'Calculated total')).toHaveText(usd4(E.costUsd!));
  });

  await test.step('7. Summary: Delegation 3 agents and its cost share, Code impact 36 lines, Cost with sub-agents', async () => {
    await page.getByTestId('tab-session-summary').click();
    const delegation = summaryTile(page, 'Delegation');
    await expect(delegation).toContainText('3 agents');
    await expect(delegation).toContainText(`${Math.round((E.delegationShare as number) * 100)}% of cost`);
    await expect(summaryTile(page, 'Code impact')).toContainText(`${E.lines.written} lines`);
    const cost = summaryTile(page, 'Cost');
    await expect(cost).toContainText(usd4(E.costUsd!));
    await expect(cost).toContainText('+sub-agents');
  });

  await test.step('8. Statistics: tool calls summed over the tree', async () => {
    await page.getByTestId('tab-session-usage').click();
    for (const [tool, t] of Object.entries(E.tools)) {
      await expect(toolRow(page, tool).locator('td').nth(1), tool).toHaveText(String(t.calls));
    }
    const total = Object.values(E.tools).reduce((n, t) => n + t.calls, 0);
    await expect(page.getByTestId('session-usage-tab')).toContainText(`${total} tool calls`);
  });

  await test.step('9. the session list has one row for the tree — none for A, B or D', async () => {
    await expect(page.getByTestId('session-item')).toHaveCount(1);
  });
});
