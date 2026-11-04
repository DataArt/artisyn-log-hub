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
  selectLens,
  selectSessionTab,
  lensSelect,
  revealSessionTab,
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
    await selectSessionTab(page, 'info');
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
    await selectSessionTab(page, 'summary');
    const delegation = summaryTile(page, 'Delegation');
    await expect(delegation).toContainText('3 agents');
    await expect(delegation).toContainText(`${Math.round((E.delegationShare as number) * 100)}% of cost`);
    await expect(summaryTile(page, 'Code impact')).toContainText(`${E.lines.written} lines`);
    const cost = summaryTile(page, 'Cost');
    await expect(cost).toContainText(usd4(E.costUsd!));
    await expect(cost).toContainText('+sub-agents');
  });

  await test.step('8. Statistics: tool calls summed over the tree', async () => {
    await selectSessionTab(page, 'usage');
    for (const [tool, t] of Object.entries(E.tools)) {
      await expect(toolRow(page, tool).locator('td').nth(1), tool).toHaveText(String(t.calls));
    }
    const total = Object.values(E.tools).reduce((n, t) => n + t.calls, 0);
    await expect(page.getByTestId('session-usage-tab')).toContainText(`${total} tool calls`);
  });

  await test.step('9. the session list has one row for the tree — none for A, B or D', async () => {
    await expect(page.getByTestId('session-item')).toHaveCount(1);
  });

  await test.step('10. a lens switch writes lens= and the lens default tab: Harness → System context', async () => {
    await selectLens(page, 'harness');
    await expect(page).toHaveURL(/lens=harness/);
    await expect(page).toHaveURL(/tab=sysctx/);
    await expect(page.getByTestId('tab-session-sysctx')).toHaveAttribute('aria-selected', 'true');
    // The other Harness tabs are in the row or, when the pane is narrow, under "More ▾".
    for (const t of ['context-usage', 'harness-usage', 'okf', 'info']) {
      await revealSessionTab(page, t);
      await page.keyboard.press('Escape');
    }
  });

  await test.step('11. the lens survives a reload, and a link without lens= reopens the remembered lens', async () => {
    await page.reload();
    await expect(lensSelect(page)).toHaveValue('harness');
    await expect(page.getByTestId('tab-session-sysctx')).toHaveAttribute('aria-selected', 'true');
    await openSession(page, owner, repo.repoId, sid);
    await expect(lensSelect(page)).toHaveValue('harness');
    await expect(page).not.toHaveURL(/lens=/);
    // Without tab= the session still opens on Summary under every lens.
    await expect(page.getByTestId('summary-executive-band')).toBeVisible();
  });

  await test.step('12. All tabs: one level of tabs, a chart is a tab, an old tab=charts link reopens the last chart', async () => {
    await selectLens(page, 'all');
    await expect(page).toHaveURL(/lens=all/);
    await expect(page).not.toHaveURL(/tab=/);
    // One level: no group row and no Charts sub-tab bar.
    await expect(page.locator('[data-testid^="tab-session-group-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="tab-chart-"]')).toHaveCount(0);
    await selectSessionTab(page, 'timeline');
    await expect(page).toHaveURL(/tab=timeline/);
    await expect(page.getByTestId('session-chart-timeline')).toBeVisible();
    await openSession(page, owner, repo.repoId, sid, { tab: 'charts' });
    await expect(page).toHaveURL(/tab=timeline/);
    await expect(page.getByTestId('tab-session-timeline')).toHaveAttribute('aria-selected', 'true');
  });

  // Session Map (2026-11-01 session-map-tab). Card ids are the agent ids without `agent-`;
  // the Map prints costs as `$0.00`, so the Info figures are compared at two decimals.
  const cardId = (k: string) => `session-map-agent-${id(k).replace(/^agent-/, '')}`;
  const card = (k: string) => page.getByTestId(cardId(k));
  const usd2 = (v: number) => `$${v.toFixed(2)}`;
  const totalCalls = Object.values(E.tools).reduce((n, t) => n + t.calls, 0);

  await test.step('13. Session Map: a finished session opens in Replay; main card own cost and the tree cost equal Info', async () => {
    await openSession(page, owner, repo.repoId, sid, { tab: 'session-map' });
    await expect(page.getByTestId('session-map-badge')).toContainText('Replay', { timeout: 20_000 });
    await expect(page.getByTestId('session-map-live')).toHaveCount(0);
    await expect(page.getByTestId('session-map-main')).toContainText(usd2(E.ownCostUsd!));
    await expect(page.getByTestId('session-map-counter-cost')).toContainText(`/ ${usd2(E.costUsd!)}`);
  });

  await test.step('14. Session Map: every agent once, all in the direct column; B nested under A', async () => {
    await expect(page.locator('[data-testid^="session-map-agent-"]')).toHaveCount(3);
    const direct = page.getByTestId('session-map-group-direct');
    await expect(direct.getByTestId('session-map-group-direct-header')).toContainText('Agents spawned by the main session');
    for (const k of ['a', 'b', 'd']) await expect(direct.getByTestId(cardId(k))).toHaveCount(1);
    // A nested card is indented by one NEST_INDENT and directly follows its parent.
    await expect(card('b').locator('xpath=..')).toHaveCSS('margin-left', '16px');
    await expect(card('a').locator('xpath=..')).toHaveCSS('margin-left', '0px');
    const order = await direct
      .locator('[data-testid^="session-map-agent-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(order.indexOf(cardId('b'))).toBe(order.indexOf(cardId('a')) + 1);
  });

  await test.step('15. Session Map: a card opens the panel; chips filter; a call row moves the marker; ⤢ opens the call modal', async () => {
    await card('a').click();
    const panel = page.getByTestId('session-map-panel');
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/smSel=/);
    const calls = panel.getByTestId('session-map-call');
    const all = await calls.count();
    expect(all).toBeGreaterThan(0);
    await panel.getByTestId('session-map-chip-edit').click();
    await expect(calls).not.toHaveCount(all);
    await expect(calls.first()).toBeVisible();
    await panel.getByTestId('session-map-chip-all').click();
    await expect(calls).toHaveCount(all);

    const marker = page.getByTestId('session-map-marker');
    const before = Number(await marker.getAttribute('data-t'));
    await calls.first().locator('button').first().click();
    await expect.poll(async () => Number(await marker.getAttribute('data-t'))).toBeLessThan(before);

    await calls.first().getByTestId('session-map-call-open').click();
    const modal = page.getByRole('dialog', { name: /^Tool call:/ });
    await expect(modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  await test.step('16. Session Map: at the replay end the counters equal the totals', async () => {
    await page.getByTestId('session-map-timeline').getByRole('button', { name: 'End' }).click();
    await expect(page.getByTestId('session-map-counter-agents')).toContainText('3 / 3');
    await expect(page.getByTestId('session-map-counter-cost')).toContainText(`${usd2(E.costUsd!)} / ${usd2(E.costUsd!)}`);
    await expect(page.getByTestId('session-map-counter-calls').locator('span').nth(1)).toHaveText(String(totalCalls));
    await expect(page.getByTestId('session-map-counter-failed').locator('span').nth(1)).toHaveText('0');
    await expect(page.locator('[data-testid^="session-map-agent-"][data-state="future"]')).toHaveCount(0);
  });
});
