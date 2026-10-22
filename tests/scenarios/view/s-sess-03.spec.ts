// S-SESS-03. Logs: what counts as a prompt, what is hidden, how a turn reads
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-SESS-03; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-07 (main: three prompts with failures, a denial, an unresolved call, plus distractors —
// a sidechain pair of 50 000 / 10 000 tokens, an isMeta line, a late <task-notification> and an
// answer split over two lines with one `message.id`), GS-01 (files) and GS-05 (System Context, and
// the ResearchWorkflow run with its two workflow agents W1/W2 for the Agents table). Uploaded through
// POST /api/v2/logs (DD SC3); the numbers come from their expected.json (DD D3). Step 6a uploads
// its own small session (a background agent, a <task-notification> and the main thread finishing
// after it): the turn's work time runs from the prompt to the last answer.
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
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { loadExpected } from '../helpers/golden';
import { ownRepoId, promptSessionBodies, type PromptSession } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { hms, infoValue, int, logTurns, num, openSession, turnMetric, uploadGoldenRepo, usd4 } from '../helpers/session-view';

const HIDDEN_TEXTS = [
  'Side task: summarise the build log', // sidechain user line
  'Build log summary.', // sidechain answer
  'The user opened src/ok.ts.', // isMeta line
  'Background build finished', // <task-notification>
];
const PROMPTS = ['Run the test suite', 'Clean the build folder and check the sources', 'Print ok'];

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
}) => {
  test.setTimeout(120_000);
  const G7 = loadExpected('gs-07').roots[0];
  const G1 = loadExpected('gs-01').roots[0];
  const owner = await users.user('user', { label: 'ss03-owner' });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const repo = await test.step('1. upload GS-07, GS-01 and GS-05', async () =>
    uploadGoldenRepo(api, db, owner, ['gs-07', 'gs-01', 'gs-05']));
  const sid7 = repo.rootId('gs-07');

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

  await test.step('8. GS-05 System Context: Skills is snapshot ∩ skill_listing (unused-skill hidden); plugin badge and tokens shown; modal has a Plugin row and no Modified row', async () => {
    await openSession(page, owner, repo.repoId, repo.rootId('gs-05'), { tab: 'logs' });
    const panel = page.getByTestId('sysctx-panel');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /show details/i }).click();
    await panel.getByTestId('sysctx-tab-skills').click();
    const rows = panel.getByTestId('sysctx-skill-row');
    await expect(rows, 'only the registered skills, unused-skill hidden').toHaveCount(2);
    await expect(rows.filter({ hasText: 'unused-skill' })).toHaveCount(0);
    const reviewDeepRow = panel.locator('[data-skill-name="adlc:review-deep"]');
    await expect(reviewDeepRow).toBeVisible();
    await expect(reviewDeepRow, 'plugin badge').toContainText('plugin');
    await expect(reviewDeepRow, 'token estimate').toContainText('tok');
    await reviewDeepRow.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('skill-detail-plugin')).toBeVisible();
    await expect(dialog).toContainText('adlc@artisyn');
    await expect(dialog, 'no Modified row').not.toContainText('Modified');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  await test.step('8a. GS-05 System Context Files/Rules: instructions attachment merged with the snapshot (user / project / local, no duplicate CLAUDE.md), rules with sizes, no file text and no absolute path', async () => {
    const panel = page.getByTestId('sysctx-panel');
    await panel.getByTestId('sysctx-tab-files').click();
    const files = panel.getByTestId('sysctx-file-row');
    await expect(files, 'snapshot CLAUDE.md and the log one are one row').toHaveCount(3);
    const fileRow = (type: string) => files.and(panel.locator(`[data-file-type="${type}"]`));
    await expect(fileRow('user')).toContainText('~/.claude/CLAUDE.md');
    await expect(fileRow('user')).toContainText('1.0 KB');
    await expect(fileRow('project')).toContainText('CLAUDE.md');
    await expect(fileRow('project')).toContainText('3.4 KB');
    await expect(fileRow('local')).toContainText('CLAUDE.local.md');
    await expect(fileRow('local')).toContainText('700 B');
    await expect(files.filter({ hasText: /\/home\/|\/work\// }), 'no absolute path').toHaveCount(0);

    await panel.getByTestId('sysctx-tab-rules').click();
    const rules = panel.getByTestId('sysctx-rule-row');
    await expect(rules).toHaveCount(2);
    await expect(rules.filter({ hasText: 'db' })).toContainText('700 B');
    await expect(rules.filter({ hasText: 'ui' })).toContainText('1.4 KB');
    await rules.filter({ hasText: 'db' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Body' }), 'no rule text tab').toHaveCount(0);
    await expect(dialog).not.toContainText('Use parameterised queries only');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    for (const text of ['GS05-LOCAL-MARKER', 'GS05-USER-MARKER', 'Use parameterised queries only'])
      await expect(panel, `no file text: ${text}`).not.toContainText(text);
  });

  await test.step('8b. GS-05 workflow Agents table: shown as soon as the workflow opens; one row per agent with label, duration, tokens and cost; numbers 1/2 and 12-char ids; a row opens a modal with the agent Logs and Raw logs tabs; no extra request', async () => {
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
    const expectedRows = [
      { key: 'w1', label: 'Add a billing section to src/report.ts', duration: '0:00:18' },
      { key: 'w2', label: 'Review the billing flow in depth', duration: '0:00:23' },
    ];
    for (const { key, label, duration } of expectedRows) {
      const row = page.locator(`[data-testid="workflow-agent-row"][data-agent-id$="gs05${key}"]`);
      await expect(row, `${key} row`).toHaveCount(1);
      const cells = row.locator(':scope > td');
      const n = node(key);
      await expect(cells.nth(1), `${key} label`).toContainText(label);
      await expect(cells.nth(2), `${key} duration`).toHaveText(duration);
      const t = n.tokens;
      const tokens = t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
      await expect(cells.nth(3), `${key} tokens`).toHaveText(`${(tokens / 1000).toFixed(1)}K`);
      await expect(cells.nth(4), `${key} cost`).toHaveText(usd4(n.costUsd));
      const agentId = (await row.getAttribute('data-agent-id'))!;
      await expect(cells.nth(1), `${key} id line`).toContainText(`${agentId.slice(0, 12)}…`);
    }
    const numbers = await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('td')?.textContent?.trim()));
    expect(new Set(numbers), 'the # cells (both agents start together: order is AO-02, not checked here)').toEqual(new Set(['1', '2']));

    const w1 = page.locator('[data-testid="workflow-agent-row"][data-agent-id$="gs05w1"]');
    await w1.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(expectedRows[0].label);
    // "Logs" tab (default): the agent's own turn, rendered like the session's Logs tab.
    const agentLogs = dialog.getByTestId('workflow-agent-logs');
    await expect(agentLogs).toContainText(expectedRows[0].label);
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
    expect(apiRequests, 'the table and the agent modal reuse the loaded Logs payload').toEqual([]);
  });

  await test.step('9. GS-01 (no harness snapshot): no Skills, Agents or MCP tab, and no page error', async () => {
    await openSession(page, owner, repo.repoId, repo.rootId('gs-01'), { tab: 'logs' });
    await expect(page.getByTestId('sysctx-tab-skills')).toHaveCount(0);
    await expect(page.getByTestId('sysctx-tab-agents')).toHaveCount(0);
    await expect(page.getByTestId('sysctx-tab-mcp')).toHaveCount(0);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
