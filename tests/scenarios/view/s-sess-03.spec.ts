// S-SESS-03. Logs: what counts as a prompt, what is hidden, how a turn reads
// (docs/qaa-overview/scenarios/03-session-view-reports-golden.md §S-SESS-03; no mode in the design
// → A and C, DD SC4).
//
// Data: GS-07 (main: three prompts with failures, a denial, an unresolved call, plus distractors —
// a sidechain pair of 50 000 / 10 000 tokens, an isMeta line, a late <task-notification> and an
// answer split over two lines with one `message.id`) and GS-01 (files). Uploaded through
// POST /api/v2/logs (DD SC3); the numbers come from their expected.json (DD D3).
//
// Code facts that differ from the design text:
//   - the prompt text of a turn is shown in its header, not collapsed behind a click; the scenario
//     reads it as shown.
//   - the per-turn costs of GS-07 are not literals of expected.json (only the session total is): the
//     scenario checks that the three turn costs add up to it and that each tooltip's rows add up to
//     its turn.
//   - a denied call is rendered «✗ error» in the tool modal (the result text is the denial), the same
//     as a failure; the outcome split (failure vs unresolved) is the Statistics tab's job (S-SESS-08).
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
import { test, expect } from '../fixtures';
import { loadExpected } from '../helpers/golden';
import { hms, int, logTurns, num, openSession, turnMetric, uploadGoldenRepo } from '../helpers/session-view';

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

  await test.step('6. turn 2 Tools → Bash row opens a modal with INPUT (the command) and RESULT (the denial), with copy', async () => {
    const turn = logTurns(page).nth(1);
    await turn.getByRole('button', { name: /Tools/ }).click();
    await turn.locator('tr', { hasText: 'Bash' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Bash');
    await expect(dialog).toContainText('Input');
    await expect(dialog).toContainText('"command": "rm -rf build"');
    await expect(dialog).toContainText('Result');
    await expect(dialog).toContainText("The user doesn't want to proceed with this tool use");
    await expect(dialog.getByRole('button', { name: 'copy' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
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

  await test.step('9. GS-01 (no harness snapshot): no Skills, Agents or MCP tab, and no page error', async () => {
    await openSession(page, owner, repo.repoId, repo.rootId('gs-01'), { tab: 'logs' });
    await expect(page.getByTestId('sysctx-tab-skills')).toHaveCount(0);
    await expect(page.getByTestId('sysctx-tab-agents')).toHaveCount(0);
    await expect(page.getByTestId('sysctx-tab-mcp')).toHaveCount(0);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
