/**
 * Playwright coverage for "Harness Elements Usage Report":
 *   - the Reports tab lists the report under Harness and renders the KPI tiles + table
 *     with real self-reported inventory merged with real transcript usage;
 *   - changing the date range changes the usage counts (inventory itself is not date-scoped,
 *     only the usage facts are);
 *   - kind filter chips isolate a kind;
 *   - sorting by a token column surfaces the highest-token row;
 *   - "Download as PDF" succeeds;
 *   - a grouped (by user) view renders one table per group, zero-usage rows included.
 */
import {
  test,
  expect,
  request as pwRequest,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import { BASE_URL, ROLES, storageStatePath } from './helpers/credentials';
import { seedRepoWithSessions, type SeededRepo } from './helpers/seed';
import { workerIndex } from './helpers/repo-url';
import * as crypto from 'crypto';

test.use({ storageState: storageStatePath('primary') });

let seeded: SeededRepo;
let ownerCtx: APIRequestContext;
let repoId: number;
const ownerEmail = ROLES.primary.email;

const SESSION_ID = `harness-usage-e2e-w${workerIndex()}-${crypto.randomUUID().slice(0, 8)}`;

/** Read tool: modest usage. mcp__playwright__browser_click: the highest-token call, so
 * sorting by "Input tokens" (Tool filter) visibly reorders away from the default uses-sort. */
const READ_INPUT_TOKENS = 20;
const READ_OUTPUT_TOKENS = 10;
const CLICK_INPUT_TOKENS = 200;
const CLICK_OUTPUT_TOKENS = 50;

// Real trigger events — `skill-alpha` is genuinely invoked via the Skill
// tool; `skill-beta`, though self-reported below as a registered skill, never is, and must
// show zero usage. The `demo` rule is injected via a real `nested_memory` attachment.
const SKILL_CONTENT_TEXT = 'skill-alpha body content for e2e';
const RULE_CONTENT_TEXT = 'demo rule body content for e2e';

function harnessClaudeTranscript(): Record<string, unknown>[] {
  const turn = (
    idx: number,
    toolName: string,
    inputTokens: number,
    outputTokens: number,
    toolInput: Record<string, unknown> = {},
  ): Record<string, unknown>[] => {
    const userUuid = `${SESSION_ID}-u${idx}`;
    const assistantUuid = `${SESSION_ID}-a${idx}`;
    return [
      {
        type: 'user',
        uuid: userUuid,
        parentUuid: null,
        promptId: `p${idx}`,
        isMeta: false,
        isSidechain: false,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant',
        uuid: assistantUuid,
        parentUuid: userUuid,
        isSidechain: false,
        timestamp: new Date().toISOString(),
        message: {
          id: `${SESSION_ID}-m${idx}`,
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          content: [
            {
              type: 'tool_use',
              id: `${SESSION_ID}-t${idx}`,
              name: toolName,
              input: toolInput,
            },
          ],
        },
      },
    ];
  };

  const skillToolResultUuid = `${SESSION_ID}-str3`;
  const skillInvocation: Record<string, unknown>[] = [
    ...turn(3, 'Skill', 15, 5, { skill: 'skill-alpha' }),
    {
      type: 'user',
      uuid: skillToolResultUuid,
      parentUuid: `${SESSION_ID}-a3`,
      timestamp: new Date().toISOString(),
      message: {
        content: [{ type: 'tool_result', tool_use_id: `${SESSION_ID}-t3` }],
      },
    },
    {
      type: 'user',
      uuid: `${SESSION_ID}-meta3`,
      parentUuid: skillToolResultUuid,
      isMeta: true,
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: SKILL_CONTENT_TEXT }] },
    },
  ];

  const ruleInjection: Record<string, unknown> = {
    type: 'attachment',
    attachment: {
      type: 'nested_memory',
      displayPath: '.claude/rules/demo.md',
      path: '/repo/.claude/rules/demo.md',
      content: { type: 'Project', content: RULE_CONTENT_TEXT },
    },
  };

  return [
    ...turn(1, 'Read', READ_INPUT_TOKENS, READ_OUTPUT_TOKENS),
    ...turn(2, 'mcp__playwright__browser_click', CLICK_INPUT_TOKENS, CLICK_OUTPUT_TOKENS),
    ...skillInvocation,
    ruleInjection,
  ];
}

// DD-1/DD-9/DD-10: the self-reported skill/rule/MCP inventory now travels as one
// `harness-snapshot` line (plus its `harness-snapshot-ref`), replacing the old separate
// `skill-definitions`/`system-context`/`mcp-config` events. The stored inventory the assertions
// below check (skill-alpha/skill-beta, the `demo` rule, the `playwright`/`postgres` MCP servers
// and their tools) stays the same — only the wire shape changed.
function harnessArtisynEvents(): Record<string, unknown>[] {
  const snapshotId = crypto.randomBytes(32).toString('hex');
  return [
    { type: 'harness-snapshot-ref', snapshotId },
    {
      type: 'harness-snapshot',
      snapshotId,
      schemaVersion: 1,
      perToolDetailSupported: true,
      skills: [
        {
          name: 'skill-alpha',
          kind: 'skill',
          source: 'project',
          description: 'skill-alpha',
          body: '',
          path: '.claude/skills/skill-alpha/SKILL.md',
          bytes: 300,
          contentHash: 'a'.repeat(64),
        },
        {
          name: 'skill-beta',
          kind: 'skill',
          source: 'plugin',
          description: 'skill-beta',
          body: '',
          path: 'demo-plugin@1.0.0/skills/skill-beta/SKILL.md',
          bytes: 100,
          contentHash: 'b'.repeat(64),
          plugin: {
            id: 'demo-plugin@demo-marketplace',
            name: 'demo-plugin',
            marketplace: 'demo-marketplace',
            version: '1.0.0',
          },
        },
      ],
      agents: [],
      mcpServers: [
        {
          name: 'playwright',
          command: '',
          args: [],
          configSource: 'project',
          connected: true,
          tools: [
            { name: 'browser_click', schemaSizeTokens: 12 },
            { name: 'browser_navigate', schemaSizeTokens: 20 },
          ],
        },
        {
          name: 'postgres',
          command: '',
          args: [],
          configSource: 'project',
          connected: false,
          tools: [],
        },
      ],
      systemContext: {
        totalBytes: 200,
        files: [{ path: '.claude/rules/demo.md', bytes: 200, contentHash: 'c'.repeat(64) }],
      },
    },
  ];
}

async function navigateToHarnessUsageReport(page: Page, query = '') {
  await page.goto(
    `/#/repos/${repoId}?mtab=reports&report=harness-usage${query}`,
  );
  await expect(page.getByRole('tab', { name: 'Reports' })).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByRole('navigation', { name: 'Reports' })).toBeVisible({
    timeout: 8_000,
  });
  await expect(
    page.getByRole('heading', { name: 'Harness Usage', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
}

/** Reads the value paragraph rendered right after a KPI tile's label span. */
async function kpiTileValue(page: Page, label: string): Promise<string> {
  const value = await page
    .getByText(label, { exact: true })
    .locator('xpath=following-sibling::p[1]')
    .innerText();
  return value.trim();
}

test.beforeAll(async () => {
  ownerCtx = await pwRequest.newContext({ baseURL: BASE_URL });
  seeded = await seedRepoWithSessions(ownerCtx, {
    role: 'primary',
    specSlug: 'harness-usage',
    sessions: [
      {
        sessionId: SESSION_ID,
        firstPrompt: 'Harness usage e2e session',
        branch: 'main',
        daysAgo: 0,
        artisynEvents: harnessArtisynEvents(),
        claudeEvents: harnessClaudeTranscript(),
      },
    ],
  });
  repoId = seeded.repoId;
});

test.afterAll(async () => {
  await seeded?.cleanup();
  await ownerCtx?.dispose();
});

test.describe('Harness Usage report', () => {
  test('@core is listed under Harness and renders KPI tiles plus real self-reported inventory + usage', async ({
    page,
  }) => {
    await page.goto(`/#/repos/${repoId}?mtab=reports`);
    await expect(page.getByRole('navigation', { name: 'Reports' })).toBeVisible({
      timeout: 8_000,
    });

    const nav = page.getByRole('navigation', { name: 'Reports' });
    await expect(nav.getByText('Harness', { exact: true })).toBeVisible();
    await nav.getByText('Harness Usage').click();

    await page.waitForFunction(
      () => window.location.hash.includes('report=harness-usage'),
      { timeout: 5_000 },
    );
    await expect(
      page.getByRole('heading', { name: 'Harness Usage', exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // KPI tiles (wireframe order).
    await expect(page.getByText('Harness elements', { exact: true })).toBeVisible();
    await expect(page.getByText('Never used (period)', { exact: true })).toBeVisible();
    await expect(page.getByText('Total uses', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Sessions (period)', { exact: true }),
    ).toBeVisible();
    // The dev DB is long-lived and shared across e2e runs — assert a real (nonzero) count
    // rather than a brittle exact total; the exact per-row counts below are what's pinned.
    expect(Number(await kpiTileValue(page, 'Total uses'))).toBeGreaterThan(0);
    expect(Number(await kpiTileValue(page, 'Sessions (period)'))).toBeGreaterThan(
      0,
    );

    // The self-reported inventory renders — skills, rule, MCP server, and a real built-in
    // tool row (Read) with its real, deterministic usage count.
    await expect(page.getByRole('cell', { name: 'skill-alpha' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'skill-beta' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'playwright' })).toBeVisible();
    const readRow = page.getByRole('row', { name: /^Tool Read/ });
    await expect(readRow).toBeVisible();
    await expect(readRow.getByRole('cell').nth(3)).toHaveText('1');

    // Skill/rule usage comes from real transcript triggers, not self-report presence
    // skill-alpha was genuinely invoked via the Skill tool and shows a
    // real use; skill-beta was only ever self-reported as registered and correctly shows
    // zero — the exact bug the old counting had (every registered skill showed the same
    // count, regardless of whether it was ever actually loaded).
    const skillAlphaRow = page.getByRole('row', { name: /^Skill skill-alpha/ });
    await expect(skillAlphaRow).toBeVisible();
    await expect(skillAlphaRow.getByRole('cell').nth(3)).toHaveText('1');

    const skillBetaRow = page.getByRole('row', { name: /^Skill skill-beta/ });
    await expect(skillBetaRow).toBeVisible();
    await expect(skillBetaRow.getByRole('cell').nth(3)).toHaveText('0');
  });

  test('changing the date range changes the usage counts', async ({ page }) => {
    await navigateToHarnessUsageReport(page);
    const baseline = Number(await kpiTileValue(page, 'Total uses'));
    expect(baseline).toBeGreaterThan(0);

    // A window with no sessions at all — usage facts are date-scoped, the inventory itself
    // is not, so the report still renders (same element count) but with zero usage/sessions.
    await navigateToHarnessUsageReport(
      page,
      '&startDate=2020-01-01&endDate=2020-01-31',
    );
    expect(await kpiTileValue(page, 'Total uses')).toBe('0');
    expect(await kpiTileValue(page, 'Sessions (period)')).toBe('0');
    await expect(page.getByRole('cell', { name: 'skill-alpha' })).toBeVisible();
  });

  test('"Project skills only" checkbox hides plugin-sourced skills', async ({
    page,
  }) => {
    await navigateToHarnessUsageReport(page);

    await expect(page.getByRole('cell', { name: 'skill-alpha' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'skill-beta' })).toBeVisible();

    await page.getByRole('checkbox', { name: 'Project skills only' }).check();
    await expect(page.getByRole('cell', { name: 'skill-alpha' })).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'skill-beta' }),
    ).not.toBeVisible();

    await page.getByRole('checkbox', { name: 'Project skills only' }).uncheck();
    await expect(page.getByRole('cell', { name: 'skill-beta' })).toBeVisible();
  });

  test('kind filter chips isolate a kind', async ({ page }) => {
    await navigateToHarnessUsageReport(page);

    await page.getByRole('button', { name: /^Skill \d+$/ }).click();
    await expect(page.getByRole('cell', { name: 'skill-alpha' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'skill-beta' })).toBeVisible();
    await expect(page.getByRole('row', { name: /^Tool Read/ })).not.toBeVisible();
    await expect(page.getByRole('cell', { name: 'playwright' })).not.toBeVisible();
  });

  test('an MCP tool breakdown lives under its parent MCP row, never under the Tool filter', async ({
    page,
  }) => {
    await navigateToHarnessUsageReport(page);

    // The Tool filter now shows built-in tools only — the MCP server's own tool never
    // appears there.
    await page.getByRole('button', { name: /^Tool \d+$/ }).click();
    await expect(page.getByRole('row', { name: /^Tool Read/ })).toBeVisible();
    await expect(
      page.getByRole('row', { name: /browser_click/ }),
    ).not.toBeVisible();

    // Back to "All": the child is only ever reachable nested under its parent MCP row, which
    // starts expanded (the folder metaphor shows the breakdown by default — see
    // HarnessUsageTable's `expandedServers` seed) and collapses/re-expands on click.
    await page.getByRole('button', { name: /^All \d+$/ }).click();
    // The row's accessible name interleaves the toggle button's own text
    // ("Collapse"/"Expand") before the server name, since both live in the same "Element"
    // cell: "MCP Collapse playwright …".
    const playwrightRow = page.getByRole('row', {
      name: /^MCP (Collapse|Expand) playwright/,
    });
    await expect(playwrightRow).toBeVisible();
    const childRow = page.getByRole('row', { name: /browser_click/ });
    await expect(childRow).toBeVisible();

    await playwrightRow.getByRole('button', { name: 'Collapse' }).click();
    await expect(childRow).not.toBeVisible();

    await playwrightRow.getByRole('button', { name: 'Expand' }).click();
    await expect(childRow).toBeVisible();
  });

  test('sorting by "Input tokens" surfaces the highest-token row — the rolled-up MCP row', async ({
    page,
  }) => {
    await navigateToHarnessUsageReport(page);

    await page.getByRole('columnheader', { name: 'Input tokens' }).click();

    // playwright's MCP row rolls up its tool children's tokens — its
    // 200 input tokens from browser_click outrank Read's 20, so it sorts to the top.
    const firstDataRow = page.locator('tbody tr').first();
    await expect(firstDataRow).toContainText('playwright');
  });

  test('"Download as PDF" is enabled once the document rendered and triggers a download', async ({
    page,
  }) => {
    await navigateToHarnessUsageReport(page);

    const downloadButton = page.getByRole('button', { name: 'Download as PDF' });
    await expect(downloadButton).toBeEnabled({ timeout: 15_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^harness-usage_.*\.pdf$/);
  });

  test('groupBy=user renders one table per user, including zero-usage rows', async ({
    page,
  }) => {
    await navigateToHarnessUsageReport(page, '&groupBy=user');

    await expect(
      page.getByRole('heading', { name: ownerEmail, exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    // A never-used built-in tool still renders its row, badged, not hidden.
    await expect(page.getByRole('cell', { name: /^Bash/ })).toBeVisible();
    await expect(page.getByText('0 uses').first()).toBeVisible();
  });
});
