// S-REPO-17. The repo Tools/MCP tab: monitored CLI tools are configured per level (personal ∪
// team), the hook gets the merged list, MCP calls and wrapped CLI calls of an uploaded session
// tree are rebuilt in the background and shown as a tree, a calls table and a call detail with
// the full output next to what the agent saw; a call without a wrapper record says so; the tab
// follows the Sessions-tab visibility rules (docs/qaa-overview/scenarios/02-repos-sessions.md
// §S-REPO-17; mode A; 2026-06-19-mcp-invocation-log-tab).
//
// Uploads go through POST /api/v2/logs the way the hook sends them (helpers/tool-monitoring.ts):
// artisyn + claude, then the `tool-calls` log of wrapper records (DD-5, DD-6). Rows are derived
// asynchronously by the rebuild drain (DD-7), which the stand runs every second
// (`TOOL_USAGE_REBUILD_INTERVAL_MS`, modes.ts); `waitForToolUsage` polls the summary route until
// nothing is pending.
//
// Replaces: none (new functionality).
import { randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { logTurns } from '../helpers/session-view';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept } from '../helpers/teams';
import {
  buildToolCallsLog,
  fetchToolSummary,
  uploadToolCallsLog,
  uploadToolSessionTree,
  waitForToolUsage,
  type ToolSessionTree,
  type ToolUsageSummary,
} from '../helpers/tool-monitoring';

interface ConfigView {
  level: 'personal' | 'team';
  canEdit: boolean;
  paused: boolean;
  tools: Array<{
    name: string;
    enabled: boolean;
    capture: 'full' | 'meta';
    levels: Array<'personal' | 'team'>;
    lastWrapperAt: string | null;
    hint: string | null;
  }>;
  wrapStatus: { hookVersion: string | null; os: string | null; preflight: { ok: boolean } } | null;
  denylist: string[];
}

interface HookConfig {
  schemaVersion: number;
  paused: boolean;
  tools: Array<{ name: string; capture: string }>;
}

interface CallItem {
  callId: string;
  usageId: number;
  sessionId: string;
  channel: 'mcp' | 'cli';
  tool: string;
  operation: string;
  status: string;
  hints: string[];
  source: string;
  exitCode: number | null;
  toolUseId: string | null;
  sessionOwner: { id: number; email: string | null };
}

interface CallsPage {
  total: number;
  items: CallItem[];
}

interface CallDetail {
  call: CallItem & { rootSessionId: string; args: string[] | null };
  output: { input?: string; stdout?: string; stderr?: string; agentSaw?: string; encoding: string };
  link: { sessionId: string; toolUseId: string | null };
}

/** The tree row of one tool, by its exact name (the row's title is `<tool>: <calls> calls`). */
const treeTool = (page: Page, tool: string) => page.locator(`[data-testid="tools-tree-tool"][title^="${tool}: "]`);

test('@S-REPO-17 Tools/MCP tab: configured tools, MCP and wrapped CLI calls, call detail and visibility @mode-a', async ({
  api,
  browser,
  db,
  stand,
  users,
}) => {
  test.setTimeout(240_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/tools`;
  const owner = await users.user('user', { label: 'r17-owner' });
  const member = await users.user('user', { label: 'r17-member' });
  const outsider = await users.user('user', { label: 'r17-outsider' });
  const sid = (what: string) => `r17-${run}-${what}`;

  const { teamId, repoId, ownerKey, memberKey, outsiderKey } = await test.step('setup: the owner’s repository, a transparent team (owner + member) linking it', async () => {
    const ownerKey = (await createApiKey(owner.api)).key;
    const memberKey = (await createApiKey(member.api)).key;
    const outsiderKey = (await createApiKey(outsider.api)).key;
    await uploadPromptSession(api, ownerKey, { sessionId: sid('seed'), prompt: `seed ${run}`, repoUrl }, { db, userId: owner.id });
    const repoId = await ownRepoId(owner.api, repoUrl);
    const teamId = await createTeam(owner, `Tools-${run}`);
    expect((await owner.api.patch(`/api/v1/teams/${teamId}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
    await inviteAndAccept(owner, member, teamId, 'transparent');
    await addTeamRepo(owner, teamId, repoUrl);
    return { teamId, repoId, ownerKey, memberKey, outsiderKey };
  });

  const toolsBase = `/api/v1/repositories/${repoId}/tool-monitoring`;
  const getConfig = async (user: ScenarioUser, team?: number) => {
    const res = await user.api.get(`${toolsBase}/config`, { params: team === undefined ? {} : { teamId: team } });
    expect(res.status(), `${user.email} GET config`).toBe(200);
    return (await res.json()) as ConfigView;
  };
  const getCalls = async (user: ScenarioUser, query: Record<string, string | number> = {}) => {
    const res = await user.api.get(`${toolsBase}/calls`, { params: query });
    expect(res.status(), `${user.email} GET calls ${JSON.stringify(query)}`).toBe(200);
    return (await res.json()) as CallsPage;
  };
  const hookConfig = async (key: string) => {
    const res = await api.get('/api/v2/tool-monitoring/config', { params: { repoUrl }, headers: { 'X-API-Key': key } });
    expect(res.status()).toBe(200);
    return (await res.json()) as HookConfig;
  };

  await test.step('1. FR-8.1 UI: the owner adds the personal `ce` (a denylisted `bash` is refused inline) and, in the team view, the team `find`', async () => {
    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoId}?mtab=tools`);
    try {
      await expect(page.getByTestId('tab-repo-tools')).toHaveAttribute('data-state', 'active');
      await expect(page.getByTestId('tools-empty')).toBeVisible();
      await page.getByTestId('tools-monitored-button').click();
      const dialog = page.getByTestId('tools-monitored-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('tools-config-add').click();
      const name = dialog.getByTestId('tools-config-name').last();
      await name.fill('bash');
      await name.blur();
      await expect(dialog.getByTestId('tools-config-error')).toHaveText("`bash` is the agent's shell and cannot be monitored");
      await name.fill('ce');
      await expect(dialog.getByTestId('tools-config-error')).toHaveCount(0);
      await dialog.getByTestId('tools-config-save').click();
      await expect(dialog).toBeHidden();
      // Monitored but not called yet: the tree lists it as «never called».
      await expect(page.getByTestId('tools-tree-never-called')).toHaveAttribute('title', /^ce: /);
      await expect(page.getByTestId('tools-monitored-button')).toContainText('Monitored tools (1)');

      await page.goto(`/#/teams/${teamId}/repos/${repoId}?mtab=tools`);
      await page.reload();
      await expect(page.getByTestId('tab-repo-tools')).toHaveAttribute('data-state', 'active');
      await page.getByTestId('tools-monitored-button').click();
      await expect(dialog).toContainText('for every member of this team');
      await dialog.getByTestId('tools-config-add').click();
      await dialog.getByTestId('tools-config-name').last().fill('find');
      await dialog.getByTestId('tools-config-save').click();
      await expect(dialog).toBeHidden();
    } finally {
      await context.close();
    }

    // The server applies the same rules: a denylisted name is a 400 naming the field.
    const refused = await owner.api.put(`${toolsBase}/config`, {
      data: { paused: false, tools: [{ name: 'pwsh', enabled: true, capture: 'full' }] },
    });
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toMatchObject({ field: 'tools[0].name', code: 'denylisted' });

    const personal = await getConfig(owner);
    expect({ level: personal.level, canEdit: personal.canEdit }).toEqual({ level: 'personal', canEdit: true });
    expect(personal.tools.map((t) => [t.name, t.enabled, t.capture])).toEqual([['ce', true, 'full']]);
    expect(personal.tools[0].hint, 'no wrapper status reported yet').toBe('hook_too_old');
    expect(personal.denylist).toContain('bash');
    const team = await getConfig(owner, teamId);
    expect({ level: team.level, canEdit: team.canEdit }).toEqual({ level: 'team', canEdit: true });
    expect(team.tools.map((t) => t.name)).toEqual(['find']);
  });

  await test.step('2. DD-2 / DD-3: the hook config route returns the merged personal ∪ team list per API key', async () => {
    const forOwner = await hookConfig(ownerKey);
    expect(forOwner.schemaVersion).toBe(1);
    expect(forOwner.paused).toBe(false);
    expect(forOwner.tools.map((t) => `${t.name}:${t.capture}`).sort()).toEqual(['ce:full', 'find:full']);
    expect((await hookConfig(memberKey)).tools.map((t) => t.name), 'a member gets the team list only').toEqual(['find']);
    expect((await hookConfig(outsiderKey)).tools, 'an outsider gets nothing').toEqual([]);
  });

  const tree: ToolSessionTree = await test.step('3. upload a session tree with MCP calls and two Bash calls, plus its `tool-calls` log of wrapper records', async () => {
    const uploaded = await uploadToolSessionTree(
      api,
      ownerKey,
      {
        sessionId: sid('s1'),
        repoUrl,
        prompt: `tools ${run}`,
        steps: [
          { mcp: 'mcp__jira__get_issue', input: { key: 'LH-1' }, result: '{"key":"LH-1","summary":"Login fails"}' },
          { mcp: 'mcp__jira__search', input: { jql: 'project = LH' }, result: 'Rate limit exceeded', isError: true },
          { mcp: 'mcp__jira__get_issue', input: { key: 'LH-2' }, result: '{"key":"LH-2","summary":"Export"}' },
          { bash: 'ce list --all | head -1', result: 'row-1' },
          { bash: 'find /nonexistent', result: "find: '/nonexistent': No such file or directory", isError: true },
        ],
      },
      { db, userId: owner.id },
    );
    const at = (step: number) => new Date(uploaded.steps[step].toolUseAt.getTime() + 200);
    const body = buildToolCallsLog(
      [
        {
          callId: `${run}-ce`,
          sessionId: sid('s1'),
          tool: 'ce',
          args: ['list', '--all'],
          startedAt: at(3),
          exitCode: 141,
          stdout: 'row-1\nrow-2\nrow-3\n',
          consumerClosed: true,
        },
        {
          callId: `${run}-find`,
          sessionId: sid('s1'),
          tool: 'find',
          args: ['/nonexistent'],
          startedAt: at(4),
          exitCode: 1,
          stderr: "find: '/nonexistent': No such file or directory\n",
        },
      ],
      { hookVersion: '2.27.0', os: 'linux', at: new Date() },
    );
    await uploadToolCallsLog(api, ownerKey, sid('s1'), body, { db, userId: owner.id });
    return uploaded;
  });

  await test.step('4. DD-7: the rebuild drain processes the tree in the background', async () => {
    const summary = await waitForToolUsage(owner.api, repoId, { minCalls: 5 });
    expect(summary.pendingSessions).toBe(0);
  });

  await test.step('5. the tree figures add up, the calls list, call detail (full output vs what the agent saw, `cut`) and «Open in session»', async () => {
    const { body: summary } = await fetchToolSummary(owner.api, repoId);
    expect(summary).not.toBeNull();
    const s = summary!;
    expect({ calls: s.totals.calls, errors: s.totals.errors }).toEqual({ calls: 5, errors: 2 });
    expect({ tools: s.groups.mcp.tools, calls: s.groups.mcp.calls, errors: s.groups.mcp.errors }).toEqual({ tools: 1, calls: 3, errors: 1 });
    expect({ tools: s.groups.cli.tools, calls: s.groups.cli.calls, errors: s.groups.cli.errors }).toEqual({ tools: 2, calls: 2, errors: 1 });
    expect(s.tools.reduce((n, t) => n + t.calls, 0), 'tools add up to the totals').toBe(s.totals.calls);
    for (const t of s.tools) {
      expect(t.operations.reduce((n, o) => n + o.calls, 0), `${t.tool}: operations add up`).toBe(t.calls);
    }
    const jira = s.tools.find((t) => t.channel === 'mcp' && t.tool === 'jira');
    expect(jira?.operations.map((o) => [o.operation, o.calls, o.errors]).sort()).toEqual([
      ['get_issue', 2, 0],
      ['search', 1, 1],
    ]);
    expect(jira?.operations.find((o) => o.operation === 'get_issue')?.retried, 'FR-5: the same call again within 3 calls').toBe(1);
    expect(s.tools.filter((t) => t.channel === 'cli').map((t) => t.tool).sort()).toEqual(['ce', 'find']);
    expect(s.neverCalled).toEqual([]);

    const all = await getCalls(owner);
    expect(all.total, 'the table holds exactly what the tree counts').toBe(5);
    const ce = all.items.find((c) => c.tool === 'ce')!;
    expect(ce).toMatchObject({ channel: 'cli', operation: 'list', status: 'ok', source: 'both', toolUseId: tree.steps[3].toolUseId });
    expect(ce.hints, 'the agent got one line of three: `| head -1`').toContain('cut');
    const find = all.items.find((c) => c.tool === 'find')!;
    expect(find).toMatchObject({ status: 'error', exitCode: 1, source: 'both' });
    expect(all.items.every((c) => c.sessionOwner.email === owner.email)).toBe(true);
    // DD-18: status narrows the table only; the tree keeps its totals.
    expect((await getCalls(owner, { status: 'error' })).total).toBe(2);
    expect((await getCalls(owner, { channel: 'mcp', tool: 'jira', operation: 'get_issue' })).total).toBe(2);
    expect((await getCalls(owner, { q: 'LH-2' })).total, 'search reaches the MCP input').toBe(1);

    const detailRes = await owner.api.get(`${toolsBase}/calls/${ce.usageId}/${encodeURIComponent(ce.callId)}`);
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as CallDetail;
    expect(detail.output.stdout, 'the wrapper captured the full output').toBe('row-1\nrow-2\nrow-3\n');
    expect(detail.output.agentSaw).toBe('row-1');
    expect(detail.output.input).toBe('ce list --all | head -1');
    expect(detail.call.args).toEqual(['list', '--all']);
    expect(detail.link).toEqual({ sessionId: sid('s1'), toolUseId: tree.steps[3].toolUseId });

    const config = await getConfig(owner);
    expect(config.wrapStatus).toMatchObject({ hookVersion: '2.27.0', os: 'linux', preflight: { ok: true } });
    expect(config.tools[0].lastWrapperAt, 'DD-20: the wrapper status names the tool').not.toBeNull();
    expect(config.tools[0].hint).toBeNull();

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoId}?mtab=tools`);
    try {
      await expect(page.getByTestId('tools-tree-all')).toHaveAttribute('title', 'All tools: 5 calls');
      await expect(treeTool(page, 'jira')).toHaveAttribute('title', 'jira: 3 calls');
      await expect(treeTool(page, 'find')).toHaveAttribute('title', 'find: 1 calls');
      await treeTool(page, 'ce').click();
      await expect(page).toHaveURL(/ttool=ce/);
      const rows = page.getByTestId('tools-call-row');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText('cut');
      await rows.first().click();
      const details = page.getByTestId('tools-call-details');
      await expect(details).toBeVisible();
      await expect(page.getByTestId('tools-details-meta')).toContainText(owner.email);
      const output = page.getByTestId('tools-output-view');
      await expect(output).toContainText('row-3');
      await page.getByTestId('tools-output-tab-agent').click();
      await expect(output).toContainText('row-1');
      await expect(output).not.toContainText('row-3');

      const open = page.getByTestId('tools-open-in-session');
      await expect(open).toHaveAttribute('href', new RegExp(`tu=${tree.steps[3].toolUseId}`));
      await open.click();
      await expect(page).toHaveURL(new RegExp(`session=${sid('s1')}`));
      await expect(page).toHaveURL(/tab=logs/);
      await expect(logTurns(page).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  await test.step('6. a second session without wrapper records: its `ce` call is transcript-only, «no wrapper»', async () => {
    await uploadToolSessionTree(
      api,
      ownerKey,
      { sessionId: sid('s2'), repoUrl, prompt: `no wrapper ${run}`, steps: [{ bash: 'ce status', result: 'all clean' }] },
      { db, userId: owner.id },
    );
    await waitForToolUsage(owner.api, repoId, { minCalls: 6 });
    const ceCalls = await getCalls(owner, { channel: 'cli', tool: 'ce' });
    expect(ceCalls.total).toBe(2);
    const plain = ceCalls.items.find((c) => c.sessionId === sid('s2'))!;
    expect(plain).toMatchObject({ operation: 'status', status: 'ok', source: 'transcript' });
    expect(plain.hints).toContain('no_wrapper');

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoId}?mtab=tools&tch=cli&ttool=ce`);
    try {
      const rows = page.getByTestId('tools-call-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: 'no wrapper' })).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  await test.step('6b. the session detail Tools/MCP tab: `sessionId` narrows the summary and the calls to one session tree, whole session', async () => {
    const summaryFor = async (sessionId: string) => {
      const res = await owner.api.get(`${toolsBase}/summary`, { params: { sessionId } });
      expect(res.status()).toBe(200);
      return (await res.json()) as ToolUsageSummary;
    };
    expect((await summaryFor(sid('s1'))).totals.calls, 'the first tree: 3 MCP + 2 CLI calls').toBe(5);
    expect((await summaryFor(sid('s2'))).totals.calls).toBe(1);
    expect((await summaryFor(`no-such-session-${run}`)).totals.calls).toBe(0);
    const s2Calls = await getCalls(owner, { sessionId: sid('s2') });
    expect(s2Calls.total).toBe(1);
    expect(s2Calls.items[0]).toMatchObject({ tool: 'ce', sessionId: sid('s2') });

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoId}?session=${sid('s2')}`);
    try {
      await page.getByTestId('tab-session-tools').click();
      await expect(page).toHaveURL(/tab=tools/);
      const tab = page.getByTestId('session-tools-tab');
      await expect(tab.getByTestId('tools-tree-all')).toHaveAttribute('title', 'All tools: 1 calls');
      await expect(tab.getByTestId('tools-call-row')).toHaveCount(1);
      await expect(tab.getByTestId('tools-date-range'), 'one session: no date range').toHaveCount(0);
      await expect(tab.getByTestId('tools-monitored-button'), 'the config is edited on the repo tab').toHaveCount(0);
      await tab.getByTestId('tools-call-row').first().click();
      await expect(page).toHaveURL(/tcall=/);
      await expect(page.getByTestId('tools-call-details')).toBeVisible();
      // Leaving the tab drops its `t*` params (the selected call means nothing elsewhere).
      await page.getByTestId('tab-session-info').click();
      await expect(page).not.toHaveURL(/tcall=/);
    } finally {
      await context.close();
    }
  });

  await test.step('7. DD-17 visibility: a team member sees the calls in the team view read-only; a non-team developer sees none of them', async () => {
    const teamSummary = await fetchToolSummary(member.api, repoId, teamId);
    expect(teamSummary.status).toBe(200);
    expect(teamSummary.body?.totals.calls, 'transparent team: the owner’s calls').toBe(6);
    const teamConfig = await getConfig(member, teamId);
    expect({ level: teamConfig.level, canEdit: teamConfig.canEdit }).toEqual({ level: 'team', canEdit: false });
    const memberPut = await member.api.put(`${toolsBase}/config`, {
      params: { teamId },
      data: { paused: false, tools: [] },
    });
    expect(memberPut.status(), 'only the team owner edits the team list').toBe(403);
    expect((await member.api.get(`${toolsBase}/summary`)).status(), 'not the member’s own repository row').toBe(403);

    const { context, page } = await browserAs(browser, stand.url, member, `/#/teams/${teamId}/repos/${repoId}?mtab=tools`);
    try {
      await expect(page.getByTestId('tools-tree-all')).toHaveAttribute('title', 'All tools: 6 calls');
      await page.getByTestId('tools-monitored-button').click();
      await expect(page.getByTestId('tools-config-readonly')).toHaveText('Managed by team owner.');
      await expect(page.getByTestId('tools-config-save')).toHaveCount(0);
    } finally {
      await context.close();
    }

    // The outsider is in no team: the owner's repository is closed to them with and without teamId.
    const queries: Array<Record<string, number>> = [{}, { teamId }];
    for (const query of queries) {
      expect((await outsider.api.get(`${toolsBase}/summary`, { params: query })).status()).toBe(403);
      expect((await outsider.api.get(`${toolsBase}/calls`, { params: query })).status()).toBe(403);
      expect((await outsider.api.get(`${toolsBase}/config`, { params: query })).status()).toBe(403);
    }
    // Their own row for the same URL shows only their own sessions: none of the owner's calls.
    await uploadPromptSession(api, outsiderKey, { sessionId: sid('outsider'), prompt: `outsider ${run}`, repoUrl }, { db, userId: outsider.id });
    const outsiderRepo = await ownRepoId(outsider.api, repoUrl);
    const own = await waitForToolUsage(outsider.api, outsiderRepo, { minCalls: 0 });
    expect(own.totals.calls).toBe(0);
    const { items } = await getCalls(owner, { channel: 'cli', tool: 'ce' });
    const foreign = await outsider.api.get(
      `/api/v1/repositories/${outsiderRepo}/tool-monitoring/calls/${items[0].usageId}/${encodeURIComponent(items[0].callId)}`,
    );
    expect(foreign.status(), 'another user’s call is not found through one’s own row').toBe(404);
  });
});
