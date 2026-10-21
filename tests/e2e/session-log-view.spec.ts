import {
  test,
  expect,
  request as pwRequest,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import * as crypto from 'crypto';
import { BASE_URL, storageStatePath } from './helpers/credentials';
import { seedRepoWithSessions, type SeededRepo } from './helpers/seed';
import { waitForUploadQueueDrained } from './helpers/db';

// Runs as the repo owner (`primary`) via saved storageState. Seeds its
// own repo + a rich claude session (skill + rule injection + tool_use) so the
// Charts sub-tabs, Context Usage, and Skills/Rules sections have real data.
test.use({ storageState: storageStatePath('primary') });

const RULE_TEXT =
  'This is a NestJS application test rule for e2e testing purposes.';
const RULE_EST_TOKENS = Math.round(
  new TextEncoder().encode(RULE_TEXT).length / 3.5,
);

let seeded: SeededRepo;
let ownerCtx: APIRequestContext;
let repoId: number;
let sessionId: string;

/** Rich claude NDJSON events (returned as an array for the seed helper). */
function buildClaudeEvents(sid: string): Record<string, unknown>[] {
  const uuidUser = `${sid}-u1`;
  const uuidAttach = `${sid}-a1`;
  const uuidAsst = `${sid}-as1`;
  const uuidResult = `${sid}-u2`;
  return [
    { type: 'mode', mode: 'normal', sessionId: sid },
    {
      type: 'user',
      uuid: uuidUser,
      parentUuid: null,
      sessionId: sid,
      isMeta: false,
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'e2e test prompt for skills and rules' }],
      },
    },
    {
      type: 'attachment',
      uuid: uuidAttach,
      parentUuid: uuidUser,
      sessionId: sid,
      attachment: {
        type: 'nested_memory',
        path: '/repo/.claude/rules/server.md',
        displayPath: '.claude\\rules\\server.md',
        content: {
          type: 'Project',
          content: RULE_TEXT,
          contentDiffersFromDisk: false,
        },
      },
    },
    {
      type: 'assistant',
      uuid: uuidAsst,
      parentUuid: uuidUser,
      sessionId: sid,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [
          {
            type: 'tool_use',
            id: 'tool-e2e-skill-1',
            name: 'Skill',
            input: { skill: 'implementation-plan' },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: uuidResult,
      parentUuid: uuidAsst,
      sessionId: sid,
      isMeta: false,
      isSidechain: false,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-e2e-skill-1',
            content: 'Skill executed',
          },
        ],
      },
    },
  ];
}

test.beforeAll(async () => {
  ownerCtx = await pwRequest.newContext({ baseURL: BASE_URL });
  sessionId = `session-log-view-s1-${crypto.randomUUID().slice(0, 8)}`;
  seeded = await seedRepoWithSessions(ownerCtx, {
    role: 'primary',
    specSlug: 'session-log-view',
    sessions: [
      {
        sessionId,
        firstPrompt: 'e2e: skills and rules test',
        branch: 'e2e',
        daysAgo: 0,
        claudeEvents: buildClaudeEvents(sessionId),
      },
    ],
  });
  repoId = seeded.repoId;
});

test.afterAll(async () => {
  try {
    await seeded?.cleanup();
  } finally {
    await ownerCtx?.dispose();
  }
});

async function openTestSession(page: Page) {
  await page.goto(`/#/repos/${repoId}`);
  // Click the session item that shows the artisyn firstPrompt
  await page.getByText('e2e: skills and rules test').click();
  // The default landing tab is now Summary — select Logs explicitly.
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  // Wait for the log view to render the claude log's first turn
  await expect(page.locator('text=e2e test prompt for skills and rules')).toBeVisible({ timeout: 10_000 });
}

// The session detail nav uses button role (not tab), so we use getByRole('button')
async function openChartsTab(page: Page) {
  await openTestSession(page);
  await page.getByRole('button', { name: 'Charts', exact: true }).click();
  // Wait for the sub-tab bar to appear (sub-tabs do use tab role from Radix Tabs)
  await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible({ timeout: 5_000 });
}

test.describe('Session Charts sub-tabs', () => {
  test('Dashboard is the default active tab', async ({ page }) => {
    // Clear localStorage to ensure fresh default
    await page.goto('/#/login');
    await page.evaluate(() => localStorage.removeItem('charts-sub-tab'));

    await openChartsTab(page);

    // Dashboard trigger should be active — it became the default sub-tab when
    // the charts dashboard landed (commit 9438b2f).
    await expect(page.getByRole('tab', { name: 'Dashboard' })).toHaveAttribute('data-state', 'active');

    // The chart sub-tabs tablist contains exactly one active trigger: Dashboard
    // Scope to the tablist that contains the chart sub-tabs
    const chartTabList = page.locator('[role="tablist"]').filter({ has: page.getByRole('tab', { name: 'Timeline' }) });
    const activeTabsTriggers = chartTabList.locator('[data-slot="tabs-trigger"][data-state="active"]');
    await expect(activeTabsTriggers).toHaveCount(1);
    await expect(activeTabsTriggers).toHaveText('Dashboard');
  });

  test('Agent Tree tab switch', async ({ page }) => {
    await openChartsTab(page);

    await page.getByRole('tab', { name: 'Agent Tree' }).click();

    // Agent Tree trigger should now be active
    await expect(page.getByRole('tab', { name: 'Agent Tree' })).toHaveAttribute('data-state', 'active');

    // Scope to the chart sub-tabs tablist
    const chartTabList = page.locator('[role="tablist"]').filter({ has: page.getByRole('tab', { name: 'Timeline' }) });
    const activeTabsTriggers = chartTabList.locator('[data-slot="tabs-trigger"][data-state="active"]');
    await expect(activeTabsTriggers).toHaveCount(1);
    await expect(activeTabsTriggers).toHaveText('Agent Tree');
  });

  test('Tool Heatmap tab switch', async ({ page }) => {
    await openChartsTab(page);

    await page.getByRole('tab', { name: 'Tool Heatmap' }).click();

    // Tool Heatmap trigger should be active
    await expect(page.getByRole('tab', { name: 'Tool Heatmap' })).toHaveAttribute('data-state', 'active');

    // Scope to the chart sub-tabs tablist
    const chartTabList = page.locator('[role="tablist"]').filter({ has: page.getByRole('tab', { name: 'Timeline' }) });
    const activeTabsTriggers = chartTabList.locator('[data-slot="tabs-trigger"][data-state="active"]');
    await expect(activeTabsTriggers).toHaveCount(1);
    await expect(activeTabsTriggers).toHaveText('Tool Heatmap');
  });

  test('localStorage persistence', async ({ page }) => {
    await openChartsTab(page);

    // Switch to Agent Tree
    await page.getByRole('tab', { name: 'Agent Tree' }).click();
    await expect(page.getByRole('tab', { name: 'Agent Tree' })).toHaveAttribute('data-state', 'active');

    // Reload page — URL retains ?session=...&tab=charts so the session + tab reopen automatically
    await page.reload();
    await page.waitForFunction(() => !window.location.hash.startsWith('#/login'), { timeout: 10_000 });

    // Wait for the sub-tab bar to reappear
    await expect(page.getByRole('tab', { name: 'Agent Tree' })).toBeVisible({ timeout: 10_000 });

    // Agent Tree should still be active (persisted via localStorage)
    await expect(page.getByRole('tab', { name: 'Agent Tree' })).toHaveAttribute('data-state', 'active');
  });
});

test.describe('Session Charts — Context Usage tab', () => {
  test('Context Usage tab shows a Total row in the table', async ({ page }) => {
    await openChartsTab(page);

    await page.getByRole('tab', { name: 'Context Usage' }).click();

    // The summary table should have a Total row
    await expect(page.getByRole('cell', { name: 'Total' }).first()).toBeVisible({ timeout: 5_000 });
  });

  test('Context Usage tab renders at least one SVG chart', async ({ page }) => {
    await openChartsTab(page);

    await page.getByRole('tab', { name: 'Context Usage' }).click();

    // Wait for content to render and check for an svg element
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 5_000 });
  });

  test('localStorage persistence restores Context Usage as active tab', async ({ page }) => {
    // Navigate to app and set localStorage before opening
    await page.goto('/#/login');
    await page.evaluate(() => localStorage.setItem('charts-sub-tab', 'context-usage'));

    await openChartsTab(page);

    // Context Usage trigger should be active
    await expect(page.getByRole('tab', { name: 'Context Usage' })).toHaveAttribute('data-state', 'active');
  });
});

test.describe('Session Log View — Skills and Rules sections', () => {
  test('@core Skills section renders with collapsible table for a session with skill invocations', async ({ page }) => {
    await openTestSession(page);

    // Skills section header is visible with count summary
    const skillsHeader = page.getByRole('button', { name: /Skills.*1 skill/ });
    await expect(skillsHeader).toBeVisible({ timeout: 5_000 });

    // Expand skills
    await skillsHeader.click();

    // Skill name cell appears in the expanded table
    await expect(page.getByRole('cell', { name: 'implementation-plan' })).toBeVisible({ timeout: 3_000 });

    // The "skill" badge cell appears inside the table
    await expect(page.getByRole('cell', { name: /^skill$/ }).first()).toBeVisible();
  });

  test('Rules section renders with collapsible table for a session with nested_memory injections', async ({ page }) => {
    await openTestSession(page);

    // Rules section header is visible and shows token count in summary
    const rulesHeader = page.getByRole('button', { name: /Rules.*tok/ });
    await expect(rulesHeader).toBeVisible({ timeout: 5_000 });

    // Expand rules
    await rulesHeader.click();

    // Rule name "server" cell appears (normalized from ".claude/rules/server.md")
    await expect(page.getByRole('cell', { name: /^server$/ })).toBeVisible({ timeout: 3_000 });

    // Token estimate appears in the table cell
    await expect(page.getByRole('cell', { name: new RegExp(`~${RULE_EST_TOKENS} tok`) })).toBeVisible({ timeout: 3_000 });

    // The "rule" badge cell appears
    await expect(page.getByRole('cell', { name: /^rule$/ }).first()).toBeVisible();
  });

  test('no console errors when viewing session with skills and rules', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('401')) {
        errors.push(msg.text());
      }
    });

    await openTestSession(page);

    // Expand both sections
    const skillsHeader = page.getByRole('button', { name: /Skills.*1 skill/ });
    await skillsHeader.click();
    const rulesHeader = page.getByRole('button', { name: /Rules.*tok/ });
    await rulesHeader.click();

    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Workflow agent visibility — Logs tab drill-down + Charts tab
// (Agent Tree / Tool Heatmap) seeding from turn.workflows[].agentSessionIds.
// ---------------------------------------------------------------------------

test.describe('Session Log View — Workflow agent visibility', () => {
  test.use({ storageState: storageStatePath('primary') });

  const WF_TOOL_USE_ID = 'toolu_e2e_wf1';
  const WF_TASK_ID = 'task-e2e-wf1';
  const WF_ID = 'wf_e2e_test_run';
  const WORKFLOW_NAME = 'ResearchWorkflow';
  // Session-list label (firstPrompt, from the artisyn log) is kept distinct from the
  // claude turn's own prompt text below so `getByText(label).click()` on the session
  // list can never collide with the turn text that appears once the log view loads.
  const WORKFLOW_ROOT_LIST_LABEL = 'e2e: workflow root session';
  const WORKFLOW_ROOT_PROMPT = 'e2e run workflow research task';
  const WORKFLOW_AGENT_PROMPT = 'e2e workflow sub-agent task';
  const REGULAR_ROOT_LIST_LABEL = 'e2e: regular sub-agent session';
  const REGULAR_ROOT_PROMPT = 'e2e regular sub-agent turn text';
  const REGULAR_AGENT_ID = 'agent-e2e-regular-1';

  let wfSeeded: SeededRepo;
  let wfOwnerCtx: APIRequestContext;
  let wfRepoId: number;
  let wfRootSessionId: string;
  let wfAgentSessionId: string;

  function workflowEnqueueXml(): string {
    const usageJson = JSON.stringify({
      duration_ms: 8000,
      agent_count: 1,
      subagent_tokens: 168,
      tool_uses: 3,
    });
    const resultJson = JSON.stringify({ findings: [] });
    return [
      '<task-notification>',
      `<tool-use-id>${WF_TOOL_USE_ID}</tool-use-id>`,
      `<task-id>${WF_TASK_ID}</task-id>`,
      '<status>completed</status>',
      '<summary>e2e workflow summary</summary>',
      `<usage>${usageJson}</usage>`,
      `<result>${resultJson}</result>`,
      `<diagnostics>resumeFromRunId: '${WF_ID}'</diagnostics>`,
      '</task-notification>',
    ].join('\n');
  }

  function buildWorkflowRootEvents(sid: string): Record<string, unknown>[] {
    const uuidUser = `${sid}-u1`;
    return [
      {
        type: 'user',
        uuid: uuidUser,
        parentUuid: null,
        sessionId: sid,
        isMeta: false,
        isSidechain: false,
        message: {
          role: 'user',
          content: [{ type: 'text', text: WORKFLOW_ROOT_PROMPT }],
        },
      },
      {
        type: 'assistant',
        uuid: `${sid}-a1`,
        parentUuid: uuidUser,
        sessionId: sid,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            {
              type: 'tool_use',
              id: WF_TOOL_USE_ID,
              name: 'Workflow',
              input: { name: WORKFLOW_NAME, args: 'e2e research args' },
            },
          ],
        },
      },
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: workflowEnqueueXml(),
      },
    ];
  }

  function buildWorkflowAgentEvents(sid: string): Record<string, unknown>[] {
    const uuidUser = `${sid}-u1`;
    return [
      {
        type: 'user',
        uuid: uuidUser,
        parentUuid: null,
        sessionId: sid,
        isMeta: false,
        isSidechain: false,
        message: {
          role: 'user',
          content: [{ type: 'text', text: WORKFLOW_AGENT_PROMPT }],
        },
      },
      {
        type: 'assistant',
        uuid: `${sid}-a1`,
        parentUuid: uuidUser,
        sessionId: sid,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 123,
            output_tokens: 45,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'sub-agent work done' }],
        },
      },
    ];
  }

  /** A session with a real Task-tool Agent activation, NO Workflow at all (regression). */
  function buildRegularSubagentRootEvents(sid: string): Record<string, unknown>[] {
    const uuidUser = `${sid}-u1`;
    const uuidAsst = `${sid}-a1`;
    return [
      {
        type: 'user',
        uuid: uuidUser,
        parentUuid: null,
        sessionId: sid,
        isMeta: false,
        isSidechain: false,
        message: {
          role: 'user',
          content: [{ type: 'text', text: REGULAR_ROOT_PROMPT }],
        },
      },
      {
        type: 'assistant',
        uuid: uuidAsst,
        parentUuid: uuidUser,
        sessionId: sid,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 30,
            output_tokens: 15,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            {
              type: 'tool_use',
              id: 'toolu_e2e_reg1',
              name: 'Agent',
              input: { description: 'RegularAgent' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: `${sid}-u2`,
        parentUuid: uuidAsst,
        sessionId: sid,
        isMeta: false,
        isSidechain: false,
        toolUseResult: {
          agentId: REGULAR_AGENT_ID,
          usage: {
            input_tokens: 200,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          totalDurationMs: 1500,
        },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_e2e_reg1',
              content: 'agent done',
            },
          ],
        },
      },
    ];
  }

  test.beforeAll(async () => {
    wfOwnerCtx = await pwRequest.newContext({ baseURL: BASE_URL });
    const idSuffix = crypto.randomUUID().slice(0, 8);
    wfRootSessionId = `session-log-view-wf-root-${idSuffix}`;
    const regularSessionId = `session-log-view-wf-regular-${idSuffix}`;

    wfSeeded = await seedRepoWithSessions(wfOwnerCtx, {
      role: 'primary',
      specSlug: `session-log-view-wf-${idSuffix}`,
      sessions: [
        {
          sessionId: wfRootSessionId,
          firstPrompt: WORKFLOW_ROOT_LIST_LABEL,
          branch: 'e2e',
          daysAgo: 0,
          claudeEvents: buildWorkflowRootEvents(wfRootSessionId),
        },
        {
          sessionId: regularSessionId,
          firstPrompt: REGULAR_ROOT_LIST_LABEL,
          branch: 'e2e',
          daysAgo: 0,
          claudeEvents: buildRegularSubagentRootEvents(regularSessionId),
        },
      ],
    });
    wfRepoId = wfSeeded.repoId;

    // Upload the workflow's direct agent log — not supported by the generic seed
    // helper, so posted directly with the seeded API key (mirrors the hook's
    // subagents/workflows/<wfId>/ upload: type=claude-subagent + parentSessionId +
    // workflowRunId query params, per design decision 1).
    // Bare id (after stripping "agent-") kept to <=12 chars so SubAgentNode's
    // truncateAgentId() never ellipsizes it — keeps the Logs-tab click target
    // (below) an exact, unambiguous match instead of a truncated substring.
    wfAgentSessionId = `agent-wf-${idSuffix}`;
    const agentBody = buildWorkflowAgentEvents(wfAgentSessionId)
      .map((e) => JSON.stringify(e))
      .join('\n');
    const resp = await wfOwnerCtx.post(
      `/api/v2/logs?sessionId=${encodeURIComponent(wfAgentSessionId)}&type=claude-subagent&parentSessionId=${encodeURIComponent(wfRootSessionId)}&workflowRunId=${encodeURIComponent(WF_ID)}`,
      {
        headers: {
          'content-type': 'text/plain',
          'x-api-key': wfSeeded.apiKey,
        },
        data: agentBody,
      },
    );
    if (!resp.ok()) {
      throw new Error(
        `Seed: workflow agent log upload failed (${resp.status()}): ${await resp.text()}`,
      );
    }
    // v2 only stages the upload — wait for the queue worker to store it.
    await waitForUploadQueueDrained(wfAgentSessionId, 'claude-subagent');
  });

  test.afterAll(async () => {
    try {
      await wfSeeded?.cleanup();
    } finally {
      await wfOwnerCtx?.dispose();
    }
  });

  /**
   * `listLabel` is the session-list entry text (firstPrompt, from the artisyn log);
   * `turnPrompt` is the claude turn's own prompt text that appears once the log view
   * has actually loaded — kept distinct so the click target is never ambiguous.
   */
  async function openWfSession(page: Page, listLabel: string, turnPrompt: string) {
    await page.goto(`/#/repos/${wfRepoId}`);
    await page.getByText(listLabel, { exact: true }).click();
    // The default landing tab is now Summary — select Logs explicitly.
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(page.getByText(turnPrompt).first()).toBeVisible({
      timeout: 10_000,
    });
  }

  async function openWfChartsTab(page: Page, listLabel: string, turnPrompt: string) {
    await openWfSession(page, listLabel, turnPrompt);
    await page.getByRole('button', { name: 'Charts', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible({
      timeout: 5_000,
    });
  }

  test('@core Logs tab: expanding a workflow run with linked agents shows an Agents table whose row opens the agent modal', async ({
    page,
  }) => {
    await openWfSession(page, WORKFLOW_ROOT_LIST_LABEL, WORKFLOW_ROOT_PROMPT);

    // Expand the workflow's own collapsible row (the "⚡ <name>" pill trigger).
    await page.getByText(`⚡ ${WORKFLOW_NAME}`).click();

    // The "Agents (N)" table is shown right away with the linked direct agent.
    await expect(page.getByText('Agents (1)')).toBeVisible({ timeout: 5_000 });

    // Clicking the agent row opens its modal, whose Logs tab shows the agent's own prompt (from
    // its own transcript). The row is addressed by its bare agent id; the prompt is also the row
    // label, so the assertion is scoped to the modal's Logs tab.
    await page
      .locator(
        `[data-testid="workflow-agent-row"][data-agent-id="${wfAgentSessionId.replace('agent-', '')}"]`,
      )
      .click();
    await expect(
      page
        .getByRole('dialog')
        .getByTestId('workflow-agent-logs')
        .getByText(WORKFLOW_AGENT_PROMPT),
    ).toBeVisible({
      timeout: 5_000,
    });
  });

  test('Charts tab: Agent Tree is non-empty for a session containing only workflow-spawned agents', async ({
    page,
  }) => {
    await openWfChartsTab(page, WORKFLOW_ROOT_LIST_LABEL, WORKFLOW_ROOT_PROMPT);
    await page.getByRole('tab', { name: 'Agent Tree' }).click();

    // Before workflow agent visibility this rendered the "No sub-agents spawned" empty state.
    await expect(page.getByText('No sub-agents spawned')).not.toBeVisible();
    await expect(page.getByTestId('agent-tree-node').first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      page.locator('[data-testid="agent-tree-node"]'),
    ).toHaveCount(3); // main root + the workflow node + its one direct agent node
  });

  test('Charts tab: Tool Heatmap shows a workflow-agent column beyond the main session', async ({
    page,
  }) => {
    await openWfChartsTab(page, WORKFLOW_ROOT_LIST_LABEL, WORKFLOW_ROOT_PROMPT);
    await page.getByRole('tab', { name: 'Tool Heatmap' }).click();

    // Column label carries the "<workflow name>:<agent label>" prefix (design
    // decision — Tool Heatmap visual/UX notes), exposed via the column's title attr.
    await expect(
      page.locator(`[title^="${WORKFLOW_NAME}:"]`).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('regression: a session with only regular Task-tool sub-agents (no workflow) still renders a non-empty Agent Tree', async ({
    page,
  }) => {
    await openWfChartsTab(page, REGULAR_ROOT_LIST_LABEL, REGULAR_ROOT_PROMPT);
    await page.getByRole('tab', { name: 'Agent Tree' }).click();

    await expect(page.getByText('No sub-agents spawned')).not.toBeVisible();
    await expect(page.getByTestId('agent-tree-node').first()).toBeVisible({
      timeout: 5_000,
    });
    // No workflow-only prefixed column should leak into an unrelated session.
    await page.getByRole('tab', { name: 'Tool Heatmap' }).click();
    await expect(page.locator(`[title^="${WORKFLOW_NAME}:"]`)).toHaveCount(0);
  });

  test('no console errors across the Logs tab drill-down and Charts sub-tabs', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('401')) {
        errors.push(msg.text());
      }
    });

    await openWfSession(page, WORKFLOW_ROOT_LIST_LABEL, WORKFLOW_ROOT_PROMPT);
    await page.getByText(`⚡ ${WORKFLOW_NAME}`).click();
    await page.getByText('Agents (1)').click();
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: 'Charts', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole('tab', { name: 'Agent Tree' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('tab', { name: 'Tool Heatmap' }).click();
    await page.waitForTimeout(300);

    expect(errors).toHaveLength(0);
  });
});
