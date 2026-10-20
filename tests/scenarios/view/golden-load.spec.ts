// Golden load (impl-plan DD D1–D3, Test coverage plan D): upload all nine golden fixtures (ten
// roots) into one repository, REPO-GOLD, through the public `POST /api/v2/logs`, then compare what
// the API reports with the literals in `tests/golden/*/expected.json` and
// `tests/golden/repo-gold.expected.json`. `tests/golden/check-arithmetic.mjs` re-derives those
// literals independently; this spec checks the app against them.
//
// Every comparison is `expect.soft`, so one run lists every disagreement at once. A disagreement
// that is a code bug keeps the correct number in expected.json and its test is marked `test.fail`
// with a pointer to the task Notes (DD D3); see the "Golden numbers vs the app" note in
// docs/tasks/todo/2026-10-14-qaa-test-suite-cleanup/requirements.md.
import { request, type APIRequestContext } from '@playwright/test';
import { test as scenarioTest, expect } from '../fixtures';
import { SCENARIO_EMAIL_DOMAIN } from '../modes';
import { createApiKey } from '../helpers/api-key';
import {
  GOLDEN_FIXTURE_IDS,
  defaultGoldenBase,
  goldenRunId,
  loadExpected,
  loadRepoGoldExpected,
  shiftGoldenTime,
  uploadGolden,
  type GoldenRootExpected,
  type GoldenTokens,
  type RepoGoldExpected,
} from '../helpers/golden';

/** expected.json keeps money and ratios to six decimals. */
const TOL = 5e-7 + 1e-9;

interface GoldenRoot {
  expected: GoldenRootExpected;
  sessionId: string;
  /** `upload.json` key → uploaded session id, for the root (`root`) and every sub-agent. */
  nodeIds: Map<string, string>;
}

interface GoldenRepo {
  api: APIRequestContext;
  repoId: number;
  base: Date;
  deltaDays: number;
  roots: GoldenRoot[];
  totals: RepoGoldExpected;
  /** `startDate`/`endDate` covering A..A+13d of the loaded copy. */
  range: { startDate: string; endDate: string };
}

const test = scenarioTest.extend<object, { golden: GoldenRepo }>({
  golden: [
    async ({ stand, db }, use) => {
      if (stand.authMode !== 'none') throw new Error('golden-load identifies its owner, so it runs in mode A only');
      const api = await request.newContext({ baseURL: stand.url });
      try {
        const runId = goldenRunId();
        const email = `golden-${runId}@${SCENARIO_EMAIL_DOMAIN}`;
        const identify = await api.post('/api/v1/auth/identify', { data: { email } });
        if (!identify.ok()) throw new Error(`identify ${email} failed (${identify.status()}): ${await identify.text()}`);
        const me = (await (await api.get('/api/v1/auth/me')).json()) as { id: number };
        const key = await createApiKey(api);

        const base = defaultGoldenBase();
        const roots: GoldenRoot[] = [];
        let repoUrl = '';
        let deltaDays = 0;
        for (const id of GOLDEN_FIXTURE_IDS) {
          const loaded = await uploadGolden(api, key.key, id, { runId, base, queue: { db, userId: me.id, timeoutMs: 60_000 } });
          repoUrl = loaded.repoUrl;
          deltaDays = loaded.deltaDays;
          const expected = loadExpected(id);
          for (const root of loaded.roots) {
            const exp = expected.roots.find((r) => r.key === root.key);
            if (!exp) throw new Error(`${id}/expected.json has no root "${root.key}"`);
            const nodeIds = new Map<string, string>([['root', root.sessionId]]);
            for (const sub of root.subagents) nodeIds.set(sub.key, sub.sessionId);
            roots.push({ expected: exp, sessionId: root.sessionId, nodeIds });
          }
        }

        const repos = (await (await api.get('/api/v1/repositories')).json()) as Array<{ id: number; repoUrl: string }>;
        // The server stores the normalised URL (no `.git`, docs/knowledgebase/repo-identity.md).
        const repo = repos.find((r) => r.repoUrl === repoUrl.replace(/\.git$/, ''));
        if (!repo) throw new Error(`REPO-GOLD (${repoUrl}) is not in GET /api/v1/repositories: ${JSON.stringify(repos)}`);

        const totals = loadRepoGoldExpected();
        const range = {
          startDate: shiftGoldenTime(totals.range.start, deltaDays).toISOString(),
          endDate: shiftGoldenTime(totals.range.end, deltaDays).toISOString(),
        };
        await use({ api, repoId: repo.id, base, deltaDays, roots, totals, range });
      } finally {
        await api.dispose();
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
});

/** Soft check that `actual` is within six decimals of `expected` (or both null). */
function close(actual: number | null | undefined, expected: number | null, what: string): void {
  if (expected === null || actual === null || actual === undefined) {
    expect.soft(actual ?? null, what).toBe(expected);
    return;
  }
  expect.soft(Math.abs(actual - expected), `${what}: app ${actual}, expected ${expected}`).toBeLessThanOrEqual(TOL);
}

async function getJson<T>(golden: GoldenRepo, route: string, query: Record<string, string> = {}): Promise<T> {
  const res = await golden.api.get(`/api/v1/repositories/${golden.repoId}${route}`, { params: query });
  expect(res.status(), `GET ${route}: ${res.status()}`).toBe(200);
  return (await res.json()) as T;
}

const cacheWrite = (t: GoldenTokens) => t.cacheWrite5m + t.cacheWrite1h;

test.describe.configure({ mode: 'serial' });

test('GOLDEN-LOAD sessions list: cost, branch, start/end and version of every root @mode-a', async ({ golden }) => {
  interface SessionRow {
    sessionId: string;
    gitBranch: string | null;
    startTime: string;
    endTime: string;
    totalCost: number | null;
    costUnavailableReason: string | null;
    claudeVersion: string | null;
    costBreakdown: { mainCost: number; subagentCost: number } | null;
  }
  const rows = await getJson<SessionRow[]>(golden, '/sessions');
  expect(rows.map((r) => r.sessionId).sort()).toEqual(golden.roots.map((r) => r.sessionId).sort());
  for (const { expected: e, sessionId } of golden.roots) {
    const row = rows.find((r) => r.sessionId === sessionId)!;
    const at = `${e.key}`;
    close(row.totalCost, e.costUsd, `${at}.totalCost (tree)`);
    expect.soft(row.costUnavailableReason, `${at}.costUnavailableReason`).toBe(e.costUnavailableReason);
    expect.soft(row.gitBranch, `${at}.gitBranch`).toBe(e.branch);
    expect.soft(row.claudeVersion, `${at}.claudeVersion`).toBe(e.claudeVersion);
    expect.soft(row.startTime, `${at}.startTime`).toBe(shiftGoldenTime(e.start, golden.deltaDays).toISOString());
    expect.soft(row.endTime, `${at}.endTime`).toBe(shiftGoldenTime(e.end, golden.deltaDays).toISOString());
    if (e.costUsd !== null && e.ownCostUsd !== null) {
      close(row.costBreakdown?.mainCost, e.ownCostUsd, `${at}.costBreakdown.mainCost`);
      close(row.costBreakdown?.subagentCost, e.costUsd - e.ownCostUsd, `${at}.costBreakdown.subagentCost`);
    }
  }
});

test('GOLDEN-LOAD analytics timeline: work time, lines and cache tokens of every root @mode-a', async ({ golden }) => {
  interface TimelineRow {
    sessionId: string;
    workTimeMs: number;
    totalCost: number | null;
    linesChanged: number;
    linesChangedOwn: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    descendantCacheReadTokens: number;
    descendantCacheWriteTokens: number;
    webSearchRequests: number;
    inputTokensFast: number;
    outputTokensFast: number;
  }
  const rows = await getJson<TimelineRow[]>(golden, '/analytics/timeline', golden.range);
  expect(rows).toHaveLength(golden.roots.length);
  for (const { expected: e, sessionId } of golden.roots) {
    const row = rows.find((r) => r.sessionId === sessionId);
    expect.soft(row, `${e.key} in the timeline`).toBeTruthy();
    if (!row) continue;
    const { own, tree } = e.tokens;
    expect.soft(row.workTimeMs, `${e.key}.workTimeMs`).toBe(e.workTimeMs);
    close(row.totalCost, e.costUsd, `${e.key}.totalCost`);
    expect.soft(row.linesChanged, `${e.key}.linesChanged (tree, written)`).toBe(e.lines.written);
    expect.soft(row.linesChangedOwn, `${e.key}.linesChangedOwn`).toBe(e.lines.writtenOwn);
    expect.soft(row.cacheReadTokens, `${e.key}.cacheReadTokens`).toBe(own.cacheRead);
    expect.soft(row.cacheWriteTokens, `${e.key}.cacheWriteTokens`).toBe(cacheWrite(own));
    expect.soft(row.descendantCacheReadTokens, `${e.key}.descendantCacheReadTokens`).toBe(tree.cacheRead - own.cacheRead);
    expect.soft(row.descendantCacheWriteTokens, `${e.key}.descendantCacheWriteTokens`).toBe(cacheWrite(tree) - cacheWrite(own));
    expect.soft(row.webSearchRequests, `${e.key}.webSearchRequests`).toBe(own.webSearch);
    expect.soft(row.inputTokensFast, `${e.key}.inputTokensFast`).toBe(own.inputFast);
    expect.soft(row.outputTokensFast, `${e.key}.outputTokensFast`).toBe(own.outputFast);
  }
});

test('GOLDEN-LOAD session logs: model, tokens and lines of every sub-agent @mode-a', async ({ golden }) => {
  interface NodeStats {
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    linesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    filesEditedWritten: number;
  }
  interface LogsResponse {
    subagentStats: Record<string, NodeStats>;
    rootStats: { linesChanged: number; linesAdded: number; linesRemoved: number };
  }
  for (const { expected: e, sessionId, nodeIds } of golden.roots) {
    const logs = await getJson<LogsResponse>(golden, `/sessions/${encodeURIComponent(sessionId)}/logs`);
    expect.soft(logs.rootStats.linesChanged, `${e.key}.rootStats.linesChanged`).toBe(e.lines.writtenOwn);
    const subNodes = e.nodes.filter((n) => n.key !== 'root');
    expect.soft(Object.keys(logs.subagentStats).sort(), `${e.key} sub-agents`).toEqual(subNodes.map((n) => nodeIds.get(n.key)).sort());
    for (const node of subNodes) {
      const stats = logs.subagentStats[nodeIds.get(node.key) ?? ''];
      const at = `${e.key}/${node.key}`;
      expect.soft(stats, `${at} in subagentStats`).toBeTruthy();
      if (!stats) continue;
      expect.soft(stats.model, `${at}.model`).toBe(node.model);
      expect.soft(stats.inputTokens, `${at}.inputTokens`).toBe(node.tokens.input);
      expect.soft(stats.outputTokens, `${at}.outputTokens`).toBe(node.tokens.output);
      expect.soft(stats.cacheReadTokens, `${at}.cacheReadTokens`).toBe(node.tokens.cacheRead);
      expect.soft(stats.cacheWriteTokens, `${at}.cacheWriteTokens`).toBe(cacheWrite(node.tokens));
      if (node.lines) {
        expect.soft(stats.linesChanged, `${at}.linesChanged`).toBe(node.lines.written);
        expect.soft(stats.linesAdded, `${at}.linesAdded`).toBe(node.lines.added);
        expect.soft(stats.linesRemoved, `${at}.linesRemoved`).toBe(node.lines.removed);
        expect.soft(stats.filesEditedWritten, `${at}.filesEditedWritten`).toBe(node.lines.filesEditedWritten);
      }
    }
  }
});

test('GOLDEN-LOAD change surface of every session tree @mode-a', async ({ golden }) => {
  interface ChangeSurface {
    computed: boolean;
    changedFiles: number;
    foldersTouched: number;
    topLevelModules: string[];
    singleFileFolders: number;
    linesAdded: number;
    linesRemoved: number;
    outsideRepoFiles: number;
    concentration: number | null;
    band: string | null;
  }
  for (const { expected: e, sessionId } of golden.roots) {
    const cs = await getJson<ChangeSurface>(golden, `/sessions/${encodeURIComponent(sessionId)}/change-surface`);
    const x = e.changeSurface;
    expect.soft(cs.computed, `${e.key}.computed`).toBe(true);
    expect.soft(cs.changedFiles, `${e.key}.changedFiles`).toBe(x.changedFiles);
    expect.soft(cs.foldersTouched, `${e.key}.foldersTouched`).toBe(x.foldersTouched);
    expect.soft(cs.topLevelModules.length, `${e.key}.topLevelModules`).toBe(x.topLevelModules);
    expect.soft(cs.singleFileFolders, `${e.key}.singleFileFolders`).toBe(x.singleFileFolders);
    expect.soft(cs.linesAdded, `${e.key}.linesAdded`).toBe(x.linesAdded);
    expect.soft(cs.linesRemoved, `${e.key}.linesRemoved`).toBe(x.linesRemoved);
    expect.soft(cs.outsideRepoFiles, `${e.key}.outsideRepoFiles`).toBe(x.outsideRepoFiles);
    expect.soft(cs.concentration, `${e.key}.concentration`).toBe(x.concentration);
    expect.soft(cs.band, `${e.key}.band`).toBe(x.band);
  }
});

test('GOLDEN-LOAD REPO-GOLD totals: executive summary, tokens, cache ratio, tools, productivity @mode-a', async ({ golden }) => {
  const t = golden.totals;
  const keyOf = new Map(golden.roots.map((r) => [shiftGoldenTime(r.expected.start, golden.deltaDays).getTime(), r.expected.key]));

  await test.step('executive summary', async () => {
    interface Exec {
      totalCost: number;
      totalSessions: number;
      avgCostPerSession: number;
      totalLinesChanged: number;
      avgCostPerLine: number;
      avgLinesPerHour: number;
      avgSessionLengthMs: number;
      excludedSessionCount: number;
      excludedModels: string[];
      weeklyBuckets: { weekStart: string; sessionCount: number; totalCost: number }[];
      modelMix: { model: string; sessionCount: number; cost: number }[];
      topSessions: { startTime: string; cost: number }[];
    }
    const ex = await getJson<Exec>(golden, '/reports/executive-summary', golden.range);
    close(ex.totalCost, t.costUsd, 'exec.totalCost');
    expect.soft(ex.totalSessions, 'exec.totalSessions').toBe(t.rootSessions);
    close(ex.avgCostPerSession, t.avgCostPerSessionUsd, 'exec.avgCostPerSession');
    expect.soft(ex.totalLinesChanged, 'exec.totalLinesChanged').toBe(t.lines.written);
    close(ex.avgCostPerLine, t.avgCostPerLineUsd, 'exec.avgCostPerLine');
    close(ex.avgLinesPerHour, t.avgLinesPerHour, 'exec.avgLinesPerHour');
    expect.soft(ex.avgSessionLengthMs, 'exec.avgSessionLengthMs').toBe(t.avgSessionLengthMs);
    expect.soft(ex.excludedSessionCount, 'exec.excludedSessionCount').toBe(t.excludedSessionCount);
    expect.soft([...ex.excludedModels].sort(), 'exec.excludedModels').toEqual([...t.excludedModels].sort());
    const w1 = golden.base.toISOString().slice(0, 10);
    const w2 = new Date(golden.base.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    const week = (d: string) => ex.weeklyBuckets.find((b) => b.weekStart === d);
    close(week(w1)?.totalCost, t.costByWeek.W1, 'exec.week W1 cost');
    close(week(w2)?.totalCost, t.costByWeek.W2, 'exec.week W2 cost');
    expect.soft(week(w1)?.sessionCount, 'exec.week W1 sessions').toBe(t.sessionsByWeek.W1);
    expect.soft(week(w2)?.sessionCount, 'exec.week W2 sessions').toBe(t.sessionsByWeek.W2);
    for (const [model, m] of Object.entries(t.costByRootModel)) {
      const mix = ex.modelMix.find((x) => x.model === model);
      expect.soft(mix?.sessionCount, `exec.modelMix ${model} sessions`).toBe(m.sessions);
      // An unpriced model is excluded from the totals; the mix shows it at 0.
      close(mix?.cost, m.costUsd ?? 0, `exec.modelMix ${model} cost`);
    }
    const top = ex.topSessions.map((s) => ({ key: keyOf.get(Date.parse(s.startTime)) ?? s.startTime, cost: s.cost }));
    expect.soft(top.map((s) => s.key), 'exec.topSessions order').toEqual(t.topSessionsByCost.map((s) => s.key));
    t.topSessionsByCost.forEach((s, i) => close(top[i]?.cost, s.costUsd, `exec.topSessions[${i}].cost`));
  });

  await test.step('branch summary: sessions, work time, lines', async () => {
    interface Branch { branch: string; sessionCount: number; totalWorkTimeMs: number; totalLinesChanged: number }
    const rows = await getJson<Branch[]>(golden, '/sessions/branches', golden.range);
    expect.soft(rows.map((r) => r.branch).sort(), 'branches').toEqual(Object.keys(t.sessionsByBranch).sort());
    for (const r of rows) {
      expect.soft(r.sessionCount, `branch ${r.branch} sessions`).toBe(t.sessionsByBranch[r.branch]);
      expect.soft(r.totalWorkTimeMs, `branch ${r.branch} work time`).toBe(t.workTimeMsByBranch[r.branch]);
      expect.soft(r.totalLinesChanged, `branch ${r.branch} lines (tree)`).toBe(t.linesWrittenByBranch[r.branch]);
    }
  });

  await test.step('token analytics', async () => {
    interface Tokens { totals: { input: number; output: number; cacheRead: number; cacheCreation: number; cacheWrite5m: number; cacheWrite1h: number } }
    const { totals } = await getJson<Tokens>(golden, '/analytics/tokens', golden.range);
    expect.soft(totals, 'tokens.totals').toEqual({
      input: t.tokens.tree.input,
      output: t.tokens.tree.output,
      cacheRead: t.tokens.tree.cacheRead,
      cacheCreation: t.tokens.tree.cacheWrite,
      cacheWrite5m: t.tokens.tree.cacheWrite5m,
      cacheWrite1h: t.tokens.tree.cacheWrite1h,
    });
  });

  await test.step('cache read ratio report: ratio of sums, not the mean of ratios', async () => {
    interface Scope { sessionCount: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number; ratio: number; undefinedRatioSessionCount: number }
    interface Causes { compaction: { creationTokens: number }; fileReread: { creationTokens: number }; unattributed: { creationTokens: number }; thresholdTokens: number }
    const rep = await getJson<{ root: Scope; withDescendants: Scope; causes: Causes }>(golden, '/reports/cache-read-ratio', golden.range);
    expect.soft(rep.root.sessionCount, 'cache.root.sessionCount').toBe(t.rootSessions);
    expect.soft(rep.withDescendants.sessionCount, 'cache.withDescendants.sessionCount').toBe(t.sessionsWithDescendants);
    expect.soft(rep.root.cacheReadTokens, 'cache.root.cacheRead').toBe(t.tokens.root.cacheRead);
    expect.soft(rep.root.cacheWriteTokens, 'cache.root.cacheWrite').toBe(t.tokens.root.cacheWrite);
    expect.soft(rep.root.cacheWrite5mTokens, 'cache.root.cacheWrite5m').toBe(t.tokens.root.cacheWrite5m);
    expect.soft(rep.root.cacheWrite1hTokens, 'cache.root.cacheWrite1h').toBe(t.tokens.root.cacheWrite1h);
    expect.soft(rep.withDescendants.cacheReadTokens, 'cache.tree.cacheRead').toBe(t.tokens.tree.cacheRead);
    expect.soft(rep.withDescendants.cacheWriteTokens, 'cache.tree.cacheWrite').toBe(t.tokens.tree.cacheWrite);
    close(rep.root.ratio, t.cacheRatio.root, 'cache.root.ratio');
    close(rep.withDescendants.ratio, t.cacheRatio.withDescendants, 'cache.withDescendants.ratio');
    expect.soft(Math.abs(rep.root.ratio - t.cacheRatio.meanOfSessionRatiosTrap), 'cache.root.ratio is not the mean of ratios').toBeGreaterThan(0.01);
    expect.soft(rep.root.undefinedRatioSessionCount, 'cache.undefinedRatioSessionCount').toBe(t.undefinedRatioSessions);
    expect.soft(rep.causes.thresholdTokens, 'cache.causes.threshold').toBe(25_000);
    expect.soft(rep.causes.compaction.creationTokens, 'cache.causes.compaction').toBe(t.cacheCreationCausesRootThreshold25000.compaction);
    expect.soft(rep.causes.fileReread.creationTokens, 'cache.causes.fileReread').toBe(t.cacheCreationCausesRootThreshold25000.fileReread);
    expect.soft(rep.causes.unattributed.creationTokens, 'cache.causes.unattributed').toBe(t.cacheCreationCausesRootThreshold25000.unattributed);
  });

  await test.step('tool analytics', async () => {
    interface Tool { tool: string; calls: number; successes: number; failures: number; unresolved: number; failureRate: number }
    const tools = await getJson<{ tools: Tool[]; totalCalls: number }>(golden, '/analytics/tools', golden.range);
    expect.soft(tools.totalCalls, 'tools.totalCalls').toBe(t.toolCalls);
    expect.soft(tools.tools.map((x) => x.tool).sort(), 'tools list').toEqual(Object.keys(t.tools).sort());
    for (const row of tools.tools) {
      const exp = t.tools[row.tool];
      if (!exp) continue;
      expect.soft({ calls: row.calls, successes: row.successes, failures: row.failures, unresolved: row.unresolved }, `tools.${row.tool}`).toEqual({
        calls: exp.calls,
        successes: exp.successes,
        failures: exp.failures,
        unresolved: exp.unresolved,
      });
      close(row.failureRate, exp.failureRate, `tools.${row.tool}.failureRate`);
    }
  });

  await test.step('productivity analytics', async () => {
    interface Prod { totals: { linesAdded: number; linesRemoved: number; commits: number; pullRequests: number; diffCoveredCalls: number; diffTotalCalls: number } }
    const { totals } = await getJson<Prod>(golden, '/analytics/productivity', golden.range);
    expect.soft(totals, 'productivity.totals').toEqual({
      linesAdded: t.lines.added,
      linesRemoved: t.lines.removed,
      commits: t.commits,
      pullRequests: t.pullRequests,
      diffCoveredCalls: t.lines.diffCoveredCalls,
      diffTotalCalls: t.lines.editWriteCalls,
    });
  });
});

test('GOLDEN-LOAD work time per day merges overlapping sessions @mode-a', async ({ golden }) => {
  const rows = await getJson<{ day: string; workTimeMinutes: number }[]>(golden, '/analytics/work-time', golden.range);
  const byDay = new Map(rows.map((r) => [r.day.slice(0, 10), r.workTimeMinutes]));
  const days = Object.entries(golden.totals.workTimeMinutesByDay);
  expect.soft(rows, 'one row per day of the range').toHaveLength(days.length);
  for (const [day, minutes] of days) {
    const shifted = shiftGoldenTime(`${day}T00:00:00.000Z`, golden.deltaDays).toISOString().slice(0, 10);
    close(byDay.get(shifted), minutes, `work-time ${day} (${shifted})`);
  }
});

// Code bug, recorded in the task Notes ("Golden numbers vs the app", branch cost): the computed
// cost of GET .../sessions/branches (Cost by Branch, Branch Summary) is root-only, while the
// session list, timeline and Executive Summary roll up sub-agents. expected.json keeps the tree
// value; remove `test.fail` once the branch route rolls up its sub-agents.
test('GOLDEN-LOAD cost by branch includes sub-agents @mode-a', async ({ golden }) => {
  test.fail(true, 'branch cost is root-only — see requirements.md Notes, "Golden numbers vs the app"');
  const rows = await getJson<{ branch: string; totalCost: number | null }[]>(golden, '/sessions/branches', golden.range);
  for (const [branch, cost] of Object.entries(golden.totals.costByBranch)) {
    const row = rows.find((r) => r.branch === branch);
    expect(row?.totalCost, `branch ${branch} cost`).toBeCloseTo(cost, 6);
  }
});
