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
// Step 9 (2026-11-23-session-logs-streaming, DD-26) runs the source hook's Stop against the stand
// on a throwaway project whose wrapper files it writes itself: the old manifest records only the
// summed size of a session's wrapper files, so a same-size rewrite is seen only by the v2
// manifest's fingerprint, and the hook re-sends the `tool-calls` log.
//
// Replaces: none (new functionality).
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  copyToolDir,
  makeFakeGitRepo,
  makeFakeHome,
  readHookLog,
  readManifest,
  runHook,
  telemetryDir,
  tempDirs,
  workDir,
  writeStandConfig,
} from '../helpers/hook-process';
import { storedBody } from '../helpers/ingest';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { waitForQueueIdle } from '../helpers/queue';
import { logTurns, selectSessionTab } from '../helpers/session-view';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept } from '../helpers/teams';
import {
  buildToolCallsLog,
  fetchToolSummary,
  uploadToolCallsLog,
  uploadToolSessionTree,
  waitForToolUsage,
  type ToolSessionTree,
  type ToolUsageSummary,
  type WrapperCallSpec,
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
      // The button opens the settings' Monitored Tools tab, without the Tools/MCP tab's `t*` params.
      await page.getByTestId('tools-monitored-button').click();
      await expect(page).toHaveURL(/mtab=settings&stab=monitored-tools/);
      await expect(page.getByTestId('tab-settings-monitored-tools')).toHaveAttribute('data-state', 'active');
      const panel = page.getByTestId('tools-monitored-settings');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('tools-config-capture'), 'a monitored tool is always captured in full').toHaveCount(0);
      await panel.getByTestId('tools-config-add').click();
      const name = panel.getByTestId('tools-config-name').last();
      await name.fill('bash');
      await name.blur();
      await expect(panel.getByTestId('tools-config-error')).toHaveText("`bash` is the agent's shell and cannot be monitored");
      await name.fill('ce');
      await expect(panel.getByTestId('tools-config-error')).toHaveCount(0);
      await panel.getByTestId('tools-config-save').click();
      await expect(panel.getByTestId('tools-config-save'), 'saved: nothing left to save').toBeDisabled();
      await page.getByTestId('tab-repo-tools').click();
      // Monitored but not called yet: the tree lists it as «never called».
      await expect(page.getByTestId('tools-tree-never-called')).toHaveAttribute('title', /^ce: /);
      await expect(page.getByTestId('tools-monitored-button')).toContainText('Monitored tools (1)');

      await page.goto(`/#/teams/${teamId}/repos/${repoId}?mtab=settings&stab=monitored-tools`);
      await page.reload();
      await expect(panel).toContainText('for every member of this team');
      await panel.getByTestId('tools-config-add').click();
      await panel.getByTestId('tools-config-name').last().fill('find');
      await panel.getByTestId('tools-config-save').click();
      await expect(panel.getByTestId('tools-config-save')).toBeDisabled();
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

  /** Session `s1`'s two wrapper records (`ce`, `find`), started 200 ms after their Bash tool_use. */
  const wrapperCalls = (t: ToolSessionTree): WrapperCallSpec[] => {
    const at = (step: number) => new Date(t.steps[step].toolUseAt.getTime() + 200);
    return [
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
    ];
  };

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
    const body = buildToolCallsLog(wrapperCalls(uploaded), { hookVersion: '2.27.0', os: 'linux', at: new Date() });
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

      // Another tool drops the selected call: the details pane waits for a call of the new list.
      await treeTool(page, 'find').click();
      await expect(page).toHaveURL(/ttool=find/);
      await expect(page).not.toHaveURL(/tcall=/);
      await expect(details).toHaveCount(0);
      await treeTool(page, 'ce').click();
      await rows.first().click();
      await expect(details).toBeVisible();

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
      await selectSessionTab(page, 'tools');
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
      await selectSessionTab(page, 'info');
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

  await test.step('8. GH-149: an outdated Windows hook gets the update hint', async () => {
    // The server keeps one `tool-calls` log per session, so a re-upload replaces it; the status
    // merge keeps the newest `reportedAt`, so every re-upload carries a fresh `at`.
    const reupload = async (hookVersion: string) => {
      const body = buildToolCallsLog(wrapperCalls(tree), { hookVersion, os: 'win32', at: new Date() });
      await uploadToolCallsLog(api, ownerKey, sid('s1'), body, { db, userId: owner.id });
      await expect
        .poll(async () => (await getConfig(owner)).wrapStatus?.hookVersion ?? null, { timeout: 30_000 })
        .toBe(hookVersion);
    };

    await reupload('2.32.1');
    const outdated = await getConfig(owner);
    expect(outdated.wrapStatus).toMatchObject({ hookVersion: '2.32.1', os: 'win32' });
    expect(outdated.tools[0].name).toBe('ce');
    expect(outdated.tools[0].hint, 'Windows hook older than 2.32.2').toBe('hook_too_old');

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoId}?mtab=tools`);
    try {
      await page.getByTestId('tools-monitored-button').click();
      await expect(page).toHaveURL(/mtab=settings&stab=monitored-tools/);
      const panel = page.getByTestId('tools-monitored-settings');
      const rows = panel.getByTestId('tools-config-row');
      await expect(rows, 'the personal list: `ce` only').toHaveCount(1);
      await expect(rows.first().getByTestId('tools-config-name')).toHaveValue('ce');
      await expect(rows.first().getByTestId('tools-config-status')).toHaveText('hook too old — update the hook');
    } finally {
      await context.close();
    }

    await reupload('2.32.2');
    expect((await getConfig(owner)).tools[0].hint, 'the fixed hook: no hint').toBeNull();
  });

  await test.step('9. DD-26: the hook re-sends a `tool-calls` log whose wrapper record was rewritten at the same size; an unchanged one is skipped', async () => {
    const hkSid = sid('hook');
    await uploadToolSessionTree(
      api,
      ownerKey,
      { sessionId: hkSid, repoUrl, prompt: `hook tools ${run}`, steps: [{ bash: 'ce list', result: 'result-one' }] },
      { db, userId: owner.id },
    );
    const dirs = tempDirs();
    try {
      const toolDir = copyToolDir(dirs);
      const repo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:scn/${run}/tools.git` });
      const home = makeFakeHome(dirs);
      writeStandConfig(repo, stand.url, ownerKey);
      // What the CLI tool wrapper writes per call (tool-wrap-records.js): a records file and the
      // captured stdout, under <workDir>/tool-wrap/<sessionId>/calls/.
      const calls = path.join(workDir(repo), 'tool-wrap', hkSid, 'calls');
      fs.mkdirSync(calls, { recursive: true });
      const startedAtMs = Date.now() - 60_000;
      fs.writeFileSync(
        path.join(calls, 'hk1.jsonl'),
        [
          { type: 'start', callId: 'hk1', sessionId: hkSid, tool: 'ce', args: ['list'], real: '/usr/local/bin/ce', cwd: repo, shell: 'bash', capture: 'full', startedAtMs },
          { type: 'exit', callId: 'hk1', endedAtMs: startedAtMs + 150, exitCode: 0 },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n') + '\n',
      );
      const outFile = path.join(calls, 'hk1.out');
      fs.writeFileSync(outFile, 'result-one\n');
      const key = `tool-calls/${hkSid}`;
      const stop = async () => {
        const res = await runHook(toolDir, { hook_event_name: 'Stop', session_id: `r17-${run}-stop`, cwd: repo }, { home });
        expect(res.code, res.stderr).toBe(0);
        await waitForQueueIdle(db, owner.id);
      };
      const sends = () => readHookLog(repo, 'send-logs-hook.js').filter((l) => l.includes(`${key}: uploaded`)).length;
      const storedStdout = async () => {
        const body = (await storedBody(db, hkSid, 'tool-calls')) ?? [];
        const line = body.find((l): l is { callId: string; stdout?: string } => typeof l === 'object' && l !== null && (l as { callId?: string }).callId === 'hk1');
        return line?.stdout ?? null;
      };

      await stop();
      expect(sends(), 'first Stop sends the tool-calls log').toBe(1);
      expect(await storedStdout()).toBe('result-one\n');
      const oldManifestSize = readManifest(telemetryDir(repo)).get(key);
      expect(oldManifestSize).toBeGreaterThan(0);

      await stop();
      expect(sends(), 'unchanged wrapper files: skipped').toBe(1);

      // Same length, new content, a later mtime: the old manifest's Σ(size+1) cannot see it, the
      // v2 fingerprint can.
      fs.writeFileSync(outFile, 'result-two\n');
      const later = new Date(Date.now() + 5_000);
      fs.utimesSync(outFile, later, later);
      await stop();
      expect(sends(), 'a same-size rewrite is re-sent').toBe(2);
      expect(readManifest(telemetryDir(repo)).get(key), 'the old manifest size did not change').toBe(oldManifestSize);
      expect(await storedStdout()).toBe('result-two\n');
    } finally {
      dirs.cleanup();
    }
  });
});
