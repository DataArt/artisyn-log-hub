// S-SESS-14. Tool calls in detail: the Context Growth step modal, the Bash view, call statuses
// (docs/tasks/todo/2026-10-22-context-growth-item-modal; no mode in the design → A and C, DD SC4).
//
// Data: one own session uploaded through POST /api/v2/logs (DD SC3), built here (impl-plan
// "S-SESS-14 fixture"): one prompt, `cwd: /work/ss14-<runId>` on every line, five assistant steps
// whose context (cache_read_input_tokens) is 10 000 / 30 000 / 31 000 / 31 500 / 32 000:
//   a1  Bash `cd <root> && npm test 2>&1 | tail -5; rm -rf <root>/dist` (70 000 chars of output)
//       and Agent A (Explore, with its sub-agent transcript);
//   a2  Read, Grep, a failing Edit of src/app.ts and Agent B (code-reviewer, with its transcript);
//   a3  Bash `npm run build` (interrupted), PowerShell `Get-ChildItem` and an unparseable Bash
//       `for x in; do`, each result 1.5 s after its tool_use; the artisyn log carries one
//       PermissionRequest with the third call's exact input, 300 ms after it;
//   a4  an Agent call ("lint") rejected with "Concurrent subagent limit reached", plus text;
//   a5  text only, end_turn.
// Sub-agents A and B each run one Bash call. A second, minimal session has no Bash call at all.
// Steps: the chart and its step modal, then Logs (Files / Agents statuses), then the Bash tab
// (5 rows of the whole session tree, the `bashCall` URL param, the empty state).
//
// Code facts that differ from the design text:
//   - a step row's label is the signed delta to the NEXT step (step-bars.ts, DD-8), so a3 and a4
//     read `+1k` for a 500-token growth (Math.round(0.5) = 1) and the last step reads `—`.
//   - the tree-sitter WASM is fetched by the browser only when the first Bash view renders; the
//     request URL carries the hashed asset name (`tree-sitter-bash-<hash>.wasm`).
//   - "show all (N chars)" prints N with the browser's locale grouping, so the scenario accepts a
//     comma, a dot or a (narrow) no-break space as the thousands separator.
//
// Replaces: nothing — Context Growth had no scenario (S-CHART-02 has no spec) and the Bash view
// and Bash tab are new.
import { randomBytes } from 'node:crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, promptSessionBodies, uploadPromptSession, type PromptSession } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { logTurns, openSession } from '../helpers/session-view';

const MODEL = 'claude-sonnet-4-6';
const BASH_OUTPUT_CHARS = 70_000;
const INTERRUPTED = '[Request interrupted by user for tool use]';

/** `n` chars of plain test-runner output (no path in it, so its displayed length stays `n`). */
function output(n: number, prefix = 'PASS'): string {
  const line = `${prefix} test case ok\n`;
  return line.repeat(Math.ceil(n / line.length)).slice(0, n);
}

function toNdjson(rows: object[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

test('@S-SESS-14 Tool calls in detail: Context Growth step modal, Bash view, call statuses @mode-a @mode-c', async ({
  api,
  db,
  users,
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await users.user('user', { label: 'ss14-owner' });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const runId = randomBytes(4).toString('hex');
  const root = `/work/ss14-${runId}`;
  const repoUrl = `https://git.arrakis.test/scn/${runId}/ss14`;
  const main: PromptSession = { sessionId: `ss14-${runId}`, prompt: `ss14 build and review ${runId}`, repoUrl };
  const empty: PromptSession = { sessionId: `ss14-empty-${runId}`, prompt: `ss14 no bash ${runId}`, repoUrl };
  const agentA = `ss14a-${runId}`;
  const agentB = `ss14b-${runId}`;
  const unparseable = { command: 'for x in; do' };

  const { repoId } = await test.step('setup: upload the S-SESS-14 session, its two sub-agents, the PermissionRequest line and an empty session', async () => {
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const t = (ms: number) => new Date(at.getTime() + ms).toISOString();
    const sid = main.sessionId;
    const id = (n: string) => `${sid}-${n}`;
    const base = { sessionId: sid, cwd: root, isSidechain: false, gitBranch: 'main', version: '2.1.99' };
    const assistant = (uuid: string, parent: string, ms: number, ctx: number, content: unknown[], stop: string) => ({
      ...base, type: 'assistant', uuid: id(uuid), parentUuid: id(parent), timestamp: t(ms),
      message: {
        id: `msg-${id(uuid)}`, role: 'assistant', model: MODEL, content, stop_reason: stop,
        usage: { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 },
      },
    });
    const result = (
      uuid: string, parent: string, ms: number, toolUseId: string, content: string,
      extra: { isError?: boolean; toolUseResult?: object; toolDenialKind?: string } = {},
    ) => ({
      ...base, type: 'user', uuid: id(uuid), parentUuid: id(parent), timestamp: t(ms),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(extra.isError ? { is_error: true } : {}) }] },
      ...(extra.toolUseResult ? { toolUseResult: extra.toolUseResult } : {}),
      ...(extra.toolDenialKind ? { toolDenialKind: extra.toolDenialKind } : {}),
    });
    const agentDone = (agentId: string, agentType: string, prompt: string, text: string) => ({
      status: 'completed', prompt, agentId, agentType, content: [{ type: 'text', text }],
      totalDurationMs: 3000, totalTokens: 600, totalToolUseCount: 1,
    });

    const claude = [
      { ...base, type: 'user', uuid: id('u1'), timestamp: t(0), message: { role: 'user', content: [{ type: 'text', text: main.prompt }] } },
      // a1 — ctx 10 000: Bash (70 000 chars of output) + Agent A.
      assistant('a1', 'u1', 5_000, 10_000, [
        { type: 'tool_use', id: id('b1'), name: 'Bash', input: { command: `cd ${root} && npm test 2>&1 | tail -5; rm -rf ${root}/dist`, description: 'Run the tests and drop dist' } },
        { type: 'tool_use', id: id('agA'), name: 'Agent', input: { description: 'explore', prompt: 'Explore the sources', subagent_type: 'Explore' } },
      ], 'tool_use'),
      result('r1', 'a1', 6_000, id('b1'), output(BASH_OUTPUT_CHARS)),
      result('r2', 'r1', 10_000, id('agA'), 'Explored.', { toolUseResult: agentDone(agentA, 'Explore', 'Explore the sources', 'Explored.') }),
      // a2 — ctx 30 000: Read, Grep, failing Edit, Agent B.
      assistant('a2', 'r2', 12_000, 30_000, [
        { type: 'tool_use', id: id('rd'), name: 'Read', input: { file_path: `${root}/src/app.ts` } },
        { type: 'tool_use', id: id('gr'), name: 'Grep', input: { pattern: 'export', path: `${root}/src` } },
        { type: 'tool_use', id: id('ed'), name: 'Edit', input: { file_path: `${root}/src/app.ts`, old_string: 'const y = 2;', new_string: 'const y = 3;' } },
        { type: 'tool_use', id: id('agB'), name: 'Agent', input: { description: 'review', prompt: 'Review src/app.ts', subagent_type: 'code-reviewer' } },
      ], 'tool_use'),
      result('r3', 'a2', 13_000, id('rd'), '1\texport const x = 1;\n'),
      result('r4', 'r3', 13_100, id('gr'), 'src/app.ts'),
      result('r5', 'r4', 13_200, id('ed'), '<tool_use_error>String to replace not found in file.\nString: const y = 2;</tool_use_error>', { isError: true }),
      result('r6', 'r5', 17_000, id('agB'), 'Reviewed.', { toolUseResult: agentDone(agentB, 'code-reviewer', 'Review src/app.ts', 'Reviewed.') }),
      // a3 — ctx 31 000: interrupted Bash, PowerShell, unparseable Bash (results 1.5 s later).
      assistant('a3', 'r6', 20_000, 31_000, [
        { type: 'tool_use', id: id('b2'), name: 'Bash', input: { command: 'npm run build' } },
        { type: 'tool_use', id: id('ps'), name: 'PowerShell', input: { command: 'Get-ChildItem' } },
        { type: 'tool_use', id: id('b3'), name: 'Bash', input: unparseable },
      ], 'tool_use'),
      result('r7', 'a3', 21_500, id('b2'), `${output(2_000 - INTERRUPTED.length, 'build')}${INTERRUPTED}`, {
        isError: true, toolUseResult: { interrupted: true }, toolDenialKind: 'interrupted',
      }),
      result('r8', 'r7', 21_500, id('ps'), output(100, 'dir')),
      result('r9', 'r8', 21_500, id('b3'), output(50, 'syntax')),
      // a4 — ctx 31 500: an Agent call refused before it started (no activation, no transcript).
      assistant('a4', 'r9', 25_000, 31_500, [
        { type: 'text', text: 'Starting the linter in a sub-agent.' },
        { type: 'tool_use', id: id('agL'), name: 'Agent', input: { description: 'lint', prompt: 'Run lint', subagent_type: 'general-purpose' } },
      ], 'tool_use'),
      result('r10', 'a4', 26_000, id('agL'), 'Concurrent subagent limit reached', { isError: true }),
      // a5 — ctx 32 000: the answer.
      assistant('a5', 'r10', 30_000, 32_000, [{ type: 'text', text: 'Build interrupted; tests pass.' }], 'end_turn'),
    ];

    const permissionRequest = {
      type: 'artisyn', hook_event_name: 'PermissionRequest', timestamp: t(20_300), session_id: sid,
      tool_name: 'Bash', tool_input: unparseable,
    };
    const artisyn = promptSessionBodies({ ...main, at }).artisyn + toNdjson([permissionRequest]);

    const subagent = (agentId: string, startMs: number, prompt: string, command: string) => {
      const sub = { sessionId: sid, agentId, cwd: root, isSidechain: true, gitBranch: 'main', version: '2.1.99' };
      const u = (n: string) => `${agentId}-${n}`;
      return toNdjson([
        { ...sub, type: 'user', uuid: u('u1'), timestamp: t(startMs), message: { role: 'user', content: prompt } },
        { ...sub, type: 'assistant', uuid: u('a1'), parentUuid: u('u1'), timestamp: t(startMs + 500),
          message: { id: `msg-${u('a1')}`, role: 'assistant', model: MODEL, stop_reason: 'tool_use',
            usage: { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            content: [{ type: 'tool_use', id: u('bash'), name: 'Bash', input: { command } }] } },
        { ...sub, type: 'user', uuid: u('r1'), parentUuid: u('a1'), timestamp: t(startMs + 1_000),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: u('bash'), content: 'ok' }] } },
        { ...sub, type: 'assistant', uuid: u('a2'), parentUuid: u('r1'), timestamp: t(startMs + 1_500),
          message: { id: `msg-${u('a2')}`, role: 'assistant', model: MODEL, stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 150, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
            content: [{ type: 'text', text: 'Agent done.' }] } },
      ]);
    };

    const key = await createApiKey(owner.api);
    const post = async (sessionId: string, type: string, data: string, parentSessionId?: string) => {
      const res = await api.post('/api/v2/logs', {
        params: { sessionId, type, ...(parentSessionId ? { parentSessionId } : {}) },
        headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': key.key },
        data,
      });
      expect(res.status(), `upload ${type} of ${sessionId}`).toBe(201);
    };
    await post(sid, 'artisyn', artisyn);
    await post(sid, 'claude', toNdjson(claude));
    await post(`agent-${agentA}`, 'claude-subagent', subagent(agentA, 7_000, 'Explore the sources', 'ls src'), sid);
    await post(`agent-${agentB}`, 'claude-subagent', subagent(agentB, 14_000, 'Review src/app.ts', 'git diff --stat'), sid);
    await waitForQueueIdle(db, owner.id);
    await uploadPromptSession(api, key.key, { ...empty, at }, { db, userId: owner.id });
    return { repoId: await ownRepoId(owner.api, repoUrl) };
  });

  const wasmRequests: string[] = [];
  page.on('request', (req) => {
    if (/\.wasm(\?|$)/.test(req.url())) wasmRequests.push(req.url());
  });
  const modal = page.getByTestId('step-details-modal');
  const stepRows = page.getByTestId('growth-step-row');

  await test.step('chart: Charts → Context Growth, the turn expands into five step rows +20k / +1k / +1k / +1k / — with a pointer cursor, and no WASM is fetched yet (AC-1, AC-2a)', async () => {
    await openSession(page, owner, repoId, main.sessionId, { tab: 'charts' });
    await page.getByTestId('tab-chart-context-growth').click();
    const turnRow = page.getByTestId('growth-row');
    await expect(turnRow).toHaveCount(1);
    await turnRow.getByTitle('Expand steps').click();
    await expect(stepRows).toHaveCount(5);
    await expect(page.getByTestId('growth-step-delta')).toHaveText(['+20k', '+1k', '+1k', '+1k', '—']);
    await expect(stepRows.first()).toHaveCSS('cursor', 'pointer');
    expect(wasmRequests, 'the Bash parser loads only with the first Bash view').toEqual([]);
  });

  await test.step('step modal: the +20k row opens the step modal with the Bash command, "show all (70,000 chars)", highlighted tokens, and the tree-sitter-bash WASM is fetched now (AC-2, AC-9, AC-13)', async () => {
    await stepRows.first().click();
    await expect(modal).toBeVisible();
    const view = modal.getByTestId('bash-command-view');
    await expect(view).toHaveCount(1);
    // Once the parser is ready the formatted script replaces the raw text.
    const script = view.getByTestId('bash-highlighted-script');
    await expect(script).toContainText('npm test');
    await expect(script).toContainText('rm -rf dist');
    await expect(view.getByTestId('tool-output-block').getByRole('button', { name: /show all \(70[,.  ]?000 chars\)/ })).toBeVisible();
    await expect(script.locator('pre span.text-purple-700').first(), 'a keyword / operator token').toBeVisible();
    expect(wasmRequests.some((url) => /tree-sitter-bash[^/]*\.wasm/.test(url)), wasmRequests.join('\n')).toBe(true);
  });

  await test.step('paths and close: no absolute repo path anywhere in the modal, Changes lists dist; Escape keeps the turn expanded and the scroll position (AC-7, AC-8)', async () => {
    await expect(modal.getByTestId('bash-files-changes')).toContainText('dist');
    await expect(modal).not.toContainText('/work/ss14-');
    const scrollTop = () =>
      page.getByTestId('growth-row').evaluate((el) => {
        for (let n = el.parentElement; n; n = n.parentElement) {
          const overflow = getComputedStyle(n).overflowY;
          if ((overflow === 'auto' || overflow === 'scroll') && n.scrollHeight > n.clientHeight) return n.scrollTop;
        }
        return document.scrollingElement?.scrollTop ?? 0;
      });
    const before = await scrollTop();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(stepRows, 'the turn is still expanded').toHaveCount(5);
    expect(await scrollTop()).toBe(before);
  });

  await test.step('multi-call: the a3 row shows three calls (Bash, PowerShell, Bash), the first expanded with ⏸ interrupted and ⏱; PowerShell and the unparseable command are raw text with no toggle; ⚠ requested only on the third (AC-3, AC-6, AC-12, AC-15)', async () => {
    await stepRows.nth(2).click();
    await expect(modal).toBeVisible();
    const blocks = modal.getByTestId('step-call-block');
    await expect(blocks).toHaveCount(3);
    const toggle = (i: number) => blocks.nth(i).getByTestId('tool-call-view').locator(':scope > button[aria-expanded]');
    await expect(toggle(0)).toContainText('Bash');
    await expect(toggle(1)).toContainText('PowerShell');
    await expect(toggle(2)).toContainText('Bash');
    await expect(toggle(0)).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle(1)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(2)).toHaveAttribute('aria-expanded', 'false');

    await expect(toggle(0).getByTestId('tool-status-badge')).toContainText('⏸ interrupted');
    await expect(toggle(0)).toContainText('⏱');
    // The first block's parser-ready toggle shows the parser has loaded, so the next two are
    // in their final (fallback) state, not merely still loading.
    await expect(blocks.nth(0).getByRole('button', { name: 'formatted' })).toBeVisible();

    for (const [i, text] of [[1, 'Get-ChildItem'], [2, unparseable.command]] as const) {
      await toggle(i).click();
      const raw = blocks.nth(i).getByTestId('bash-raw-command');
      await expect(raw).toHaveText(text);
      await expect(raw, 'fallback: wrapped raw text').toHaveClass(/whitespace-pre-wrap/);
      await expect(blocks.nth(i).locator('button[aria-pressed]'), 'no Formatted | Raw toggle').toHaveCount(0);
      await expect(blocks.nth(i).getByTestId('bash-highlighted-script')).toHaveCount(0);
    }

    await expect(toggle(2).getByTestId('tool-status-badge')).toContainText('⚠ requested');
    await expect(toggle(0)).not.toContainText('⚠ requested');
    await expect(toggle(1)).not.toContainText('⚠ requested');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  await test.step('logs statuses: Files shows the failed src/app.ts Edit with ✗ and opens it with its error; Agents lists the refused "lint" call with ✗; a Tools row leads with the description (AC-14, AC-16)', async () => {
    await openSession(page, owner, repoId, main.sessionId, { tab: 'logs' });
    const turn = logTurns(page);
    await expect(turn).toHaveCount(1);
    const code = turn.locator('div.border-l-2', { has: page.getByRole('button', { name: /Code\b/ }) }).last();
    await code.getByRole('button', { name: /Code\b/ }).click();
    const edit = code.locator(`[data-testid="file-row"][data-tool-use-id="${main.sessionId}-ed"]`);
    await expect(edit).toHaveCount(1);
    await expect(edit).toContainText('src/app.ts');
    await expect(edit.getByTestId('tool-status-mark')).toHaveText('✗');
    const read = code.locator(`[data-testid="file-row"][data-tool-use-id="${main.sessionId}-rd"]`);
    await expect(read.getByTestId('tool-status-mark'), 'the Read of the same file succeeded').toHaveCount(0);

    await edit.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('String to replace not found');
    await expect(dialog.getByTestId('tool-status-badge').first()).toContainText('✗ error');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    const orphan = turn.getByTestId('orphan-agent-call-row');
    await expect(orphan, 'only "lint" has no activation and no sub-agent node').toHaveCount(1);
    await expect(orphan).toHaveAttribute('data-call-id', `${main.sessionId}-agL`);
    await expect(orphan).toContainText('lint');
    await expect(orphan.getByTestId('tool-status-badge')).toContainText('✗ error');

    // A Tools row leads with the call's own description; the rest of the input is the tail.
    const tools = turn.locator('div.border-l-2', { has: page.getByRole('button', { name: /Tools\b/ }) }).last();
    await tools.getByRole('button', { name: /Tools\b/ }).click();
    const b1Preview = tools.getByTestId('tool-call-row-preview').filter({ hasText: 'Run the tests and drop dist' });
    await expect(b1Preview).toHaveCount(1);
    await expect(b1Preview.locator('span').first()).toHaveText('Run the tests and drop dist');
    await expect(b1Preview).toContainText('command=');
    await expect(b1Preview, 'the description is not repeated in the tail').not.toContainText('description=');
  });

  const bashRows = page.getByTestId('bash-call-row');
  const bashIds = [
    `${main.sessionId}-b1`,
    `${agentA}-bash`,
    `${agentB}-bash`,
    `${main.sessionId}-b2`,
    `${main.sessionId}-b3`,
  ];
  const bashCallParam = () => new URLSearchParams(new URL(page.url()).hash.split('?')[1] ?? '').get('bashCall');
  const selectedRow = () => page.locator('[data-testid="bash-call-row"][aria-selected="true"]');

  await test.step('bash tab list: five Bash commands of the whole tree in time order, the two sub-agent rows badged Agent · <type> (AC-10, AC-10a)', async () => {
    await openSession(page, owner, repoId, main.sessionId, { tab: 'bash' });
    await expect(page.getByTestId('session-bash-tab')).toBeVisible();
    await expect(page.getByTestId('session-bash-count')).toHaveText('5');
    await expect(bashRows).toHaveCount(5);
    for (const [i, callId] of bashIds.entries()) await expect(bashRows.nth(i)).toHaveAttribute('data-call-id', callId);
    for (const [i, n] of [1, 2, 3, 4, 5].entries()) await expect(bashRows.nth(i)).toContainText(`#${n}`);
    await expect(bashRows.nth(1).getByTestId('bash-call-agent-badge')).toHaveText('Agent · Explore');
    await expect(bashRows.nth(2).getByTestId('bash-call-agent-badge')).toHaveText('Agent · code-reviewer');
    for (const i of [0, 3, 4]) await expect(bashRows.nth(i).getByTestId('bash-call-agent-badge')).toHaveCount(0);
    // No bashCall in the URL → row 1 is shown.
    await expect(selectedRow()).toHaveAttribute('data-call-id', bashIds[0]);
    await expect(page.getByTestId('bash-call-details').getByTestId('tool-call-view')).toBeVisible();
  });

  await test.step('bash tab URL: ↓ moves the selection into bashCall; a reload keeps it; an unknown bashCall shows row 1; a session without Bash shows the empty state (AC-11)', async () => {
    expect(bashCallParam()).toBeNull();
    await page.getByTestId('bash-call-list').focus();
    await page.keyboard.press('ArrowDown');
    await expect(selectedRow()).toHaveAttribute('data-call-id', bashIds[1]);
    await expect.poll(bashCallParam).toBe(bashIds[1]);
    await expect(page.getByTestId('bash-details-agent-badge')).toHaveText('Agent · Explore');

    await page.reload();
    await expect(bashRows).toHaveCount(5);
    await expect(selectedRow()).toHaveAttribute('data-call-id', bashIds[1]);

    const url = new URL(page.url());
    const [route, query] = url.hash.split('?');
    const params = new URLSearchParams(query);
    params.set('bashCall', 'no-such-call');
    await page.goto(`${url.origin}${url.pathname}${route}?${params.toString()}`);
    await expect(bashRows).toHaveCount(5);
    await expect(selectedRow()).toHaveAttribute('data-call-id', bashIds[0]);
    expect(bashCallParam(), 'an unknown id is not rewritten').toBe('no-such-call');

    await openSession(page, owner, repoId, empty.sessionId, { tab: 'bash' });
    await expect(page.getByTestId('session-bash-tab')).toHaveText('No Bash commands in this session');
    await expect(bashRows).toHaveCount(0);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
