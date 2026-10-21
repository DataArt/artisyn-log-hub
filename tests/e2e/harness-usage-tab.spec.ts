/**
 * The session view's "Harness usage" tab, in a real browser.
 *
 * This is the half the node-environment client unit tests cannot reach: clicking tree nodes,
 * flipping the "Include sub-sessions" switch, and — the acceptance criterion that only exists at
 * this level — proving that none of that issues a network request.
 *
 * The right pane is a usage-count summary (kind, element, count), not a chronological event log —
 * "Include sub-sessions" sums counts over the subtree instead of listing every descendant's rows
 * with a source column.
 *
 * The fixture is deliberately the shape the requirement is about: a root session that runs a
 * Workflow, two workflow agents uploaded exactly the way the hook uploads them
 * (`type=claude-subagent` + `parentSessionId` + `workflowRunId`), and a plain nested sub-agent
 * with a child of its own. Each session's harness usage is distinct, so every assertion is an
 * exact match rather than a "something is there":
 *
 *   root         → its own Skill + the Workflow call        (2 elements)
 *   wf agent A   → one Skill                                (1)
 *   wf agent B   → nothing at all                           (0 — the "loaded nothing" state)
 *   plain        → one Skill                                (1)
 *   plain child  → one MCP tool call                        (1)
 */
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

test.use({ storageState: storageStatePath('primary') });

const MODEL = 'claude-sonnet-4-6';
const WF_TOOL_USE_ID = 'toolu_e2e_harness_wf';
const WF_TASK_ID = 'task-e2e-harness-wf';
const WF_ID = 'wf_e2e_harness_run';
const WORKFLOW_NAME = 'HarnessWorkflow';

const LIST_LABEL = 'e2e: harness usage tab session';
const ROOT_PROMPT = 'e2e harness usage root turn text';

const ROOT_SKILL = 'e2e-root-skill';
const AGENT_SKILL = 'e2e-agent-skill';
const PLAIN_SKILL = 'e2e-plain-skill';
const MCP_TOOL = 'mcp__e2eserver__do_thing';

const suffix = crypto.randomUUID().slice(0, 8);
const rootSessionId = `harness-tab-root-${suffix}`;
// Bare ids (after stripping "agent-") stay <= 12 chars so the Logs tab's truncateAgentId()
// never ellipsizes them — that keeps the drill-down click target an exact accessible name.
const wfAgentAId = `agent-wfa-${suffix}`;
const wfAgentBId = `agent-wfb-${suffix}`;
const plainAgentId = `agent-pl-${suffix}`;
const plainChildId = `agent-pc-${suffix}`;
const cmdAgentId = `agent-cd-${suffix}`;

let seeded: SeededRepo;
let ownerCtx: APIRequestContext;
let repoId: number;

function assistantEvent(
  sid: string,
  uuid: string,
  parentUuid: string | null,
  blocks: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId: sid,
    message: {
      role: 'assistant',
      model: MODEL,
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: blocks,
    },
  };
}

function userPrompt(
  sid: string,
  uuid: string,
  text: string,
): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: sid,
    isMeta: false,
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

/**
 * A slash-command invocation, in one of the two real shapes — distinguished by which tag comes
 * first. The `<command-message>`-first shape is a real skill/command invocation (tracked as a
 * `skill`-kind usage row); the `<command-name>`-first shape is a plain CLI utility like `/clear`
 * (not tracked at all).
 */
function commandEvent(
  sid: string,
  uuid: string,
  commandName: string,
  { newShape = true }: { newShape?: boolean } = {},
): Record<string, unknown> {
  const content = newShape
    ? `<command-message>${commandName}</command-message>\n<command-name>/${commandName}</command-name>\n<command-args></command-args>`
    : `<command-name>/${commandName}</command-name>\n<command-message>${commandName}</command-message>\n<command-args></command-args>`;
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: sid,
    isMeta: false,
    isSidechain: false,
    message: { role: 'user', content },
  };
}

/** The `<task-notification>` the workflow runtime enqueues — the source of `wfId`. */
function workflowEnqueueXml(): string {
  const usageJson = JSON.stringify({
    duration_ms: 12_000,
    agent_count: 2,
    subagent_tokens: 240,
    tool_uses: 4,
  });
  return [
    '<task-notification>',
    `<tool-use-id>${WF_TOOL_USE_ID}</tool-use-id>`,
    `<task-id>${WF_TASK_ID}</task-id>`,
    '<status>completed</status>',
    '<summary>e2e harness workflow summary</summary>',
    `<usage>${usageJson}</usage>`,
    '<result>{"findings":[]}</result>',
    `<diagnostics>resumeFromRunId: '${WF_ID}'</diagnostics>`,
    '</task-notification>',
  ].join('\n');
}

function buildRootEvents(sid: string): Record<string, unknown>[] {
  return [
    userPrompt(sid, `${sid}-u1`, ROOT_PROMPT),
    assistantEvent(sid, `${sid}-a1`, `${sid}-u1`, [
      {
        type: 'tool_use',
        id: `${sid}-tu-skill`,
        name: 'Skill',
        input: { skill: ROOT_SKILL },
      },
    ]),
    assistantEvent(sid, `${sid}-a2`, `${sid}-a1`, [
      {
        type: 'tool_use',
        id: WF_TOOL_USE_ID,
        name: 'Workflow',
        input: { name: WORKFLOW_NAME, args: 'e2e harness args' },
      },
    ]),
    { type: 'queue-operation', operation: 'enqueue', content: workflowEnqueueXml() },
  ];
}

function buildSkillAgentEvents(
  sid: string,
  prompt: string,
  skill: string,
): Record<string, unknown>[] {
  return [
    userPrompt(sid, `${sid}-u1`, prompt),
    assistantEvent(sid, `${sid}-a1`, `${sid}-u1`, [
      {
        type: 'tool_use',
        id: `${sid}-tu`,
        name: 'Skill',
        input: { skill },
      },
    ]),
  ];
}

/**
 * An agent that used no harness element at all — no tool call whatsoever. (A built-in tool call
 * like Read would now count as a `tool`-kind element, so it can't be used here.)
 */
function buildBareAgentEvents(
  sid: string,
  prompt: string,
): Record<string, unknown>[] {
  return [userPrompt(sid, `${sid}-u1`, prompt)];
}

/**
 * An agent whose transcript is entirely slash commands: a plugin-mapped one (tracked as a skill)
 * and a plain CLI one (not tracked at all) — the regression fixture for the bug where `/adlc:review`
 * did not appear in the tab despite the session having "used" that skill.
 */
function buildCommandAgentEvents(
  sid: string,
  prompt: string,
): Record<string, unknown>[] {
  return [
    userPrompt(sid, `${sid}-u1`, prompt),
    commandEvent(sid, `${sid}-u2`, 'adlc:review'),
    commandEvent(sid, `${sid}-u3`, 'clear', { newShape: false }),
  ];
}

function buildMcpAgentEvents(
  sid: string,
  prompt: string,
): Record<string, unknown>[] {
  return [
    userPrompt(sid, `${sid}-u1`, prompt),
    assistantEvent(sid, `${sid}-a1`, `${sid}-u1`, [
      { type: 'tool_use', id: `${sid}-tu`, name: MCP_TOOL, input: {} },
    ]),
  ];
}

async function uploadSubagent(
  events: Record<string, unknown>[],
  sessionId: string,
  parentSessionId: string,
  workflowRunId?: string,
) {
  const wfParam = workflowRunId
    ? `&workflowRunId=${encodeURIComponent(workflowRunId)}`
    : '';
  const resp = await ownerCtx.post(
    `/api/v2/logs?sessionId=${encodeURIComponent(sessionId)}&type=claude-subagent&parentSessionId=${encodeURIComponent(parentSessionId)}${wfParam}`,
    {
      headers: { 'content-type': 'text/plain', 'x-api-key': seeded.apiKey },
      data: events.map((e) => JSON.stringify(e)).join('\n'),
    },
  );
  if (!resp.ok()) {
    throw new Error(
      `Seed: sub-agent ${sessionId} upload failed (${resp.status()}): ${await resp.text()}`,
    );
  }
  // v2 only stages the upload — wait for the queue worker to store it.
  await waitForUploadQueueDrained(sessionId, 'claude-subagent');
}

test.beforeAll(async () => {
  ownerCtx = await pwRequest.newContext({ baseURL: BASE_URL });
  seeded = await seedRepoWithSessions(ownerCtx, {
    role: 'primary',
    specSlug: `harness-usage-tab-${suffix}`,
    sessions: [
      {
        sessionId: rootSessionId,
        firstPrompt: LIST_LABEL,
        branch: 'e2e',
        daysAgo: 0,
        claudeEvents: buildRootEvents(rootSessionId),
      },
    ],
  });
  repoId = seeded.repoId;

  await uploadSubagent(
    buildSkillAgentEvents(wfAgentAId, 'e2e workflow agent A task', AGENT_SKILL),
    wfAgentAId,
    rootSessionId,
    WF_ID,
  );
  await uploadSubagent(
    buildBareAgentEvents(wfAgentBId, 'e2e workflow agent B task'),
    wfAgentBId,
    rootSessionId,
    WF_ID,
  );
  await uploadSubagent(
    buildSkillAgentEvents(plainAgentId, 'e2e plain sub-agent task', PLAIN_SKILL),
    plainAgentId,
    rootSessionId,
  );
  await uploadSubagent(
    buildMcpAgentEvents(plainChildId, 'e2e nested sub-agent task'),
    plainChildId,
    plainAgentId,
  );
  await uploadSubagent(
    buildCommandAgentEvents(cmdAgentId, 'e2e slash-command sub-agent task'),
    cmdAgentId,
    rootSessionId,
  );
});

test.afterAll(async () => {
  try {
    await seeded?.cleanup();
  } finally {
    await ownerCtx?.dispose();
  }
});

const tab = (page: Page) => page.locator('[data-testid="harness-usage-tab"]');
const treeRows = (page: Page) => page.locator('[data-testid="harness-tree-row"]');
const elementRows = (page: Page) =>
  page.locator('[data-testid="harness-element-row"]');
const includeSwitch = (page: Page) =>
  page.locator('[data-testid="harness-include-children"]');

function treeRow(page: Page, nodeId: string) {
  return page.locator(
    `[data-testid="harness-tree-row"][data-node-id="${nodeId}"]`,
  );
}

async function openTab(page: Page) {
  await page.goto(
    `/#/repos/${repoId}?session=${rootSessionId}&tab=harness-usage`,
  );
  await expect(tab(page)).toBeVisible({ timeout: 20_000 });
  await expect(treeRow(page, 'root')).toBeVisible({ timeout: 20_000 });
}

test.describe('Harness usage tab — the session tree', () => {
  test('@core the workflow group node holds both agents, and selecting an agent shows its own elements', async ({
    page,
  }) => {
    await openTab(page);

    // The tree is the whole run: root, the workflow group with its two agents, the plain
    // sub-agent and its own child, and the slash-command sub-agent.
    await expect(treeRows(page)).toHaveCount(7);

    const group = treeRow(page, `wf:${WF_ID}`);
    await expect(group).toBeVisible();
    await expect(group).toContainText(`Workflow · ${WORKFLOW_NAME}`);

    // Both workflow agents are relabelled positionally within the run and sit under the group.
    await expect(treeRow(page, wfAgentAId.replace('agent-', ''))).toContainText(
      `${WORKFLOW_NAME}:Agent`,
    );
    await expect(treeRow(page, wfAgentBId.replace('agent-', ''))).toContainText(
      `${WORKFLOW_NAME}:Agent`,
    );

    // Root is selected by default: its own two elements, and nothing borrowed from a child.
    await expect(elementRows(page)).toHaveCount(2);
    await expect(elementRows(page)).toContainText([ROOT_SKILL, WORKFLOW_NAME]);

    // Clicking workflow agent A shows ITS skill — and not the root's.
    await treeRow(page, wfAgentAId.replace('agent-', '')).click();
    await expect(elementRows(page)).toHaveCount(1);
    await expect(elementRows(page).first()).toContainText(AGENT_SKILL);
    await expect(elementRows(page).first()).not.toContainText(ROOT_SKILL);

    // Workflow agent B loaded nothing — the per-node empty state, not the whole-tree one.
    await treeRow(page, wfAgentBId.replace('agent-', '')).click();
    await expect(elementRows(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="harness-usage-empty"]')).toContainText(
      'No harness elements in this session',
    );
  });

  test('@core a plugin-mapped slash command shows as a SKILL row; a plain CLI command does not', async ({
    page,
  }) => {
    await openTab(page);

    await treeRow(page, cmdAgentId.replace('agent-', '')).click();
    await expect(elementRows(page)).toHaveCount(1);
    await expect(elementRows(page).first()).toContainText('adlc:review');
    await expect(elementRows(page).first()).toContainText('SKILL');
    await expect(elementRows(page)).not.toContainText('clear');
  });

  test('@core Include sub-sessions sums counts over the subtree, survives selection, and never changes a tree badge', async ({
    page,
  }) => {
    await openTab(page);

    const rootBadge = treeRow(page, 'root').locator(
      '[data-testid="harness-node-badge"]',
    );
    await expect(rootBadge).toHaveText('2');
    await expect(elementRows(page)).toHaveCount(2);

    // Switch on at the root: the whole subtree, aggregated into a usage-count summary.
    await includeSwitch(page).click();
    // root's 2 + agent A's 1 + the plain agent's 1 + its child's 1 + the command agent's 1
    // (agent B has none, /clear is untracked, and the group node's merged copy is deliberately
    // not counted a second time) — six distinct (kind, name) pairs, none of which collide.
    await expect(elementRows(page)).toHaveCount(6);
    // The badge is the node's OWN count — the switch must not touch it.
    await expect(rootBadge).toHaveText('2');

    // The setting survives moving to another node that has descendants of its own.
    await treeRow(page, plainAgentId.replace('agent-', '')).click();
    await expect(elementRows(page)).toHaveCount(2);
    await expect(elementRows(page)).toContainText([PLAIN_SKILL, 'e2eserver:']);

    // Turning it back off returns to that session's own elements.
    await includeSwitch(page).click();
    await expect(elementRows(page)).toHaveCount(1);
  });
});

test.describe('Harness usage tab — no extra requests', () => {
  test('@core node clicks and switch flips issue no further session-data request', async ({
    page,
  }) => {
    await openTab(page);

    // Counted from tab-open onward, and narrowed deliberately: with a session open the view
    // also runs two independent 15 s `/sessions` polls, so a blanket `/api/v1/` counter would
    // fail on timing alone. What the criterion is about is session DATA.
    let dataRequests = 0;
    page.on('request', (req) => {
      const url = req.url();
      if (/\/sessions\/[^/]+\/logs/.test(url) || url.includes('/change-surface')) {
        dataRequests += 1;
      }
    });

    await treeRow(page, wfAgentAId.replace('agent-', '')).click();
    await treeRow(page, plainAgentId.replace('agent-', '')).click();
    await includeSwitch(page).click();
    await treeRow(page, 'root').click();
    await includeSwitch(page).click();
    await treeRow(page, `wf:${WF_ID}`).click();
    await expect(elementRows(page)).toHaveCount(1);

    expect(dataRequests).toBe(0);
  });
});

test.describe('Logs tab — a sub-agent’s own skills and rules', () => {
  test('@core opening a workflow agent that loaded a skill shows a Skills section; one that loaded none shows no section', async ({
    page,
  }) => {
    await page.goto(`/#/repos/${repoId}?session=${rootSessionId}&tab=logs`);
    await expect(page.getByText(ROOT_PROMPT)).toBeVisible({ timeout: 20_000 });

    await page.getByText(`⚡ ${WORKFLOW_NAME}`).click();
    await expect(page.getByText('Agents (2)')).toBeVisible({ timeout: 10_000 });

    // The agents are a table: one `workflow-agent-row` per agent (keyed by its bare id);
    // clicking a row opens a modal whose Logs tab (`workflow-agent-logs`) renders that agent's
    // turns with their sections, so the Skills assertions are scoped to it.
    const agentRow = (agentId: string) =>
      page.locator(
        `[data-testid="workflow-agent-row"][data-agent-id="${agentId.replace('agent-', '')}"]`,
      );
    const dialog = page.getByRole('dialog');
    const detail = dialog.getByTestId('workflow-agent-logs');
    const skillsSections = detail.getByRole('button', { name: /Skills/ });

    // Agent A loaded a skill — a Skills section appears and names it.
    await agentRow(wfAgentAId).click();
    await expect(detail).toBeVisible({ timeout: 10_000 });
    await expect(skillsSections).toHaveCount(1, { timeout: 10_000 });
    await skillsSections.click();
    await expect(detail.getByText(`.claude/skills/${AGENT_SKILL}`)).toBeVisible({
      timeout: 10_000,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Agent B loaded none — no empty Skills section is rendered for it. (Its prompt is also the
    // row label, so the prompt check is scoped to the modal's Logs tab.)
    await agentRow(wfAgentBId).click();
    await expect(detail.getByText('e2e workflow agent B task')).toBeVisible({
      timeout: 10_000,
    });
    await expect(skillsSections).toHaveCount(0);
  });
});
