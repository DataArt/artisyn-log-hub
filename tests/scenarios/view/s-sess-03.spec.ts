// S-SESS-03. Logs: what counts as a prompt, what is hidden, how a turn reads
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-SESS-03; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-07 (main: three prompts with failures, a denial, an unresolved call, plus distractors —
// a sidechain pair of 50 000 / 10 000 tokens, an isMeta line, a late <task-notification> and an
// answer split over two lines with one `message.id`), GS-01 (files; no harness snapshot, so the old-hook
// state of the System context anatomy tab) and GS-05 (the System context anatomy tab — numbers from
// its expected.json `anatomy` block —, and the ResearchWorkflow run with its two workflow agents W1/W2
// for the Agents table). Uploaded through POST /api/v2/logs (DD SC3); the numbers come from their
// expected.json (DD D3). Step 1a checks the session list's stored flags (session_stats
// `has_workflow`, algorithm doc session-list-flags.md): it re-uploads GS-07's claude body with one
// extra Workflow call, checks the flag, the analytics timeline's log line count (stored as
// `claude_line_count`) and that recompute-all-sessions leaves the list unchanged, then
// restores the original body for the later steps. Step 6a uploads its own small session (a background agent, a
// <task-notification> and the main thread finishing after it): the turn's work time runs from the
// prompt to the last answer. Step 6b uploads four real Claude Code captures of MCP calls moved to
// the background (tests/scenarios/fixtures/bg-mcp, from the PoC docs/pocs/2026-11-09-1318-mcp-mock-old-new-cc)
// and checks the badge, duration and output of the slow_echo / slow_fail modals (algorithm doc
// tool-call-outcome.md rule 1a, TO-27…TO-31). Step 8c uploads one with a Workflow call rejected before launch and one
// launched by scriptPath (workflow status and name). Step 8a2 opens GS-05's View system prompt
// modal (algorithm doc system-prompt-view.md; numbers from its expected.json `systemPromptView`
// block): parts split at the dynamic boundary, tools from the later snapshot gs05-0003p, the
// startup flags only, masked paths, and Copy as Markdown = Download .md. Step 8a3 opens GS-05's
// Recommendations modal (algorithm doc startup-recommendations.md; numbers from its expected.json
// `recommendations` block) and checks that GS-07 has no Recommendations button. Step 8d uploads one whose
// startup estimate exceeds its measured total (the over-total edge state) and has no
// prompt_snapshot, so no View system prompt button. Steps 12–15 (2026-11-23 session-logs-streaming)
// check the parts read path on GS-05: on open only the manifest and the root parts load; a part
// answers gzip; legacy `/logs` and the delta full snapshot equal the parts; a foreign user gets
// 4xx; an upload of one loaded agent refetches only its part (FR-4); and the derived-lag notice.
// Steps 16–21 (2026-11-24 session-parts-disk-cache) check the parts disk cache under
// <runDir>/upload-queue/part-cache: a read fills it and later reads are served from it (mode A
// proves the bytes do not come from Postgres), no pre-warm on upload and the old revision's file
// removed on the next fill, the read-touch and the TTL sweep, the size cap (mode C), fail-open on
// an unwritable cache folder, and the folders removed with deleted sessions and repositories.
// Mode-C stands share a 1 MB cache with parallel scenarios, so mode C never relies on one file
// surviving (impl-plan DD-15).
//
// Code facts that differ from the design text:
//   - the prompt text of a turn is shown in its header, not collapsed behind a click; the scenario
//     reads it as shown.
//   - the per-turn costs of GS-07 are not literals of expected.json (only the session total is): the
//     scenario checks that the three turn costs add up to it and that each tooltip's rows add up to
//     its turn.
//   - a denied call (an is_error result with Claude Code's rejection sentence) is rendered «⊘ rejected»
//     in the tool modal, not «✗ error» (algorithm doc tool-call-outcome.md); the Statistics tab's
//     outcome split (failure vs unresolved) is S-SESS-08's job.
//   - a Bash call's modal is the Bash view (bash-command-view.md): caption, FILES (Changes), the
//     COMMAND with a Formatted | Raw toggle and «Copy original», then OUTPUT — not the input JSON.
//
// Replaces:
//   - client/src/viewer/__tests__/unit/log-parser.test.ts (qualifying user event rules, slash command
//     full-command reconstruction, turn index is global, token double-count prevention, parentUuid BFS
//     assignment, per-turn token scoping, uuid absent, toolCalls, toolCalls result capture, file bytes
//     and estTokens: ≈ 70)
//   - client/src/viewer/__tests__/components/prompt-turn-item.test.tsx (18)
//   - client/src/viewer/__tests__/components/cost-breakdown-tooltip.test.tsx (8)
//   - client/src/viewer/__tests__/unit/turn-anchor.test.ts (5)
//   - server/src/logs/claude-extractor.spec.ts (dedup and sidechain: ≈ 20)
//   - tests/e2e/session-log-view.spec.ts (basic Logs checks: ≈ 6)
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { standMode } from '../helpers/auth-mode';
import { loadExpected, materializeGolden } from '../helpers/golden';
import { ownRepoId, promptSessionBodies, type PromptSession } from '../helpers/prompt-session';
import { holdSessionTreeLock } from '../helpers/ingest';
import { waitForQueueIdle } from '../helpers/queue';
import { hms, infoValue, int, logTurns, num, openSession, turnMetric, uploadGoldenRepo, usd4 } from '../helpers/session-view';

const HIDDEN_TEXTS = [
  'Side task: summarise the build log', // sidechain user line
  'Build log summary.', // sidechain answer
  'The user opened src/ok.ts.', // isMeta line
  'Background build finished', // <task-notification>
];
const PROMPTS = ['Run the test suite', 'Clean the build folder and check the sources', 'Print ok'];

/** GS-05 `expected.json` → `roots[0].anatomy` (checked by tests/golden/check-arithmetic.mjs). */
interface GoldenAnatomy {
  charsPerToken: number;
  total: number;
  attributed: number;
  harnessInternals: number;
  partitions: Record<string, { bytes: number; tokens: number }>;
}

/**
 * GS-05 `expected.json` → `roots[0].recommendations` (algorithm doc startup-recommendations.md;
 * checked by tests/golden/check-arithmetic.mjs). `ids` in catalog order.
 */
interface GoldenRecommendations {
  charsPerToken: number;
  denominator: number;
  count: number;
  measuredTokens: number;
  ids: string[];
  rows: Record<string, { items: Record<string, number>; bytes: number; tokens: number }>;
}

/** GS-05 `expected.json` → `roots[0].systemPromptView` (checked by tests/golden/check-arithmetic.mjs). */
interface GoldenSystemPromptView {
  charsPerToken: number;
  parts: number;
  shared: number;
  session: number;
  partsBytes: number;
  partsTokens: number;
  tools: number;
  toolsBytes: number;
  toolsTokens: number;
  totalBytes: number;
  totalTokens: number;
}

declare global {
  interface Window {
    /** Step 8a2: the text the stubbed `navigator.clipboard.writeText` received. */
    __copied?: string;
  }
}

/** The session-list fields step 1a compares (cost fields + the stored workflow flag). */
interface ListRow {
  sessionId: string;
  totalCost: unknown;
  costBreakdown: unknown;
  computedCost: unknown;
  hasCostDiscrepancy: unknown;
  costUnavailableReason: unknown;
  hasWorkflow: boolean;
}

/** `GET …/logs/parts` (2026-11-23 session-logs-streaming DD-11), the fields steps 12–15 read. */
interface PartsManifest {
  parts: Array<{ sessionId: string; logType: string; rev: string }>;
  subagentStats: Record<string, unknown>;
  rootStats: unknown;
  workflows: unknown;
  turnEndAdvisor: unknown;
  sessionAttribution: unknown;
  harnessSnapshot: unknown;
  derivedLagging: boolean;
}

/** The legacy `GET …/logs` document. */
interface LegacyLogs {
  main: unknown[];
  subagents: Array<{ sessionId: string; logs: unknown[] }>;
  subagentStats: Record<string, unknown>;
  rootStats: unknown;
  workflows: unknown;
  turnEndAdvisor: unknown;
  sessionAttribution: unknown;
  harnessSnapshot: unknown;
}

/** A full snapshot of `GET …/logs/delta` (no cursor). */
interface DeltaSnapshot {
  reload: boolean;
  rootArtisynLines: unknown[];
  rootClaudeLines: unknown[];
  newSubagents: Array<{ sessionId: string; logs: unknown[] }>;
}

interface LogEntry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { id?: string; content?: unknown };
}

test('@S-SESS-03 Logs: what counts as a prompt, what is hidden, how a turn reads @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
  stand,
}) => {
  test.setTimeout(480_000);
  const G7 = loadExpected('gs-07').roots[0];
  const G1 = loadExpected('gs-01').roots[0];
  const owner = await users.user('user', { label: 'ss03-owner' });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const repo = await test.step('1. upload GS-07, GS-01 and GS-05', async () =>
    uploadGoldenRepo(api, db, owner, ['gs-07', 'gs-01', 'gs-05']));
  const sid7 = repo.rootId('gs-07');

  await test.step('1a. session list: GS-05 hasWorkflow, GS-07 not; a re-upload of GS-07 with a Workflow call sets it; recompute-all-sessions changes no cost field and no flag', async () => {
    const listRows = async (): Promise<ListRow[]> => {
      const res = await owner.api.get(`/api/v1/repositories/${repo.repoId}/sessions`);
      expect(res.status(), 'GET .../sessions').toBe(200);
      return ((await res.json()) as ListRow[])
        .map(({ sessionId, totalCost, costBreakdown, computedCost, hasCostDiscrepancy, costUnavailableReason, hasWorkflow }) =>
          ({ sessionId, totalCost, costBreakdown, computedCost, hasCostDiscrepancy, costUnavailableReason, hasWorkflow }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    };
    const flagOf = (rows: ListRow[], sid: string) => rows.find((r) => r.sessionId === sid)?.hasWorkflow;
    // The analytics timeline's log line count is stored with the same flags (claude_line_count).
    const timelineLineCount = async (sid: string): Promise<number | undefined> => {
      const res = await owner.api.get(`/api/v1/repositories/${repo.repoId}/analytics/timeline`, {
        params: { startDate: '2000-01-01T00:00:00.000Z', endDate: '2100-01-01T00:00:00.000Z' },
      });
      expect(res.status(), 'GET .../analytics/timeline').toBe(200);
      return ((await res.json()) as Array<{ sessionId: string; logLineCount: number }>).find((r) => r.sessionId === sid)?.logLineCount;
    };
    const before = await listRows();
    expect(flagOf(before, repo.rootId('gs-05')), 'GS-05 has a Workflow call').toBe(true);
    expect(flagOf(before, sid7), 'GS-07 has none').toBe(false);

    const original = materializeGolden('gs-07', { runId: repo.runId }).uploads.find((u) => u.sessionId === sid7 && u.type === 'claude');
    if (!original) throw new Error('GS-07 has no claude upload');
    const lines = original.body.split('\n').filter((l) => l.trim() !== '');
    const last = JSON.parse(lines[lines.length - 1]) as { sessionId?: string; timestamp?: string };
    const workflowLine = {
      type: 'assistant', uuid: `${sid7}-wf`, sessionId: last.sessionId ?? sid7, timestamp: last.timestamp, isSidechain: false,
      message: { id: `${sid7}-wf-msg`, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ss03_wf', name: 'Workflow', input: {} }] },
    };
    expect(await timelineLineCount(sid7), 'timeline log line count = the transcript lines').toBe(lines.length);
    const key = await createApiKey(owner.api);
    const uploadClaude = async (body: string) => {
      const res = await api.post('/api/v2/logs', {
        params: { sessionId: sid7, type: 'claude' },
        headers: { 'Content-Type': 'text/plain', 'X-API-Key': key.key },
        data: body,
      });
      expect(res.status(), 'upload GS-07 claude').toBe(201);
      await waitForQueueIdle(db, owner.id, { timeoutMs: 30_000 });
    };

    await uploadClaude([...lines, JSON.stringify(workflowLine)].join('\n') + '\n');
    const withWorkflow = await listRows();
    expect(flagOf(withWorkflow, sid7), 'the re-upload with a Workflow call sets the flag, no restart').toBe(true);
    expect(await timelineLineCount(sid7), 'the re-upload updates the stored line count').toBe(lines.length + 1);

    expect((await owner.api.post(`/api/v1/repositories/${repo.repoId}/recompute-all-sessions`)).status()).toBe(201);
    expect(await listRows(), 'recompute leaves every cost field and flag as ingest stored them').toEqual(withWorkflow);

    // Back to the fixture as shipped, so the later steps read GS-07 unchanged.
    await uploadClaude(original.body);
    expect(flagOf(await listRows(), sid7), 'the original body clears the flag again').toBe(false);
    expect(await timelineLineCount(sid7), 'and restores the line count').toBe(lines.length);
  });

  await test.step('2. GET .../logs of GS-07 keeps the raw data whole: sidechain pair, isMeta, task-notification, duplicate message.id', async () => {
    const res = await owner.api.get(`/api/v1/repositories/${repo.repoId}/sessions/${encodeURIComponent(sid7)}/logs`);
    expect(res.status()).toBe(200);
    const { main } = (await res.json()) as { main: LogEntry[] };
    expect(main.filter((e) => e.isSidechain === true), 'sidechain user + assistant').toHaveLength(2);
    expect(main.filter((e) => e.type === 'user' && e.isMeta === true)).toHaveLength(1);
    expect(main.filter((e) => JSON.stringify(e.message?.content ?? '').includes('<task-notification>'))).toHaveLength(1);
    const ids = main.filter((e) => e.type === 'assistant' && e.message?.id).map((e) => e.message!.id!);
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(repeated, 'one answer split over two lines with the same message.id').toHaveLength(1);
  });

  await test.step(`3. Logs of GS-07: exactly ${G7.prompts} turns; sidechain, isMeta and task-notification are not shown`, async () => {
    await openSession(page, owner, repo.repoId, sid7, { tab: 'logs' });
    const turns = logTurns(page);
    await expect(turns).toHaveCount(G7.prompts);
    for (const [i, prompt] of PROMPTS.entries()) await expect(turns.nth(i)).toContainText(prompt);
    for (const text of HIDDEN_TEXTS) await expect(page.getByText(text), text).toHaveCount(0);
  });

  await test.step('4. turn tokens add up to the deduplicated totals (sidechain 50 000 not in), times 20 / 30 / 10 s, costs to the session cost', async () => {
    const turns = logTurns(page);
    const sum = { in: 0, out: 0, cr: 0, cw: 0, cost: 0 };
    const perPrompt = G7.perPrompt as Array<{ workTimeMs: number }>;
    for (let i = 0; i < G7.prompts; i += 1) {
      const turn = turns.nth(i);
      sum.in += num(await turnMetric(turn, 'In').innerText());
      sum.out += num(await turnMetric(turn, 'Out').innerText());
      sum.cr += num(await turnMetric(turn, 'cache_r').innerText());
      sum.cw += num(await turnMetric(turn, 'cache_w').innerText());
      sum.cost += num(await turnMetric(turn, 'Cost').innerText());
      await expect(turn, `turn ${i + 1} work time`).toContainText(hms(perPrompt[i].workTimeMs));
    }
    const t = G7.tokens.own;
    expect(sum.in).toBe(t.input);
    expect(sum.out).toBe(t.output);
    expect(sum.cr).toBe(t.cacheRead);
    expect(sum.cw).toBe(t.cacheWrite5m + t.cacheWrite1h);
    expect(sum.cost).toBeCloseTo(G7.costUsd!, 6);
    expect(perPrompt.reduce((n, p) => n + p.workTimeMs, 0), 'the late task-notification adds no time').toBe(G7.workTimeMs);
  });

  await test.step('5. cost tooltip of turn 1: one row per token type, and the rows add up to the turn cost', async () => {
    const turn = logTurns(page).first();
    const turnCost = await turnMetric(turn, 'Cost').innerText();
    await turn.getByText('Cost', { exact: true }).hover();
    const tip = page.locator('table', { hasText: 'Calculated approx. total' });
    await expect(tip).toBeVisible();
    const labels = ['Token In', 'Token Out', 'Cache Read', 'Cache Write 5m', 'Cache Write 1h'];
    let rows = 0;
    for (const label of labels) {
      const row = tip.locator('tr', { hasText: label });
      await expect(row, label).toHaveCount(1);
      rows += num(await row.locator('td').last().innerText());
    }
    await expect(tip.locator('tr', { hasText: 'Calculated approx. total' }).locator('td').last()).toHaveText(turnCost);
    expect(rows).toBeCloseTo(num(turnCost), 4);
    await page.mouse.move(0, 0);
  });

  await test.step('6. turn 2 Tools → Bash row opens the Bash view: «⊘ rejected», COMMAND rm -rf build, Changes build, Formatted | Raw, Copy original, OUTPUT (the denial) with copy', async () => {
    const turn = logTurns(page).nth(1);
    await turn.getByRole('button', { name: /Tools/ }).click();
    await turn.locator('tr', { hasText: 'Bash' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Bash');
    // is_error + the rejection sentence → rejected, not error (tool-call-outcome.md TO-04).
    await expect(dialog.getByTestId('tool-status-badge')).toHaveText('⊘ rejected');
    await expect(dialog).not.toContainText('✗ error');
    const view = dialog.getByTestId('bash-command-view');
    await expect(view.getByTestId('bash-caption')).toHaveText('Remove the build folder');
    // The parser loads lazily; FILES and the toggle appear once the view is ready.
    await expect(view.getByTestId('bash-files-changes')).toContainText('build');
    await expect(view.getByTestId('bash-highlighted-script')).toContainText('rm -rf build');
    const formatted = view.getByRole('button', { name: 'formatted' });
    const raw = view.getByRole('button', { name: 'raw' });
    await expect(formatted).toHaveAttribute('aria-pressed', 'true');
    await raw.click();
    await expect(raw).toHaveAttribute('aria-pressed', 'true');
    await expect(view.getByTestId('bash-highlighted-script')).toContainText('rm -rf build');
    await expect(view.getByRole('button', { name: '⧉ Copy original' })).toBeVisible();
    const output = view.getByTestId('tool-output-block');
    await expect(output).toContainText("The user doesn't want to proceed with this tool use");
    await expect(output.getByRole('button', { name: 'copy' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  await test.step('6a. a background task the main thread finishes after its <task-notification>: the turn runs from the prompt to the last answer (0:05:10), not to the hand-off (0:00:10)', async () => {
    const runId = randomBytes(4).toString('hex');
    const s: PromptSession = {
      sessionId: `ss03-bg-${runId}`,
      prompt: `ss03 background task ${runId}`,
      repoUrl: `https://git.arrakis.test/scn/${runId}/ss03-bg`,
    };
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const t = (sec: number) => new Date(at.getTime() + sec * 1000).toISOString();
    const id = (n: string) => `${s.sessionId}-${n}`;
    const answer = (uuid: string, parentUuid: string, sec: number, content: unknown[]) => ({
      type: 'assistant', uuid: id(uuid), parentUuid: id(parentUuid), sessionId: s.sessionId, timestamp: t(sec),
      message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 5 }, content },
    });
    const claude = [
      { type: 'user', uuid: id('u1'), sessionId: s.sessionId, timestamp: t(0), message: { role: 'user', content: [{ type: 'text', text: s.prompt }] } },
      answer('a1', 'u1', 5, [{ type: 'tool_use', id: id('bg'), name: 'Agent', input: { prompt: 'research', run_in_background: true } }]),
      { type: 'user', uuid: id('r1'), parentUuid: id('a1'), sessionId: s.sessionId, timestamp: t(6),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id('bg'), content: 'Started in the background.' }] } },
      answer('a2', 'r1', 10, [{ type: 'text', text: 'The research runs in the background.' }]),
      { type: 'user', uuid: id('n1'), parentUuid: id('a2'), sessionId: s.sessionId, timestamp: t(300),
        message: { role: 'user', content: `<task-notification>\n<task-id>${id('bg')}</task-id>\n<status>completed</status>\n</task-notification>` } },
      answer('a3', 'n1', 310, [{ type: 'text', text: 'Research folded in.' }]),
    ];
    const key = await createApiKey(owner.api);
    const bodies = { artisyn: promptSessionBodies({ ...s, at }).artisyn, claude: claude.map((r) => JSON.stringify(r)).join('\n') + '\n' };
    for (const type of ['artisyn', 'claude'] as const) {
      const res = await api.post('/api/v2/logs', {
        params: { sessionId: s.sessionId, type },
        headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
        data: bodies[type],
      });
      expect(res.status(), `upload ${type}`).toBe(201);
    }
    await waitForQueueIdle(db, owner.id);
    const repoId = await ownRepoId(owner.api, s.repoUrl);

    await openSession(page, owner, repoId, s.sessionId, { tab: 'logs' });
    const turns = logTurns(page);
    await expect(turns, 'the notification is not a prompt').toHaveCount(1);
    await expect(turns.first()).toContainText(hms(310_000));
    await openSession(page, owner, repoId, s.sessionId, { tab: 'info' });
    await expect(infoValue(page, 'Autonomous work time')).toHaveText(hms(310_000));
  });

  await test.step('6b. MCP calls moved to the background (real captures, CC 2.1.211 and 2.1.319): the task notification decides the badge, ends the ⏱ duration and is the output; no notification → «⧗ background»; the old transcript is unchanged', async () => {
    const runId = randomBytes(4).toString('hex');
    const repoUrl = `https://git.arrakis.test/scn/${runId}/ss03-bg-mcp`;
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'bg-mcp');
    type Capture = 'old-full' | 'new-full' | 'new-live' | 'new-close';
    // DD-19: the run's session id, uuids prefixed with it, every timestamp shifted by one constant
    // so the first line lands at `at` (deltas stay exact). Task and tool_use ids stay as captured.
    const captureBody = (capture: Capture, sessionId: string): string => {
      const lines = fs.readFileSync(path.join(fixturesDir, `${capture}.transcript.jsonl`), 'utf8')
        .split('\n').filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const first = lines.find((r) => typeof r.timestamp === 'string')?.timestamp;
      if (typeof first !== 'string') throw new Error(`${capture} has no timestamp`);
      const shift = at.getTime() - Date.parse(first);
      const prefixed = (v: unknown) => (typeof v === 'string' ? `${sessionId}-${v}` : v);
      // The PoC sanitizer keeps only conversation lines, so a parentUuid can point at a dropped
      // line (an attachment, …); re-link it to the nearest earlier kept line, as the dropped chain did.
      const uuids = new Set(lines.map((r) => r.uuid).filter((u) => typeof u === 'string'));
      let lastUuid: unknown = null;
      return lines.map((r) => {
        const parent = typeof r.parentUuid === 'string' && !uuids.has(r.parentUuid) ? lastUuid : r.parentUuid;
        if (typeof r.uuid === 'string') lastUuid = r.uuid;
        return JSON.stringify({
          ...r,
          sessionId,
          ...('uuid' in r ? { uuid: prefixed(r.uuid) } : {}),
          ...('parentUuid' in r ? { parentUuid: prefixed(parent) } : {}),
          ...('sourceToolAssistantUUID' in r ? { sourceToolAssistantUUID: prefixed(r.sourceToolAssistantUUID) } : {}),
          ...(typeof r.timestamp === 'string' ? { timestamp: new Date(Date.parse(r.timestamp) + shift).toISOString() } : {}),
        });
      }).join('\n') + '\n';
    };
    const key = await createApiKey(owner.api);
    const sessions = {} as Record<Capture, string>;
    for (const capture of ['old-full', 'new-full', 'new-live', 'new-close'] as const) {
      const s: PromptSession = { sessionId: `ss03-${capture}-${runId}`, prompt: `ss03 background MCP ${capture} ${runId}`, repoUrl };
      sessions[capture] = s.sessionId;
      const bodies = { artisyn: promptSessionBodies({ ...s, at }).artisyn, claude: captureBody(capture, s.sessionId) };
      for (const type of ['artisyn', 'claude'] as const) {
        const res = await api.post('/api/v2/logs', {
          params: { sessionId: s.sessionId, type },
          headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
          data: bodies[type],
        });
        expect(res.status(), `upload ${capture} ${type}`).toBe(201);
      }
    }
    await waitForQueueIdle(db, owner.id);
    const repoId = await ownRepoId(owner.api, repoUrl);

    // The Logs modal of one call: badge, ⏱ (null = not checked) and the output it shows.
    const checkCall = async (tool: 'slow_echo' | 'slow_fail', badge: string, duration: string | null, output: string) => {
      const turn = logTurns(page).first();
      await turn.locator('tr', { hasText: `mock:${tool}` }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('tool-status-badge'), `${tool} badge`).toHaveText(badge);
      if (duration !== null) await expect(dialog.getByTitle('duration'), `${tool} duration`).toHaveText(`⏱ ${duration}`);
      await expect(dialog.getByTestId('tool-output-block'), `${tool} output`).toContainText(output);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    };
    const openCapture = async (capture: Capture) => {
      await openSession(page, owner, repoId, sessions[capture], { tab: 'logs' });
      const turns = logTurns(page);
      await expect(turns, `${capture}: the notifications are not prompts`).toHaveCount(1);
      await turns.first().getByRole('button', { name: /Tools/ }).click();
    };

    // CC 2.1.319, both notifications: the notification time ends the call, its <result> is the output.
    await openCapture('new-full');
    await checkCall('slow_echo', '✓ ok', '8.1s', 'slow_echo: c');
    await checkCall('slow_fail', '✗ error', '10.0s', 'Task failed: slow_fail: d failed');
    // The turn ended first: only the enqueue of a failed task («Connection closed»).
    await openCapture('new-close');
    await checkCall('slow_echo', '✗ error', '10.3s', 'Task failed: Connection closed');
    // No notification at all: still running or the session ended first — not a failure. The
    // output says the result is missing (not the hand-off ack), and the ack time is no duration.
    await openCapture('new-live');
    await checkCall('slow_echo', '⧗ background', null, 'Moved to the background as task kkumm8n15. No result in this log');
    await logTurns(page).first().locator('tr', { hasText: 'mock:slow_echo' }).first().click();
    await expect(page.getByRole('dialog').getByTitle('duration'), 'no duration without a notification').toHaveCount(0);
    await expect(page.getByRole('dialog').getByTestId('tool-output-block')).not.toContainText('keeps running');
    await page.keyboard.press('Escape');
    // CC 2.1.211 (before the hand-off, regression guard): the call ran in-session, nothing changes.
    await openCapture('old-full');
    await checkCall('slow_echo', '✓ ok', '8.0s', 'slow_echo: c');
    await checkCall('slow_fail', '✗ error', null, 'slow_fail: d failed');
  });

  await test.step('7. GS-01 Files: src/app.ts with its repeat-access mark ×2, docs/api.md in the Docs group', async () => {
    await openSession(page, owner, repo.repoId, repo.rootId('gs-01'), { tab: 'logs' });
    const turn = logTurns(page).first();
    await expect(turn).toContainText(int((G1.perPrompt as Array<{ tokens: { input: number } }>)[0].tokens.input));
    const group = (name: string) =>
      turn.locator('div.border-l-2', { has: page.getByRole('button', { name: new RegExp(`${name}\\b`) }) }).last();
    const files = G1.files as Record<string, { accessCount?: number; category?: string }>;
    await group('Code').getByRole('button', { name: /Code/ }).click();
    const app = group('Code').locator('tr', { hasText: 'src/app.ts' }).filter({ hasText: `×${files['src/app.ts'].accessCount}` });
    await expect(app).toHaveCount(1);
    await expect(group('Code').locator('tr', { hasText: 'docs/api.md' })).toHaveCount(0);
    expect(files['docs/api.md'].category).toBe('docs');
    await group('Docs').getByRole('button', { name: /Docs/ }).click();
    await expect(group('Docs').locator('tr', { hasText: 'docs/api.md' })).toHaveCount(1);
  });

  await test.step('8. GS-05 System context anatomy: total 8,800, partitions (Tool definitions from the tools snapshot: Artifact, PowerShell, Read, Bash) and harness internals 5,443 (61.9 %) from expected.json, the internals hint without a tools bullet, a bar segment selects its row, skills drill-down = the listing (unused-skill not shown, adlc:review-deep from a plugin)', async () => {
    const A5 = loadExpected('gs-05').roots[0].anatomy as GoldenAnatomy;
    await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'sysctx' });
    const tab = page.getByTestId('sysctx-anatomy-tab');
    await expect(tab.getByTestId('anatomy-total')).toHaveText(`Total ${int(A5.total)} tokens · exact (input + cache write + cache read)`);
    await expect(tab.getByTestId('anatomy-banner'), 'hook 2.28.0 snapshot with git status: no edge banner').toHaveCount(0);
    const row = (kind: string) => tab.locator(`[data-testid="anatomy-partition-row"][data-kind="${kind}"]`);
    // Columns: PARTITION · KIND · SOURCE · BYTES · ≈ TOKENS · SHARE.
    for (const [kind, p] of Object.entries(A5.partitions)) {
      await expect(row(kind).locator('td').nth(3), `${kind} bytes`).toHaveText(int(p.bytes));
      await expect(row(kind).locator('td').nth(4), `${kind} tokens`).toHaveText(int(p.tokens));
    }
    const internals = row('harness-internals');
    expect(((A5.harnessInternals / A5.total) * 100).toFixed(1), 'GS-05 internals share (DD 13)').toBe('61.9');
    await expect(internals.locator('td').nth(4)).toHaveText(int(A5.harnessInternals));
    await expect(internals.locator('td').nth(5)).toHaveText(`${((A5.harnessInternals / A5.total) * 100).toFixed(1)} %`);

    await internals.getByTestId('anatomy-internals-hint').hover();
    const hint = page.getByTestId('anatomy-internals-hint-text').first();
    await expect(row('harness-internals'), 'with the tools measured the remainder is named for what it is').toContainText('Formatting & unlogged text');
    await expect(hint).toContainText(`Formatting & unlogged text — ≈ ${int(A5.harnessInternals)} tokens (${((A5.harnessInternals / A5.total) * 100).toFixed(1)} % of the startup context)`);
    await expect(hint).toContainText(`The exact total ${int(A5.total)} minus everything attributed above (${int(A5.attributed)})`);
    await expect(hint, 'the tools have their own row, so the hint does not list them').not.toContainText('Tool definitions');
    await expect(hint).toContainText('Message wrapping');
    await expect(hint).not.toContainText('Unallocated');
    await page.mouse.move(0, 0);
    await expect(tab, 'the internals are never called unallocated or free').not.toContainText(/Unallocated|\bfree\b/);

    await tab.locator('[data-testid="anatomy-segment"][data-kind="instruction-file"]').click();
    await expect(row('instruction-file')).toHaveAttribute('aria-selected', 'true');
    await expect(row('skills')).toHaveAttribute('aria-selected', 'false');

    await row('tool-definitions').click();
    const toolRows = tab.locator('[data-row-kind="tool-definitions"]');
    await expect(toolRows, 'one row per tool of the tools snapshot').toHaveCount(4);
    // Bytes descending: Artifact 700, PowerShell 350, Read 299, Bash 79.
    for (const [i, name] of ['Artifact', 'PowerShell', 'Read', 'Bash'].entries())
      await expect(toolRows.nth(i), `tool row ${i + 1}`).toContainText(name);
    await expect(toolRows.nth(0), 'a built-in tool').toContainText('built-in');
    await expect(toolRows.nth(3), 'an MCP tool').toContainText('MCP server');

    await row('skills').click();
    await expect(row('skills')).toHaveAttribute('aria-selected', 'true');
    await expect(row('instruction-file')).toHaveAttribute('aria-selected', 'false');
    const skills = tab.getByTestId('anatomy-skill-row');
    await expect(skills, 'one row per listed skill; unused-skill and gold-sync are not listed').toHaveCount(2);
    await expect(tab.locator('[data-testid="anatomy-skill-row"][data-skill-name="unused-skill"]')).toHaveCount(0);
    await expect(tab.locator('[data-testid="anatomy-skill-row"][data-skill-name="gold-sync"]')).toHaveCount(0);
    await expect(tab.locator('[data-testid="anatomy-skill-row"][data-skill-name="adlc:review-deep"]')).toHaveAttribute('data-source', 'plugin');
    await expect(tab.locator('[data-testid="anatomy-skill-row"][data-skill-name="adlc:review"]')).toHaveAttribute('data-source', 'plugin');
  });

  await test.step('8a. GS-05 files drill-down: git tracked / ignored / outside repo, rules on demand, no file text and no absolute path; the Logs startup-context line links to the tab', async () => {
    const tab = page.getByTestId('sysctx-anatomy-tab');
    const files = tab.getByTestId('anatomy-file-row');
    // The instruction-file row was expanded by the segment click in step 8.
    const paths = await files.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-path')));
    expect(paths, 'loaded files first (snapshot CLAUDE.md merged with the log one), then the on-demand rules').toEqual([
      '~/.claude/CLAUDE.md',
      'CLAUDE.md',
      'CLAUDE.local.md',
      '.claude/rules/db.md',
      '.claude/rules/ui.md',
    ]);
    const file = (p: string) => tab.locator(`[data-testid="anatomy-file-row"][data-path="${p}"]`);
    await expect(file('CLAUDE.md')).toHaveAttribute('data-git', 'tracked');
    await expect(file('CLAUDE.local.md')).toHaveAttribute('data-git', 'ignored');
    await expect(file('~/.claude/CLAUDE.md')).toHaveAttribute('data-git', 'outside-repo');
    await expect(file('.claude/rules/db.md')).toHaveAttribute('data-git', 'tracked');
    await expect(file('.claude/rules/ui.md')).toHaveAttribute('data-git', 'untracked');
    await expect(tab.getByText('On demand — 0 at start')).toBeVisible();
    // Columns: PATH · KIND · GIT · FILE SIZE · LOADED B · ≈ TOKENS · SHARE.
    for (const rule of ['.claude/rules/db.md', '.claude/rules/ui.md'])
      await expect(file(rule).locator('td').nth(4), `${rule} loads 0 at start`).toHaveText('0');
    await expect(file('CLAUDE.md').locator('td').nth(4)).toHaveText('3,500');

    const markers = ['GS05-LOCAL-MARKER', 'GS05-USER-MARKER', 'GS05-PROJECT-MARKER', 'Use parameterised queries only', 'You are a coding assistant', 'Use the postgres server', 'dev@arrakis.test'];
    for (const text of markers) await expect(tab, `no file, prompt or reminder text: ${text}`).not.toContainText(text);
    await expect(tab, 'no absolute path').not.toContainText(/\/home\/|\/work\//);

    await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'logs' });
    const line = page.getByTestId('startup-context-line');
    await expect(line).toContainText('Startup context');
    await expect(line).toContainText('8,800 tokens');
    await expect(page.getByTestId('sysctx-panel'), 'the old System Context panel is gone').toHaveCount(0);
    await line.getByRole('button', { name: /View anatomy/ }).click();
    await expect(page.getByTestId('sysctx-anatomy-tab')).toBeVisible();
    await expect(page).toHaveURL(/[?&]tab=sysctx\b/);
    // Back to Logs for the workflow Agents table (8b).
    await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'logs' });
    await expect(page.getByTestId('startup-context-line')).toBeVisible();
  });

  await test.step('8a2. GS-05 View system prompt: totals from expected.json, Shared 2 / Session-specific 1 parts, Expand / Collapse all; Read, Bash (MCP · gs05-mcp), Artifact and PowerShell from the later snapshot with a table, raw <system-reminder> text and masked schema; startup flags only; Copy = Download, masked, no local path; no prompt text left in the tab', async () => {
    const V = loadExpected('gs-05').roots[0].systemPromptView as GoldenSystemPromptView;
    const A5 = loadExpected('gs-05').roots[0].anatomy as GoldenAnatomy;
    // The modal's figures are the anatomy's rows: prompt = system prompt + memory index, tools = Tool definitions.
    expect(V.partsBytes).toBe(A5.partitions['system-prompt'].bytes + A5.partitions.memory.bytes);
    expect(V.toolsTokens).toBe(A5.partitions['tool-definitions'].tokens);
    await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'sysctx' });
    const tab = page.getByTestId('sysctx-anatomy-tab');
    await tab.getByTestId('sysprompt-open').click();
    const modal = page.getByTestId('sysprompt-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('sysprompt-totals')).toHaveText(
      `First request ${int(A5.total)} tokens (exact) = System prompt ≈ ${int(V.partsTokens)} (${int(V.parts)} parts) + Tool definitions ≈ ${int(V.toolsTokens)} (${int(V.tools)} tools) + ≈ ${int(A5.total - V.totalTokens)} everything else (opening messages — see the anatomy table)`,
    );
    const items = (panel: string) => modal.getByTestId(`sysprompt-panel-${panel}`).getByTestId('sysprompt-item');

    // System prompt tab (default): split at the dynamic boundary marker, the marker itself not shown.
    const prompt = modal.getByTestId('sysprompt-panel-prompt');
    await expect(prompt.getByTestId('sysprompt-toolbar')).toHaveText(
      `${int(V.parts)} parts · ${int(V.partsBytes)} B · ≈ ${int(V.partsTokens)} tok = harness core ${int(A5.partitions['system-prompt'].bytes)} B + memory index ${int(A5.partitions.memory.bytes)} B`,
    );
    await expect(prompt.locator('[data-testid="sysprompt-group"][data-group="shared"]')).toHaveText(`Shared · ${V.shared} parts`);
    await expect(prompt.locator('[data-testid="sysprompt-group"][data-group="session"]')).toHaveText(`Session-specific · ${V.session} parts`);
    const parts = items('prompt');
    await expect(parts).toHaveCount(V.parts);
    const titles: Array<[string, string]> = [
      ['shared', 'You are a coding assistant working in the…'],
      ['shared', '# Memory'],
      ['session', '# Environment'],
    ];
    for (const [i, [section, title]] of titles.entries()) {
      await expect(parts.nth(i), `part ${i + 1} section`).toHaveAttribute('data-section', section);
      await expect(parts.nth(i).locator('.truncate').first(), `part ${i + 1} title`).toHaveText(title);
    }
    await expect(modal, 'the boundary marker is no part').not.toContainText('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    await prompt.getByTestId('sysprompt-expand-all').click();
    for (let i = 0; i < V.parts; i += 1) await expect(parts.nth(i), `part ${i + 1} expanded`).toHaveAttribute('data-expanded', 'true');
    await expect(parts.nth(2).getByTestId('sysprompt-item-body'), 'paths masked in the part text').toContainText('Working directory: src');
    await prompt.getByTestId('sysprompt-collapse-all').click();
    for (let i = 0; i < V.parts; i += 1) await expect(parts.nth(i), `part ${i + 1} collapsed`).toHaveAttribute('data-expanded', 'false');
    await expect(prompt.getByTestId('sysprompt-item-body'), 'a collapsed part mounts no body').toHaveCount(0);

    // Tool definitions: from the first snapshot that carries tools (gs05-0003p), not the startup one.
    await modal.getByTestId('sysprompt-tab-tools').click();
    const toolsPanel = modal.getByTestId('sysprompt-panel-tools');
    await expect(toolsPanel.getByTestId('sysprompt-tools-summary')).toHaveText(
      `${int(V.tools)} tools · ${int(V.toolsBytes)} B · ≈ ${int(V.toolsTokens)} tokens — the Tool definitions row of the anatomy tab, from the prompt snapshot`,
    );
    const tools = items('tools');
    await expect(tools).toHaveCount(V.tools);
    // The snapshot's own order: Read, Bash, then the built-in Artifact and PowerShell.
    for (const [i, name] of ['Read', 'Bash', 'Artifact', 'PowerShell'].entries())
      await expect(tools.nth(i).locator('.truncate .font-mono'), `tool ${i + 1}`).toHaveText(name);
    for (const i of [2, 3]) await expect(tools.nth(i), 'a built-in tool has no server').not.toContainText('MCP ·');
    await expect(tools.nth(1).locator('.truncate'), 'the MCP server badge after the name').toContainText('MCP · gs05-mcp');
    await expect(tools.nth(0), 'Read has no server').not.toContainText('MCP ·');
    await tools.nth(0).getByRole('button').first().click();
    const readBody = tools.nth(0).getByTestId('sysprompt-item-body');
    await expect(readBody.locator('table'), 'the description is Markdown: its table renders').toHaveCount(1);
    await expect(readBody, 'raw HTML stays text').toContainText('<system-reminder>stays text</system-reminder>');
    await expect(readBody.locator('system-reminder'), 'no raw HTML element').toHaveCount(0);
    await expect(readBody, 'description path masked').toContainText('<outside>/notes.md');
    await expect(readBody.locator('pre'), 'the schema JSON block, its strings masked').toContainText('<outside>/file.txt');
    await expect(readBody).not.toContainText('C:\\Users');

    // Flags: the startup snapshot's own keys, never the later snapshot's, never `type`.
    await modal.getByTestId('sysprompt-tab-flags').click();
    const flags = items('flags');
    const keys = await flags.evaluateAll((rows) => rows.map((r) => r.querySelector('.truncate')?.textContent ?? ''));
    // Sorted: the stored transcript is jsonb, which reorders object keys (length, then bytes).
    expect([...keys].sort(), 'the startup flags; systemPrompt, tools and type excluded').toEqual(['cliPrefix', 'contextRendering', 'gs05Extra', 'reminderFold']);
    const flag = (key: string) => flags.filter({ has: page.locator('.truncate', { hasText: new RegExp(`^${key}$`) }) });
    await expect(flag('cliPrefix'), 'the startup value, not gs05-late').toHaveText('cliPrefixgs05');
    await expect(flag('cliPrefix')).toHaveAttribute('data-section', 'flag');
    await expect(flag('gs05Extra')).toHaveAttribute('data-expanded', 'false');
    await flag('gs05Extra').getByRole('button').click();
    await expect(flag('gs05Extra').getByTestId('sysprompt-item-body').locator('pre'), 'object flag JSON, cwd masked to the repo root').toContainText('"cwd": "."');
    for (const t of ['prompt', 'tools', 'flags'] as const) {
      await modal.getByTestId(`sysprompt-tab-${t}`).click();
      await expect(modal, `${t}: the later snapshot's prompt is ignored`).not.toContainText('GS05-LATE-PART');
      await expect(modal, `${t}: the later snapshot's flags are ignored`).not.toContainText('gs05-late');
    }

    // Copy as Markdown (clipboard stubbed) and Download .md export the same masked text.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { window.__copied = text; } },
      });
    });
    await modal.getByTestId('sysprompt-copy').click();
    await expect(modal.getByTestId('sysprompt-copy')).toHaveText('Copied');
    const copied = await page.evaluate(() => window.__copied ?? '');
    const [download] = await Promise.all([page.waitForEvent('download'), modal.getByTestId('sysprompt-download').click()]);
    expect(download.suggestedFilename()).toMatch(/^system-prompt-.*\.md$/);
    const file = fs.readFileSync(await download.path(), 'utf8');
    expect(file, 'Download writes what Copy copied').toBe(copied);
    for (const masked of [
      'Working directory: src',
      '~/.claude/projects/<project-slug>/memory/MEMORY.md',
      '<outside>/notes.txt',
      '<outside>/notes.md',
      '<outside>/file.txt',
      '"cwd": "."',
      '# Tool definitions',
      '## Bash · server gs05-mcp',
    ]) expect(file, `export holds ${masked}`).toContain(masked);
    for (const local of ['/home/dev', '/tmp/gs05', 'C:\\Users', '/work/repo-gold', 'GS05-LATE-PART', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'])
      expect(file, `export has no ${local}`).not.toContain(local);

    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(tab, 'prompt text lives only in the modal').not.toContainText('GS05-SESSION-MARKER');
  });

  await test.step('8a3. GS-05 Recommendations: badge = count, rows in catalog order with their ≈ tokens, summary (Claude Code 2.1.99), docs links on every row, a snippet copies, no request and no file or tool text; GS-07 has no Recommendations button', async () => {
    const R = loadExpected('gs-05').roots[0].recommendations as GoldenRecommendations;
    const A5 = loadExpected('gs-05').roots[0].anatomy as GoldenAnatomy;
    const share = (tokens: number) => `${(Math.round((tokens / R.denominator) * 1000) / 10).toFixed(1)} %`;
    expect(R.count, 'count = ids').toBe(R.ids.length);
    expect(R.denominator, 'GS-05 is not over-total: the share is of the whole total').toBe(A5.total);
    const tab = page.getByTestId('sysctx-anatomy-tab');
    // Still on GS-05's anatomy tab from 8a2 (clipboard stub in place).
    const open = tab.getByTestId('sysctx-reco-open');
    await expect(open).toBeVisible();
    await expect(open.getByTestId('sysctx-reco-count')).toHaveText(String(R.count));
    await expect(page.getByTestId('sysctx-reco-modal'), 'mounted only while open').toHaveCount(0);

    const requests: string[] = [];
    const onRequest = (req: { url(): string }) => requests.push(req.url());
    page.on('request', onRequest);
    await open.click();
    const modal = page.getByTestId('sysctx-reco-modal');
    await expect(modal).toBeVisible();

    const rows = modal.getByTestId('sysctx-reco-row');
    await expect(rows).toHaveCount(R.count);
    expect(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-reco-id'))), 'catalog order').toEqual(R.ids);
    for (const id of R.ids) {
      const r = R.rows[id];
      const tokens = modal.locator(`[data-testid="sysctx-reco-row"][data-reco-id="${id}"]`).getByTestId('sysctx-reco-tokens');
      await expect(tokens, `${id} tokens`).toContainText(`≈ ${int(r.tokens)}`);
      await expect(tokens, `${id} share and bytes`).toContainText(`${share(r.tokens)} · ${int(r.bytes)} B`);
    }
    expect(R.ids.reduce((n, id) => n + R.rows[id].tokens, 0), 'measuredTokens = Σ row tokens').toBe(R.measuredTokens);
    await expect(modal.getByTestId('sysctx-reco-summary')).toHaveText(
      `${int(R.count)} matched · ≈ ${int(R.measuredTokens)} tokens (${share(R.measuredTokens)} of ${int(R.denominator)}) · Claude Code 2.1.99 · catalog v1`,
    );
    // Every row links to the Claude Code docs of its setting, opened in a new tab.
    for (const id of R.ids) {
      const docs = modal.locator(`[data-testid="sysctx-reco-row"][data-reco-id="${id}"]`).getByTestId('sysctx-reco-doc');
      expect(await docs.count(), `${id} has a docs link`).toBeGreaterThan(0);
      for (const link of await docs.all()) {
        await expect(link).toHaveAttribute('href', /^https:\/\/code\.claude\.com\/docs\/en\/[a-z-]+$/);
        await expect(link).toHaveAttribute('target', '_blank');
      }
    }
    await expect(modal.getByTestId('sysctx-reco-row').filter({ hasText: 'Verify:' }), 'no "Verify:" marks').toHaveCount(0);

    for (const marker of ['GS05-LOCAL-MARKER', 'GS05-TOOL-MARKER'])
      await expect(modal, `no file or tool text: ${marker}`).not.toContainText(marker);
    await expect(modal, 'no absolute path').not.toContainText(/\/home\/|\/work\/|C:\\Users/);

    // One snippet copy (clipboard stubbed in 8a2): the two-shells row denies PowerShell.
    await page.evaluate(() => { window.__copied = undefined; });
    await modal.locator('[data-testid="sysctx-reco-row"][data-reco-id="startup.two-shells"]').getByTestId('sysctx-reco-copy').click();
    await expect.poll(() => page.evaluate(() => window.__copied ?? '')).toBe('"permissions": { "deny": ["PowerShell"] }');

    page.off('request', onRequest);
    expect(requests, 'the modal is computed from the loaded payload: no request').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    // GS-07 (no harness snapshot, no tools source): nothing matches, so no button.
    await openSession(page, owner, repo.repoId, sid7, { tab: 'sysctx' });
    await expect(page.getByTestId('sysctx-anatomy-tab')).toBeVisible();
    await expect(page.getByTestId('anatomy-total')).toBeVisible();
    await expect(page.getByTestId('sysctx-reco-open'), 'GS-07: no recommendation matches').toHaveCount(0);

    // Back to Logs, the state 8b starts from.
    await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'logs' });
    await expect(page.getByTestId('startup-context-line')).toBeVisible();
  });

  await test.step('8b.GS-05 workflow Agents table: shown as soon as the workflow opens; one row per agent with label (W1 its .meta.json description, W2 its prompt), phase (W1 Config, W2 —), duration, tokens and cost; numbers 1/2 and 12-char ids; a row opens a modal titled by the label with the agent Logs and Raw logs tabs; no extra request', async () => {
    const G5 = loadExpected('gs-05').roots[0];
    const node = (key: string) => {
      const n = G5.nodes.find((x) => x.key === key);
      if (!n || n.costUsd === null) throw new Error(`gs-05 expected.json has no priced node "${key}"`);
      return { ...n, costUsd: n.costUsd };
    };
    const apiRequests: string[] = [];
    const onRequest = (req: { url(): string }) => {
      if (req.url().includes('/api/')) apiRequests.push(req.url());
    };
    page.on('request', onRequest);

    await page.getByText('⚡ ResearchWorkflow', { exact: true }).click();
    await expect(page.getByText('Agents (2)', { exact: true })).toBeVisible();
    const rows = page.getByTestId('workflow-agent-row');
    await expect(rows).toHaveCount(2);
    // W1 has a .meta.json description and phase (upload.json agentDescription / workflowPhase):
    // the description is the label, the prompt stays the hover title. W2 has neither: prompt label, «—».
    const expectedRows = [
      { key: 'w1', label: 'load-config', prompt: 'Add a billing section to src/report.ts', phase: 'Config', duration: '0:00:18' },
      { key: 'w2', label: 'Review the billing flow in depth', prompt: 'Review the billing flow in depth', phase: '—', duration: '0:00:23' },
    ];
    // Columns: # · TASK · PHASE · DURATION · TOKENS · COST (Phase shows because W1 has one).
    await expect(page.getByRole('columnheader', { name: 'Phase' })).toHaveCount(1);
    for (const { key, label, prompt, phase, duration } of expectedRows) {
      const row = page.locator(`[data-testid="workflow-agent-row"][data-agent-id$="gs05${key}"]`);
      await expect(row, `${key} row`).toHaveCount(1);
      const cells = row.locator(':scope > td');
      const n = node(key);
      await expect(cells.nth(1), `${key} label`).toContainText(label);
      await expect(cells.nth(1).locator('div[title]').first(), `${key} hover title is the prompt`).toHaveAttribute('title', prompt);
      await expect(cells.nth(2), `${key} phase`).toHaveText(phase);
      await expect(cells.nth(3), `${key} duration`).toHaveText(duration);
      const t = n.tokens;
      const tokens = t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
      await expect(cells.nth(4), `${key} tokens`).toHaveText(`${(tokens / 1000).toFixed(1)}K`);
      await expect(cells.nth(5), `${key} cost`).toHaveText(usd4(n.costUsd));
      const agentId = (await row.getAttribute('data-agent-id'))!;
      await expect(cells.nth(1), `${key} id line`).toContainText(`${agentId.slice(0, 12)}…`);
    }
    await expect(
      page.locator('[data-testid="workflow-agent-row"][data-agent-id$="gs05w1"]').locator(':scope > td').nth(1),
      'W1 label is the description, not the prompt',
    ).not.toContainText(expectedRows[0].prompt);
    const numbers = await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('td')?.textContent?.trim()));
    expect(new Set(numbers), 'the # cells (both agents start together: order is AO-02, not checked here)').toEqual(new Set(['1', '2']));

    const w1 = page.locator('[data-testid="workflow-agent-row"][data-agent-id$="gs05w1"]');
    await w1.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const agentIdW1 = (await w1.getAttribute('data-agent-id'))!;
    await expect(dialog.getByRole('heading').first(),'the modal title is the W1 label (its description) and its id').toHaveText(`${expectedRows[0].label}${agentIdW1}`);
    // "Logs" tab (default): the agent's own turn, rendered like the session's Logs tab.
    const agentLogs = dialog.getByTestId('workflow-agent-logs');
    await expect(agentLogs, 'the turn shows the agent prompt').toContainText(expectedRows[0].prompt);
    // "Raw logs" tab: the agent's transcript, rendered like the session's Raw Logs tab.
    await dialog.getByRole('tab', { name: 'Raw logs' }).click();
    const rawLogs = dialog.getByTestId('workflow-agent-raw-logs');
    await expect(rawLogs, 'the TurnHeader row').toContainText('Turn #1');
    const records = rawLogs.locator('tbody tr.cursor-pointer');
    await expect(records, "W1's 4 records, header row excluded").toHaveCount(4);
    await records.last().click();
    await expect(rawLogs).toContainText('Billing section added.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    page.off('request', onRequest);
    // Opening the run loads its two agents' log parts (2026-11-23 session-logs-streaming DD-13);
    // the table and the agent modal then reuse them.
    const agentParts = apiRequests.filter((u) => /\/logs\/parts\/agent-[^/]+\/claude-subagent$/.test(new URL(u).pathname));
    expect(agentParts.map((u) => new URL(u).pathname.split('/').slice(-2)[0]).sort(), 'the run loads its agents').toEqual(
      [repo.agentId('gs-05', 'w1'), repo.agentId('gs-05', 'w2')].sort(),
    );
    expect(apiRequests.filter((u) => !agentParts.includes(u)), 'the table and the agent modal reuse the loaded parts').toEqual([]);
  });

  await test.step('8b2. GS-05 agent description in Charts and Session Map: the Agent Tree node and the Session Map card of W1 read load-config; the Map loads the parts, never /logs/delta', async () => {
    await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'agent-tree' });
    const treeNode = page.locator('g[data-testid="agent-tree-node"][data-agent-id$="gs05w1"]');
    await expect(treeNode, 'W1 node in the Agent Tree').toHaveCount(1);
    await expect(treeNode.getByText('load-config'), 'the Agent Tree labels W1 by its description').toBeVisible();

    // The Map is built from the log parts (manifest + every part), never from /logs/delta: the
    // description reaches the card through the part's manifest entry.
    const mapRequests: string[] = [];
    const onMapRequest = (req: { url(): string }) => {
      const url = req.url();
      if (url.includes('/logs/')) mapRequests.push(url);
    };
    page.on('request', onMapRequest);
    try {
      await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'session-map' });
      await expect(page.getByTestId('session-map-badge')).toContainText('Replay', { timeout: 20_000 });
      const card = page.locator('[data-testid^="session-map-agent-"][data-testid$="gs05w1"]');
      await expect(card, 'W1 card').toHaveCount(1);
      await expect(card.locator('[title="load-config"]'), 'the W1 card title is its description').toHaveText('load-config');
    } finally {
      page.off('request', onMapRequest);
    }
    // The sub-agent parts may already be cached from the Agent Tree above; the W1 card proves the Map has them.
    expect(mapRequests.filter((u) => u.includes('/logs/delta')), 'the Map never asks for /logs/delta').toEqual([]);

    // Back to Logs, the state 8c starts from.
    await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'logs' });
    await expect(page.getByTestId('startup-context-line')).toBeVisible();
  });

  await test.step('8c. a Workflow call rejected before launch (is_error, no <task-notification>) is «failed» with its error, not «running»; a call launched by scriptPath (no name input) is named from toolUseResult.workflowName', async () => {
    const runId = randomBytes(4).toString('hex');
    const s: PromptSession = {
      sessionId: `ss03-wf-${runId}`,
      prompt: `ss03 workflow launch ${runId}`,
      repoUrl: `https://git.arrakis.test/scn/${runId}/ss03-wf`,
    };
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const t = (sec: number) => new Date(at.getTime() + sec * 1000).toISOString();
    const id = (n: string) => `${s.sessionId}-${n}`;
    const answer = (uuid: string, parentUuid: string, sec: number, content: unknown[]) => ({
      type: 'assistant', uuid: id(uuid), parentUuid: id(parentUuid), sessionId: s.sessionId, timestamp: t(sec),
      message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 5 }, content },
    });
    const launchError = 'InputValidationError: script contains control characters';
    const claude = [
      { type: 'user', uuid: id('u1'), sessionId: s.sessionId, timestamp: t(0), message: { role: 'user', content: [{ type: 'text', text: s.prompt }] } },
      answer('a1', 'u1', 5, [{ type: 'tool_use', id: id('wf1'), name: 'Workflow', input: { name: 'RejectedWorkflow' } }]),
      { type: 'user', uuid: id('r1'), parentUuid: id('a1'), sessionId: s.sessionId, timestamp: t(6), toolUseResult: `Error: ${launchError}`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id('wf1'), is_error: true, content: `<tool_use_error>${launchError}</tool_use_error>` }] } },
      answer('a2', 'r1', 10, [{ type: 'tool_use', id: id('wf2'), name: 'Workflow', input: { scriptPath: '/tmp/scratch/script-file.js' } }]),
      { type: 'user', uuid: id('r2'), parentUuid: id('a2'), sessionId: s.sessionId, timestamp: t(11),
        toolUseResult: { status: 'async_launched', taskId: 'wsss03', taskType: 'local_workflow', workflowName: 'ScriptWorkflow', runId: 'wf_ss03' },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id('wf2'), content: 'Workflow launched in background. Task ID: wsss03' }] } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: t(60),
        content: `<task-notification>\n<task-id>wsss03</task-id>\n<tool-use-id>${id('wf2')}</tool-use-id>\n<status>completed</status>\n<summary>Script workflow done</summary>\n</task-notification>` },
      answer('a3', 'r2', 70, [{ type: 'text', text: 'Both workflow calls are handled.' }]),
    ];
    const key = await createApiKey(owner.api);
    const bodies = { artisyn: promptSessionBodies({ ...s, at }).artisyn, claude: claude.map((r) => JSON.stringify(r)).join('\n') + '\n' };
    for (const type of ['artisyn', 'claude'] as const) {
      const res = await api.post('/api/v2/logs', {
        params: { sessionId: s.sessionId, type },
        headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
        data: bodies[type],
      });
      expect(res.status(), `upload ${type}`).toBe(201);
    }
    await waitForQueueIdle(db, owner.id);
    const repoId = await ownRepoId(owner.api, s.repoUrl);

    await openSession(page, owner, repoId, s.sessionId, { tab: 'logs' });
    const rejected = page.getByRole('button', { name: /⚡ RejectedWorkflow/ });
    await expect(rejected).toContainText('failed');
    await expect(rejected).not.toContainText('running');
    await rejected.click();
    await expect(page.getByText(launchError, { exact: true }), 'the launch error is the summary, wrapper stripped').toBeVisible();
    await expect(page.getByRole('button', { name: /⚡ ScriptWorkflow/ })).toContainText('completed');
    await page.getByRole('button', { name: /⚡ ScriptWorkflow/ }).click();
    await expect(page.getByRole('columnheader', { name: 'Phase' }), 'no agent of these runs has a phase: no Phase column').toHaveCount(0);
  });

  await test.step('8d. attributed > measured total (a 10,000-byte instruction file, first usage 100 tokens): the over-total warning, no harness internals row', async () => {
    const runId = randomBytes(4).toString('hex');
    const s: PromptSession = {
      sessionId: `ss03-over-${runId}`,
      prompt: `ss03 over total ${runId}`,
      repoUrl: `https://git.arrakis.test/scn/${runId}/ss03-over`,
    };
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const t = (sec: number) => new Date(at.getTime() + sec * 1000).toISOString();
    const id = (n: string) => `${s.sessionId}-${n}`;
    const claude = [
      { type: 'attachment', uuid: id('i1'), parentUuid: null, sessionId: s.sessionId, timestamp: t(0), isSidechain: false,
        attachment: { type: 'instructions', files: [{ path: `/work/ss03-over-${runId}/CLAUDE.md`, type: 'Project', content: 'x'.repeat(10_000) }] } },
      { type: 'user', uuid: id('u1'), parentUuid: id('i1'), sessionId: s.sessionId, timestamp: t(0), isSidechain: false,
        message: { role: 'user', content: s.prompt } },
      { type: 'assistant', uuid: id('a1'), parentUuid: id('u1'), sessionId: s.sessionId, timestamp: t(5), isSidechain: false,
        message: { id: id('m1'), role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 5 }, content: [{ type: 'text', text: 'Done.' }] } },
    ];
    const key = await createApiKey(owner.api);
    const bodies = { artisyn: promptSessionBodies({ ...s, at }).artisyn, claude: claude.map((r) => JSON.stringify(r)).join('\n') + '\n' };
    for (const type of ['artisyn', 'claude'] as const) {
      const res = await api.post('/api/v2/logs', {
        params: { sessionId: s.sessionId, type },
        headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
        data: bodies[type],
      });
      expect(res.status(), `upload ${type}`).toBe(201);
    }
    await waitForQueueIdle(db, owner.id);
    const repoId = await ownRepoId(owner.api, s.repoUrl);

    await openSession(page, owner, repoId, s.sessionId, { tab: 'sysctx' });
    const tab = page.getByTestId('sysctx-anatomy-tab');
    await expect(tab.getByTestId('anatomy-total')).toContainText('Total 100 tokens');
    const over = tab.locator('[data-testid="anatomy-banner"][data-variant="over-total"]');
    await expect(over).toBeVisible();
    await expect(over).toContainText(/Attributed estimate exceeds measured total by [\d,]+ tokens/);
    await expect(tab.locator('[data-testid="anatomy-partition-row"][data-kind="instruction-file"]')).toBeVisible();
    await expect(tab.locator('[data-testid="anatomy-partition-row"][data-kind="harness-internals"]')).toHaveCount(0);
    await expect(tab.locator('[data-testid="anatomy-segment"][data-kind="harness-internals"]')).toHaveCount(0);
    await expect(tab.getByTestId('sysprompt-open'), 'no prompt_snapshot: no View system prompt button').toHaveCount(0);
  });

  await test.step('8e. a recent session whose first assistant reply has not been uploaded yet (transcript ends at the prompt): a "still arriving" message instead of the anatomy and its old-hook banners', async () => {
    const runId = randomBytes(4).toString('hex');
    const at = new Date(Date.now() - 2 * 60 * 1000);
    const s: PromptSession = {
      sessionId: `ss03-pending-${runId}`,
      prompt: `ss03 pending ${runId}`,
      repoUrl: `https://git.arrakis.test/scn/${runId}/ss03-pending`,
      at,
    };
    const userLine = {
      type: 'user', uuid: `${s.sessionId}-u1`, parentUuid: null, sessionId: s.sessionId, timestamp: at.toISOString(), isSidechain: false,
      message: { role: 'user', content: s.prompt },
    };
    const key = await createApiKey(owner.api);
    const bodies = { artisyn: promptSessionBodies(s).artisyn, claude: JSON.stringify(userLine) + '\n' };
    for (const type of ['artisyn', 'claude'] as const) {
      const res = await api.post('/api/v2/logs', {
        params: { sessionId: s.sessionId, type },
        headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
        data: bodies[type],
      });
      expect(res.status(), `upload ${type}`).toBe(201);
    }
    await waitForQueueIdle(db, owner.id);
    const repoId = await ownRepoId(owner.api, s.repoUrl);

    await openSession(page, owner, repoId, s.sessionId, { tab: 'sysctx' });
    const tab = page.getByTestId('sysctx-anatomy-tab');
    await expect(tab).toContainText('Session data is still arriving');
    await expect(tab.getByTestId('anatomy-banner'), 'no old-hook / no-prompt-snapshot banner while waiting').toHaveCount(0);
    await expect(tab.getByTestId('anatomy-total')).toHaveCount(0);
  });

  await test.step('9. GS-01 (no harness snapshot): the anatomy tab shows the old-hook banner, git status only unknown or outside repo, and no page error', async () => {
    await openSession(page, owner, repo.repoId, repo.rootId('gs-01'), { tab: 'sysctx' });
    const tab = page.getByTestId('sysctx-anatomy-tab');
    await expect(tab.locator('[data-testid="anatomy-banner"][data-variant="old-hook"]')).toBeVisible();
    await expect(tab.locator('[data-testid="anatomy-banner"][data-variant="no-git"]')).toHaveCount(0);
    await expect(tab.getByTestId('anatomy-total')).toBeVisible();
    await tab.locator('[data-testid="anatomy-partition-row"][data-kind="instruction-file"]').click();
    const gits = await tab.getByTestId('anatomy-file-row').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-git')));
    for (const git of gits) expect(['unknown', 'outside-repo'], 'no snapshot: no tracked/ignored/untracked status').toContain(git);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  await test.step('10. GS-05 Session Map: one ResearchWorkflow column (no direct column — GS-05 has no plain Agent sub-agents), its header totals = the sum of W1 and W2', async () => {
    const G5 = loadExpected('gs-05').roots[0];
    const cost = (key: string) => G5.nodes.find((n) => n.key === key)?.costUsd ?? 0;
    await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'session-map' });
    const map = page.getByTestId('session-map');
    await expect(page.getByTestId('session-map-badge')).toContainText('Replay', { timeout: 20_000 });
    const columns = map.locator('[data-testid^="session-map-group-"]:not([data-testid$="-header"])');
    await expect(columns).toHaveCount(1);
    await expect(page.getByTestId('session-map-group-direct')).toHaveCount(0);
    const header = columns.first().locator('[data-testid$="-header"]');
    await expect(header).toContainText('ResearchWorkflow · run #1');
    const cards = columns.first().locator('[data-testid^="session-map-agent-"]');
    await expect(cards).toHaveCount(2);
    await expect(columns.first().locator('[data-testid$="gs05w1"]')).toHaveCount(1);
    await expect(columns.first().locator('[data-testid$="gs05w2"]')).toHaveCount(1);
    const cardCalls = await cards.evaluateAll((els) =>
      els.map((e) => {
        // The card's own «N calls» span (the top-tools text next to it also ends in a digit).
        const span = [...e.querySelectorAll('span')].find((s) => /^\d+ calls$/.test(s.textContent?.trim() ?? ''));
        return Number(/^(\d+)/.exec(span?.textContent?.trim() ?? '')?.[1] ?? NaN);
      }),
    );
    const calls = cardCalls.reduce((n, c) => n + c, 0);
    expect(calls, 'W1 Edit + W2 Skill, Read').toBe(3);
    await expect(header).toContainText(`$${(cost('w1') + cost('w2')).toFixed(2)}`);
    await expect(header).toContainText('2 agents');
    await expect(header).toContainText(`${calls} calls`);
  });

  await test.step('11. GS-05 Session Map: Highlight top 5 dims nobody (two agents), "with failed calls" dims both (none failed); Order by cost puts W1 ($0.008) before W2 ($0.0045)', async () => {
    const cards = page.locator('[data-testid^="session-map-agent-"]');
    await expect(page.locator('[data-testid^="session-map-agent-"][data-dimmed="true"]')).toHaveCount(0);
    await page.getByTestId('session-map-highlight').selectOption('top');
    await expect(page.locator('[data-testid^="session-map-agent-"][data-dimmed="true"]')).toHaveCount(0);
    await page.getByTestId('session-map-highlight').selectOption('failed');
    await expect(page.locator('[data-testid^="session-map-agent-"][data-dimmed="true"]')).toHaveCount(2);
    await page.getByTestId('session-map-highlight').selectOption('none');
    await page.getByTestId('session-map-order').selectOption('cost');
    const order = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
    expect(order.map((t) => t.slice(-6))).toEqual(['gs05w1', 'gs05w2']);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  // Steps 12–15 (2026-11-23 session-logs-streaming, FR-1..FR-4): the viewer loads a session as
  // a manifest plus one part per stored log row. GS-05 (root claude + artisyn, workflow agents
  // W1 and W2) is the tree. Last in the scenario: step 14 re-uploads W1 with one extra line.
  const sid5 = repo.rootId('gs-05');
  const w1 = repo.agentId('gs-05', 'w1');
  const w2 = repo.agentId('gs-05', 'w2');
  const logsBase = `/api/v1/repositories/${repo.repoId}/sessions/${encodeURIComponent(sid5)}/logs`;
  const partUrl = (sessionId: string, logType: string) => `${logsBase}/parts/${encodeURIComponent(sessionId)}/${logType}`;
  const partRequests: string[] = [];
  page.on('request', (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.includes('/logs')) partRequests.push(decodeURIComponent(pathname.slice(pathname.indexOf('/sessions/'))));
  });
  const manifestPath = `/sessions/${sid5}/logs/parts`;
  const partPath = (sessionId: string, logType: string) => `/sessions/${sid5}/logs/parts/${sessionId}/${logType}`;
  const fetchManifest = async (): Promise<PartsManifest> => {
    const res = await owner.api.get(`${logsBase}/parts`);
    expect(res.status(), 'GET .../logs/parts').toBe(200);
    return (await res.json()) as PartsManifest;
  };
  const fetchPart = async (sessionId: string, logType: string): Promise<unknown[]> => {
    const res = await owner.api.get(partUrl(sessionId, logType));
    expect(res.status(), `part ${sessionId}/${logType}`).toBe(200);
    return (await res.json()) as unknown[];
  };

  await test.step('12. opening GS-05 requests the manifest and the root claude and artisyn parts only — no legacy /logs, no agent part', async () => {
    // A fresh document, so nothing comes from the previous steps' query cache.
    await page.goto('about:blank');
    partRequests.length = 0;
    await openSession(page, owner, repo.repoId, sid5, { tab: 'logs' });
    await expect(logTurns(page).first()).toBeVisible({ timeout: 20_000 });
    const mine = () => partRequests.filter((p) => p.includes(`/sessions/${sid5}/logs`));
    await expect.poll(() => mine().includes(partPath(sid5, 'artisyn'))).toBe(true);
    expect(new Set(mine())).toEqual(new Set([manifestPath, partPath(sid5, 'claude'), partPath(sid5, 'artisyn')]));
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  await test.step('13. API: a part answers gzip once the builder ran (identity without gzip); legacy /logs is unchanged and equals the parts; the delta full snapshot has the same lines; a foreign user gets 4xx', async () => {
    const manifest = await fetchManifest();
    expect(manifest.parts.map((p) => `${p.sessionId}/${p.logType}`), 'root claude, root artisyn, then agents by id').toEqual(
      [`${sid5}/claude`, `${sid5}/artisyn`, ...[w1, w2].sort().map((w) => `${w}/claude-subagent`)],
    );
    expect(manifest.derivedLagging).toBe(false);
    const rootClaudeRev = manifest.parts[0].rev;

    // The gzip copy is built in the background (LOG_BODY_GZ_INTERVAL_MS, 1 s on the stand).
    await expect
      .poll(async () => (await owner.api.get(partUrl(sid5, 'claude'), { headers: { 'Accept-Encoding': 'gzip' } })).headers()['content-encoding'], {
        timeout: 30_000,
      })
      .toBe('gzip');
    const gz = await owner.api.get(partUrl(sid5, 'claude'), { headers: { 'Accept-Encoding': 'gzip' } });
    expect(gz.headers()['etag']).toBe(`"${rootClaudeRev}"`);
    const plain = await owner.api.get(partUrl(sid5, 'claude'), { headers: { 'Accept-Encoding': 'identity' } });
    expect(plain.headers()['content-encoding'], 'decompressed for a client without gzip').toBeUndefined();
    const claudeLines = (await gz.json()) as unknown[];
    expect((await plain.json()) as unknown[]).toEqual(claudeLines);
    const artisynLines = await fetchPart(sid5, 'artisyn');
    const agentLines: Record<string, unknown[]> = {};
    for (const w of [w1, w2]) agentLines[w] = await fetchPart(w, 'claude-subagent');

    const legacyRes = await owner.api.get(logsBase);
    expect(legacyRes.status()).toBe(200);
    const legacy = JSON.parse(await legacyRes.text()) as LegacyLogs;
    expect(Object.keys(legacy), '/logs keys in their historic order').toEqual([
      'main', 'subagents', 'subagentStats', 'rootStats', 'workflows', 'turnEndAdvisor', 'sessionAttribution', 'harnessSnapshot',
    ]);
    expect(legacy.main, 'main = artisyn lines, then claude lines').toEqual([...artisynLines, ...claudeLines]);
    expect(legacy.subagents.map((s) => s.sessionId).sort()).toEqual([w1, w2].sort());
    for (const s of legacy.subagents) expect(s.logs, s.sessionId).toEqual(agentLines[s.sessionId]);
    for (const [k, stats] of Object.entries(legacy.subagentStats)) {
      expect(stats, k).toHaveProperty('cacheWrite5mTokens');
      expect(stats, k).toHaveProperty('cacheWrite1hTokens');
    }
    expect(manifest.subagentStats).toEqual(legacy.subagentStats);
    expect(manifest.rootStats).toEqual(legacy.rootStats);
    expect(manifest.workflows).toEqual(legacy.workflows);
    expect(manifest.turnEndAdvisor).toEqual(legacy.turnEndAdvisor);
    expect(manifest.sessionAttribution).toEqual(legacy.sessionAttribution);
    expect(manifest.harnessSnapshot).toEqual(legacy.harnessSnapshot);

    const deltaRes = await owner.api.get(`${logsBase}/delta`);
    expect(deltaRes.status()).toBe(200);
    const delta = (await deltaRes.json()) as DeltaSnapshot;
    expect(delta.reload).toBe(false);
    expect([...delta.rootArtisynLines, ...delta.rootClaudeLines], 'delta root lines = /logs main').toEqual(legacy.main);
    expect(delta.newSubagents.map((s) => s.sessionId).sort()).toEqual([w1, w2].sort());
    for (const s of delta.newSubagents) expect(s.logs, s.sessionId).toEqual(agentLines[s.sessionId]);

    const stranger = await users.user('user', { label: 'ss03-stranger' });
    for (const url of [`${logsBase}/parts`, partUrl(sid5, 'claude'), partUrl(w1, 'claude-subagent')]) {
      const status = (await stranger.api.get(url)).status();
      expect(status, `foreign ${url}`).toBeGreaterThanOrEqual(400);
      expect(status, `foreign ${url}`).toBeLessThan(500);
    }
  });

  await test.step('14. FR-4: with every part loaded (Statistics), one upload of W1 then Refresh refetches the manifest and the W1 part only', async () => {
    await openSession(page, owner, repo.repoId, sid5, { tab: 'usage' });
    await expect(page.getByTestId('session-usage-tab')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('session-parts-loading')).toHaveCount(0);
    const before = (await fetchManifest()).parts.map((p) => p.rev);

    const upload = materializeGolden('gs-05', { runId: repo.runId }).uploads.find((u) => u.sessionId === w1);
    if (!upload) throw new Error('GS-05 has no W1 upload');
    const lines = upload.body.split('\n').filter((l) => l.trim() !== '');
    const last = JSON.parse(lines[lines.length - 1]) as { timestamp?: string };
    const marker = { type: 'system', subtype: 'informational', uuid: `${w1}-fr4`, timestamp: last.timestamp, content: 'FR-4 marker' };
    const key = await createApiKey(owner.api);
    partRequests.length = 0;
    const res = await api.post('/api/v2/logs', {
      params: {
        sessionId: w1,
        type: 'claude-subagent',
        parentSessionId: upload.parentSessionId ?? sid5,
        ...(upload.workflowRunId ? { workflowRunId: upload.workflowRunId } : {}),
        ...(upload.agentDescription ? { agentDescription: upload.agentDescription } : {}),
        ...(upload.workflowPhase ? { workflowPhase: upload.workflowPhase } : {}),
      },
      headers: { 'Content-Type': 'text/plain', 'X-API-Key': key.key },
      data: [...lines, JSON.stringify(marker)].join('\n') + '\n',
    });
    expect(res.status()).toBe(201);
    await waitForQueueIdle(db, owner.id, { timeoutMs: 30_000 });
    const after = (await fetchManifest()).parts.map((p) => p.rev);
    expect(after.filter((rev, i) => rev !== before[i]), 'only W1 has a new revision').toHaveLength(1);

    await page.getByTestId('session-refresh').click();
    await expect.poll(() => partRequests.includes(partPath(w1, 'claude-subagent'))).toBe(true);
    // Let any other refetch the Refresh would cause start before the check.
    await page.waitForTimeout(1_500);
    const parts = partRequests.filter((p) => p.includes(`/sessions/${sid5}/logs/parts/`));
    expect(parts, 'only the changed part is refetched').toEqual([partPath(w1, 'claude-subagent')]);
    expect(partRequests.filter((p) => p.endsWith(`/sessions/${sid5}/logs`)), 'no legacy /logs').toEqual([]);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  await test.step('15. derivedLagging: a re-extract queued for over 30 s shows the lag notice; once the drain ran, Refresh clears it', async () => {
    const notice = page.getByTestId('session-derived-lagging');
    await expect(notice).toHaveCount(0);
    // Holding the tree's ingest lock keeps the re-extract drain from finishing the row.
    const release = await holdSessionTreeLock(db, sid5);
    try {
      await db.query(
        `INSERT INTO session_reextract_queue (session_pk, requested_at)
         SELECT id, now() - interval '1 minute' FROM sessions WHERE session_id = $1
         ON CONFLICT (session_pk) DO UPDATE SET requested_at = excluded.requested_at`,
        [sid5],
      );
      expect((await fetchManifest()).derivedLagging).toBe(true);
      await page.getByTestId('session-refresh').click();
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Some figures may lag behind the latest upload');
    } finally {
      await release();
    }
    await expect
      .poll(
        async () =>
          Number(
            (
              await db.query<{ n: string }>(
                'SELECT count(*) AS n FROM session_reextract_queue q JOIN sessions s ON s.id = q.session_pk WHERE s.session_id = $1',
                [sid5],
              )
            ).rows[0].n,
          ),
        { timeout: 30_000 },
      )
      .toBe(0);
    expect((await fetchManifest()).derivedLagging).toBe(false);
    await page.getByTestId('session-refresh').click();
    await expect(notice).toHaveCount(0);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  // Steps 16–21 (2026-11-24 session-parts-disk-cache): the stand's cache is the default
  // <runDir>/upload-queue/part-cache, swept every second (modes.ts). Mode A has the 1 GB default
  // cap; mode C a 1 MB cap shared with parallel scenarios, so only mode A relies on a file
  // surviving (DD-15).
  const mode = standMode();
  expect(stand.runDir, 'STAND_RUN_DIR (the cache lives under it)').not.toBe('');
  const cacheDir = path.join(stand.runDir, 'upload-queue', 'part-cache');
  const cacheFile = (logId: number, rev: string) => path.join(cacheDir, String(logId), `${rev}.json.gz`);
  /** The stored row of one part; `bodyGz` is null until the gzip copy matches the revision. */
  const logRow = async (sessionId: string, logType: string): Promise<{ id: number; rev: string; bodyGz: Buffer | null }> => {
    const { rows } = await db.query<{ id: string; rev: string; body_gz: Buffer | null }>(
      `SELECT l.id::text AS id, l.body_rev::text AS rev,
              CASE WHEN l.body_rev IS NOT NULL AND l.body_gz_rev = l.body_rev THEN l.body_gz END AS body_gz
         FROM logs l JOIN sessions s ON s.id = l.session_id
        WHERE s.session_id = $1 AND l.log_type = $2`,
      [sessionId, logType],
    );
    expect(rows, `one ${logType} row of ${sessionId}`).toHaveLength(1);
    return { id: Number(rows[0].id), rev: rows[0].rev, bodyGz: rows[0].body_gz };
  };
  /** A cached row whose gzip copy is built (LOG_BODY_GZ_INTERVAL_MS, 1 s on the stand). */
  const gzReadyRow = async (sessionId: string, logType: string) => {
    await expect.poll(async () => (await logRow(sessionId, logType)).bodyGz !== null, { timeout: 30_000 }).toBe(true);
    const row = await logRow(sessionId, logType);
    if (row.bodyGz === null) throw new Error(`${sessionId}/${logType} has no current gzip copy`);
    return { ...row, bodyGz: row.bodyGz };
  };
  const sizeOf = (file: string): number | null => {
    try {
      return fs.statSync(file).size;
    } catch {
      return null;
    }
  };
  const mtimeOf = (file: string): number | null => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };
  const readCacheFile = (file: string): Buffer | null => {
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  };
  /** Σ size of every `<logId>/<rev>.json.gz` (files the sweep removes mid-walk count 0). */
  const allCacheBytes = (): number => {
    let total = 0;
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(cacheDir).filter((d) => /^\d+$/.test(d));
    } catch {
      return 0;
    }
    for (const d of dirs) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.join(cacheDir, d)).filter((n) => /^\d+\.json\.gz$/.test(n));
      } catch {
        continue;
      }
      for (const n of names) total += sizeOf(path.join(cacheDir, d, n)) ?? 0;
    }
    return total;
  };
  const backdate = (file: string, ms: number) => {
    const at = new Date(Date.now() - ms);
    fs.utimesSync(file, at, at);
  };
  /**
   * Re-uploads W1 (the step-14 call, DD-15) with `extra` lines after its original ones; each
   * extra line gets the last original line's timestamp.
   */
  const uploadW1 = async (extra: Array<Record<string, unknown>>) => {
    const upload = materializeGolden('gs-05', { runId: repo.runId }).uploads.find((u) => u.sessionId === w1);
    if (!upload) throw new Error('GS-05 has no W1 upload');
    const lines = upload.body.split('\n').filter((l) => l.trim() !== '');
    const { timestamp } = JSON.parse(lines[lines.length - 1]) as { timestamp?: string };
    const key = await createApiKey(owner.api);
    const res = await api.post('/api/v2/logs', {
      params: {
        sessionId: w1,
        type: 'claude-subagent',
        parentSessionId: upload.parentSessionId ?? sid5,
        ...(upload.workflowRunId ? { workflowRunId: upload.workflowRunId } : {}),
        ...(upload.agentDescription ? { agentDescription: upload.agentDescription } : {}),
        ...(upload.workflowPhase ? { workflowPhase: upload.workflowPhase } : {}),
      },
      headers: { 'Content-Type': 'text/plain', 'X-API-Key': key.key },
      data: [...lines, ...extra.map((e) => JSON.stringify({ ...e, timestamp }))].join('\n') + '\n',
    });
    expect(res.status(), 'upload W1').toBe(201);
    await waitForQueueIdle(db, owner.id, { timeoutMs: 30_000 });
  };
  /** Step 14's extra W1 line, kept in every later re-upload. */
  const fr4Marker = { type: 'system', subtype: 'informational', uuid: `${w1}-fr4`, content: 'FR-4 marker' };
  /**
   * Reads a part until `check` holds. Each read refills the file, so this also holds in mode C,
   * where the shared 1 MB cap may evict the file between two polls.
   */
  const readUntil = async (sessionId: string, logType: string, check: () => boolean, message: string) => {
    await expect
      .poll(async () => {
        await fetchPart(sessionId, logType);
        // The fill runs after the answer is sent.
        await new Promise((resolve) => setTimeout(resolve, 200));
        return check();
      }, { message, timeout: 15_000 })
      .toBe(true);
  };
  const tempFiles = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-'));
    } catch {
      return [];
    }
  };

  await test.step('16. a part read fills the cache: <logId>/<rev>.json.gz = body_gz, no temp file left; mode A: with body_gz overwritten in Postgres the reads still answer the original bytes (served from the file)', async () => {
    // Nothing in the browser may read parts behind the steps' backs from here on.
    await page.goto('about:blank');
    const row = await gzReadyRow(sid5, 'claude');
    const file = cacheFile(row.id, row.rev);
    const lines = await fetchPart(sid5, 'claude');
    await readUntil(sid5, 'claude', () => readCacheFile(file)?.equals(row.bodyGz) ?? false, 'cache file = body_gz');
    await expect.poll(() => tempFiles(path.dirname(file)), { message: 'no temp file left', timeout: 5_000 }).toEqual([]);

    if (mode !== 'a') return;
    // DD-16: the body guard fires only on UPDATE OF body, so body_gz can change under the same revision.
    await db.query('UPDATE logs SET body_gz = $1 WHERE id = $2', [zlib.gzipSync('[]'), row.id]);
    try {
      const gz = await owner.api.get(partUrl(sid5, 'claude'), { headers: { 'Accept-Encoding': 'gzip' } });
      expect(gz.status()).toBe(200);
      expect(gz.headers()['etag']).toBe(`"${row.rev}"`);
      expect(gz.headers()['content-encoding']).toBe('gzip');
      expect(gz.headers()['content-length'], 'the cached copy\'s length').toBe(String(row.bodyGz.length));
      expect((await gz.json()) as unknown[], 'gzip read: the original lines, not the overwritten []').toEqual(lines);
      const plain = await owner.api.get(partUrl(sid5, 'claude'), { headers: { 'Accept-Encoding': 'identity' } });
      expect(plain.status()).toBe(200);
      expect(plain.headers()['etag']).toBe(`"${row.rev}"`);
      expect(plain.headers()['content-encoding']).toBeUndefined();
      expect((await plain.json()) as unknown[], 'identity read: the original lines').toEqual(lines);
    } finally {
      await db.query('UPDATE logs SET body_gz = $1 WHERE id = $2', [row.bodyGz, row.id]);
    }
  });

  await test.step('17. an upload does not pre-warm the cache; the first read of the new revision writes its file (mode A: and removes the old revision\'s file)', async () => {
    // The current W1 revision (step 14's upload) cached first, so there is an old file to remove.
    const old = await gzReadyRow(w1, 'claude-subagent');
    const oldFile = cacheFile(old.id, old.rev);
    await readUntil(w1, 'claude-subagent', () => fs.existsSync(oldFile), 'old revision cached');

    await uploadW1([
      fr4Marker,
      { type: 'system', subtype: 'informational', uuid: `${w1}-cache17`, content: 'Part cache marker' },
    ]);
    const fresh = await gzReadyRow(w1, 'claude-subagent');
    expect(fresh.id, 'same row').toBe(old.id);
    expect(fresh.rev, 'a new revision').not.toBe(old.rev);
    const freshFile = cacheFile(fresh.id, fresh.rev);
    expect(fs.existsSync(freshFile), 'no pre-warm: no file before the first read').toBe(false);

    const lines = await fetchPart(w1, 'claude-subagent');
    expect(JSON.stringify(lines)).toContain('Part cache marker');
    await readUntil(w1, 'claude-subagent', () => fs.existsSync(freshFile), 'new revision cached');
    if (mode === 'a') {
      await expect
        .poll(() => fs.existsSync(oldFile), { message: 'the older revision\'s file is removed by the fill', timeout: 5_000 })
        .toBe(false);
    }
  });

  await test.step('18. a read of a file last read over an hour ago touches it; mode A: the sweep removes a file unread for 15 days and keeps one unread for 13', async () => {
    const claude = await gzReadyRow(sid5, 'claude');
    const claudeFile = cacheFile(claude.id, claude.rev);
    // Retried as a whole: in mode C the cap may evict the file at any second (DD-15).
    await expect(async () => {
      await readUntil(sid5, 'claude', () => fs.existsSync(claudeFile), 'GS-05 claude cached');
      backdate(claudeFile, 2 * 60 * 60 * 1000);
      expect(Date.now() - (mtimeOf(claudeFile) ?? Date.now()), 'backdated 2 h').toBeGreaterThan(60 * 60 * 1000);
      await fetchPart(sid5, 'claude');
      await expect
        .poll(() => Math.abs(Date.now() - (mtimeOf(claudeFile) ?? 0)) < 60_000, { message: 'the read touched the file', timeout: 5_000 })
        .toBe(true);
    }).toPass({ timeout: 30_000 });

    if (mode !== 'a') return;
    const cached = async (sessionId: string, logType: string) => {
      const row = await gzReadyRow(sessionId, logType);
      const file = cacheFile(row.id, row.rev);
      await readUntil(sessionId, logType, () => fs.existsSync(file), `${sessionId}/${logType} cached`);
      return file;
    };
    const w2File = await cached(w2, 'claude-subagent');
    const artisynFile = await cached(sid5, 'artisyn');
    backdate(w2File, 15 * 86_400_000);
    await expect.poll(() => fs.existsSync(w2File), { message: 'TTL 14 days: the sweep removes it', timeout: 10_000 }).toBe(false);
    backdate(artisynFile, 13 * 86_400_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(fs.existsSync(artisynFile), 'within the TTL: kept').toBe(true);
  });

  const CAP_BYTES = 1_048_576;
  /** The two cap dummies of step 19a: log ids no real row has. */
  const dummies = [
    { file: path.join(cacheDir, '9000000001', '1.json.gz'), ageMs: 3 * 86_400_000 },
    { file: path.join(cacheDir, '9000000002', '1.json.gz'), ageMs: 2 * 86_400_000 },
  ];

  await test.step('19a. mode C: two 600 KB files over the 1 MB cap — the sweep removes the least recently read first and brings the total down to the cap', async () => {
    if (mode !== 'c') return;
    try {
      for (const d of dummies) {
        fs.mkdirSync(path.dirname(d.file), { recursive: true });
        fs.writeFileSync(d.file, randomBytes(614_400));
        backdate(d.file, d.ageMs);
      }
      await expect
        .poll(() => !fs.existsSync(dummies[0].file) && allCacheBytes() <= CAP_BYTES, {
          message: 'the oldest dummy evicted and the total at or below the cap',
          timeout: 15_000,
        })
        .toBe(true);
    } finally {
      for (const d of dummies) fs.rmSync(path.dirname(d.file), { recursive: true, force: true });
    }
  });

  await test.step('19b. mode C: a part whose gzip copy is larger than the cap is served but never cached', async () => {
    if (mode !== 'c') return;
    // 1,179,648 random bytes → 1,572,864 base64 chars: the gzip cannot shrink below the 1 MB cap,
    // and the body stays under LOGS_MAX_BODY_MB=2 (DD-15).
    const blob = randomBytes(1_179_648).toString('base64');
    await uploadW1([
      fr4Marker,
      { type: 'system', subtype: 'informational', uuid: `${w1}-cache19`, content: blob },
    ]);
    const big = await gzReadyRow(w1, 'claude-subagent');
    expect(big.bodyGz.length, 'the gzip copy is over the cap').toBeGreaterThan(CAP_BYTES);
    const res = await owner.api.get(partUrl(w1, 'claude-subagent'));
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json()), 'a JSON array').toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(fs.existsSync(cacheFile(big.id, big.rev)), 'over the cap: never written').toBe(false);
  });

  /** A part URL of any root session of the golden repo. */
  const rootPartUrl = (rootId: string, sessionId: string, logType: string) =>
    `/api/v1/repositories/${repo.repoId}/sessions/${encodeURIComponent(rootId)}/logs/parts/${encodeURIComponent(sessionId)}/${logType}`;
  const readRootPart = async (rootId: string, sessionId: string, logType: string): Promise<unknown[]> => {
    const res = await owner.api.get(rootPartUrl(rootId, sessionId, logType));
    expect(res.status(), `part ${sessionId}/${logType}`).toBe(200);
    return (await res.json()) as unknown[];
  };
  /** Reads a root part until its cache file exists (refilled after any mode-C eviction). */
  const cachedRootPart = async (rootId: string, sessionId: string, logType: string) => {
    const row = await gzReadyRow(sessionId, logType);
    const file = cacheFile(row.id, row.rev);
    await expect
      .poll(async () => {
        await readRootPart(rootId, sessionId, logType);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return fs.existsSync(file);
      }, { message: `${sessionId}/${logType} cached`, timeout: 15_000 })
      .toBe(true);
    return row;
  };

  await test.step('20. fail-open: with a plain file where the <logId> folder belongs, the part is still served from Postgres and nothing is written', async () => {
    const sid1 = repo.rootId('gs-01');
    const row = await gzReadyRow(sid1, 'claude');
    const lines = await readRootPart(sid1, sid1, 'claude');
    const logDir = path.join(cacheDir, String(row.id));
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.writeFileSync(logDir, 'blocks the cache folder');
    try {
      expect(await readRootPart(sid1, sid1, 'claude'), 'same lines with the cache folder blocked').toEqual(lines);
      // The fill runs after the answer is sent.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(fs.statSync(logDir).isFile(), 'the blocking file is untouched').toBe(true);
    } finally {
      fs.rmSync(logDir, { force: true });
    }
  });

  await test.step('21a. deleting a session removes its parts\' cache folders', async () => {
    const claude = await cachedRootPart(sid7, sid7, 'claude');
    const artisyn = await cachedRootPart(sid7, sid7, 'artisyn');
    expect((await owner.api.delete(`/api/v1/sessions/${encodeURIComponent(sid7)}`)).status(), 'DELETE session').toBe(204);
    for (const row of [claude, artisyn]) {
      await expect
        .poll(() => fs.existsSync(path.join(cacheDir, String(row.id))), { message: `folder of log ${row.id} removed`, timeout: 10_000 })
        .toBe(false);
    }
  });

  // Deletes the whole golden repo: must stay the last step (DD-15).
  await test.step('21b. an admin repository delete removes every GS-05 cache folder', async () => {
    await cachedRootPart(sid5, sid5, 'claude');
    const { rows } = await db.query<{ id: string }>(
      `SELECT l.id::text AS id FROM logs l JOIN sessions s ON s.id = l.session_id WHERE s.session_id = ANY($1::text[])`,
      [[sid5, w1, w2]],
    );
    expect(rows.length, 'GS-05 log rows').toBeGreaterThan(0);
    const admin = await users.user('admin', { label: 'ss03-admin' });
    expect((await admin.api.delete(`/api/v1/admin/repos/${repo.repoId}`)).status(), 'DELETE admin repo').toBe(204);
    for (const { id } of rows) {
      await expect
        .poll(() => fs.existsSync(path.join(cacheDir, id)), { message: `folder of log ${id} removed`, timeout: 10_000 })
        .toBe(false);
    }
  });
});
