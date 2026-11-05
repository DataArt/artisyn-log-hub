// S-OTEL-02. The OTEL Live view (task 2026-11-04 otel-live-view, impl-plan «Test coverage plan»,
// chunk 11): the `Live` header entry, its 90 % modal, the user-wide node tree (teams, No team,
// repositories, sessions), the selected node's view, live updates, Pause / Resume, the ended
// state, the details panel, «Open session ↗», team access and prompt masking, and the refresh
// failure banner. Live is a feature no existing scenario covers; it does not depend on the auth
// mode → mode A. AC-12 (nothing live → empty status) is covered by the contract rows in
// server/test/contract/registry/f25-otel.ts.
//
// Data: synthetic OTEL lines (tests/scenarios/fixtures/otel/otel-lines.ts). Every session is one
// main-thread call uploaded as a regular `claude-otel` chunk, so its `chunk_last_at` (upload time,
// server clock) makes it live; later updates come through the realtime channel.
//
// Setup (one owner, two teams, a personal repository):
//   - restricted team R (owner, manager, plain member) with repositories A and S;
//   - transparent team T (owner only) with repository S — S is linked to both teams;
//   - owner: «shared» in S (0.20), «otelonly» in A with only the artisyn log (0.07),
//     «personal» in P, linked to no team (0.05), «old» in P aged past the live window (0.09);
//   - manager: «mgr» in A (0.30); member: «mem» in A (0.40).
//
// Code facts that differ from the design text:
//   - the modal polls every OTEL_SESSION_POLL_MS (5 s), so «a value changes within 5 s» is
//     checked with one poll interval of slack (10 s);
//   - the header status polls every OTEL_REPO_POLL_MS (30 s): «the dot updates while paused» is
//     one status request made while no live request is;
//   - the steps run for several minutes, longer than OTEL_SESSION_ENDED_MS (10 min) in a slow
//     run, so `keepLive` stamps `chunk_last_at = now()` on the sessions that should stay live —
//     what the hook's next chunk upload would do.
import type { Page, Request } from '@playwright/test';
import { randomBytes } from 'crypto';
import { test, expect, type ScenarioUser } from '../fixtures';
import { apiRequestLine, micros, MODEL_A, plus } from '../fixtures/otel/otel-lines';
import { createApiKey } from '../helpers/api-key';
import { otelUsd, sendRealtime, sessionOtel, uploadOtelChunk, uploadTranscript, waitForOtelProjected } from '../helpers/otel';
import { ownRepoId } from '../helpers/prompt-session';
import { addTeamRepo, createTeam, inviteAndAccept, setMemberRoles, skipNewUserNudge } from '../helpers/teams';

// ---------------------------------------------------------------------------------------------
// The Live routes (types: server/src/logs/otel/otel-live.types.ts), the fields the steps read
// ---------------------------------------------------------------------------------------------

interface LiveTotals {
  costUsdMicros: string;
  inputTokens: string;
  calls: number;
  liveSessions: number;
  liveAgents: number;
}

interface LiveNode {
  key: string;
  type: 'home' | 'team' | 'noteam' | 'repo' | 'session' | 'agent';
  parentKey: string | null;
  label: string;
  live: boolean;
  inTree: boolean;
  restricted: boolean;
  teamId: number | null;
  repoId: number | null;
  rootId: number | null;
  sessionUuid: string | null;
  userEmail: string | null;
  totals: LiveTotals;
}

interface LiveResponse {
  selected: string;
  nodes: LiveNode[];
  view: {
    breakdown: LiveNode[];
    costPerMinUsdMicros: string;
    flows: { rootId: number; model: string; agentKey: string | null; costUsdMicros: string; tokens: string }[];
  };
  details: { key: string; firstPrompt: string | null; attributesMasked: boolean } | null;
}

interface LiveStatus {
  live: boolean;
  liveSessions: number;
  liveAgents?: number;
  costUsdMicros?: string;
  spark?: { minutes: number; tokens: number[]; costUsdMicros: string[] };
}

async function liveApi(user: ScenarioUser, q: { node?: string; panel?: string } = {}): Promise<LiveResponse> {
  const p = new URLSearchParams({ tz: 'UTC' });
  if (q.node) p.set('node', q.node);
  if (q.panel) p.set('panel', q.panel);
  const res = await user.api.get(`/api/v1/otel/live?${p.toString()}`);
  expect(res.status(), `live of ${user.email}: ${await res.text()}`).toBe(200);
  return (await res.json()) as LiveResponse;
}

async function liveStatus(user: ScenarioUser): Promise<LiveStatus> {
  const res = await user.api.get('/api/v1/otel/live/status');
  expect(res.status(), `live status of ${user.email}: ${await res.text()}`).toBe(200);
  return (await res.json()) as LiveStatus;
}

function nodeOf(res: LiveResponse, key: string): LiveNode {
  const n = res.nodes.find((x) => x.key === key) ?? res.view.breakdown.find((x) => x.key === key);
  if (!n) throw new Error(`no live node ${key}; have ${res.nodes.map((x) => x.key).join(', ')}`);
  return n;
}

function homeOf(res: LiveResponse): LiveNode {
  return nodeOf(res, 'home');
}

/** The `?live=` value of the hash route (`#/path?live=…`), or null. */
function liveParam(page: Page): string | null {
  const hash = new URL(page.url()).hash;
  const i = hash.indexOf('?');
  return i < 0 ? null : new URLSearchParams(hash.slice(i + 1)).get('live');
}

function hashParam(page: Page, name: string): string | null {
  const hash = new URL(page.url()).hash;
  const i = hash.indexOf('?');
  return i < 0 ? null : new URLSearchParams(hash.slice(i + 1)).get(name);
}

function treeNode(page: Page, key: string) {
  return page.locator(`[data-testid="live-tree-node"][data-key="${key}"]`);
}

/** Selects a tree node: the row's label button (the second one is the ⓘ). */
async function selectNode(page: Page, key: string): Promise<void> {
  await treeNode(page, key).getByTestId('live-tree-select').click();
  await expect(page.getByTestId('live-view')).toHaveAttribute('data-key', key, { timeout: 15_000 });
}

/** Counts the requests of the Live routes a page sends. */
function countLiveRequests(page: Page): { live(): number; status(): number } {
  let live = 0;
  let status = 0;
  page.on('request', (r: Request) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/v1/otel/live') live++;
    if (u.pathname === '/api/v1/otel/live/status') status++;
  });
  return { live: () => live, status: () => status };
}

async function openLive(page: Page, user: ScenarioUser, path: string): Promise<void> {
  await skipNewUserNudge(page.context());
  await user.signIn(page);
  await page.goto(path);
  await page.reload();
  await page.getByTestId('nav-live').click();
  await expect(page.getByTestId('live-modal')).toBeVisible({ timeout: 20_000 });
  await expect(treeNode(page, 'home')).toBeVisible({ timeout: 20_000 });
}

interface Person {
  user: ScenarioUser;
  apiKey: string;
}

test('@S-OTEL-02 Live view: header entry, user-wide tree, node view, live updates, pause, ended, details, access and masking @mode-a', async ({ api, db, users, page, browser }) => {
  test.setTimeout(600_000);
  const run = randomBytes(4).toString('hex');
  const urlA = `https://git.arrakis.test/scn/${run}/live-a`;
  const urlS = `https://git.arrakis.test/scn/${run}/live-shared`;
  const urlP = `https://git.arrakis.test/scn/${run}/live-personal`;
  const base = new Date(Date.now() - 5 * 60_000);
  const person = async (label: string): Promise<Person> => {
    const user = await users.user('user', { label: `otel02-${label}` });
    return { user, apiKey: (await createApiKey(user.api)).key };
  };
  const owner = await person('owner');
  const manager = await person('mgr');
  const member = await person('mem');
  const prompt = (name: string) => `${name} live prompt ${run}`;

  /** One live session with one main call of `usd`; `only: 'artisyn'` = no claude transcript. */
  const session = async (p: Person, name: string, url: string, usd: number, only?: 'artisyn'): Promise<string> => {
    const sid = `otel02-${run}-${name}`;
    const req = `${name}${run}-req`;
    const queue = { db, userId: p.user.id };
    await uploadTranscript(api, p.apiKey, { sessionId: sid, prompt: prompt(name), repoUrls: [url], branch: 'main', at: base, requestIds: [req] }, queue, only);
    await uploadOtelChunk(api, p.apiKey, sid, [apiRequestLine(sid, { requestId: req, querySource: 'repl_main_thread', model: MODEL_A, at: plus(base, 30), costUsd: usd, input: 1000, output: 100, cacheRead: 500 })], queue);
    await waitForOtelProjected(db, sid);
    return sid;
  };
  const rootIdOf = async (sid: string): Promise<number> => {
    const { rows } = await db.query<{ id: number }>('SELECT id FROM sessions WHERE session_id = $1', [sid]);
    if (rows.length === 0) throw new Error(`no session ${sid}`);
    return rows[0].id;
  };
  const age = async (sid: string): Promise<void> => {
    await db.query(
      `UPDATE otel_session_state
          SET rt_last_at = rt_last_at - interval '30 minutes', chunk_last_at = chunk_last_at - interval '30 minutes'
        WHERE session_id = (SELECT id FROM sessions WHERE session_id = $1)`,
      [sid],
    );
  };
  const liveSids = new Set<string>();
  const keepLive = async (): Promise<void> => {
    await db.query(
      `UPDATE otel_session_state SET chunk_last_at = now()
        WHERE session_id IN (SELECT id FROM sessions WHERE session_id = ANY($1))`,
      [[...liveSids]],
    );
  };
  let rtSeq = 0;
  const receiver = `rcv-live-${run}`;
  /** One more realtime call of `usd` into the shared session. */
  const realtimeCall = async (sid: string, usd: number): Promise<void> => {
    rtSeq++;
    await sendRealtime(api, owner.apiKey, {
      sessionId: sid,
      receiverId: receiver,
      batchSeq: rtSeq,
      lines: [apiRequestLine(sid, { requestId: `rt${rtSeq}${run}-req`, querySource: 'repl_main_thread', model: MODEL_A, at: new Date(Date.now() - 1_000), costUsd: usd, input: 200, output: 20 })],
    });
  };

  const setup = await test.step('setup: restricted team R (owner, manager, member) with A and S, transparent team T with S, a personal repository P; live sessions by chunk upload, one aged session', async () => {
    const shared = await session(owner, 'shared', urlS, 0.2);
    const otelOnly = await session(owner, 'otelonly', urlA, 0.07, 'artisyn');
    const personal = await session(owner, 'personal', urlP, 0.05);
    const old = await session(owner, 'old', urlP, 0.09);
    const mgr = await session(manager, 'mgr', urlA, 0.3);
    const mem = await session(member, 'mem', urlA, 0.4);
    for (const sid of [shared, otelOnly, personal, mgr, mem]) liveSids.add(sid);
    await age(old);

    const teamR = await createTeam(owner.user, `Live R ${run}`);
    for (const p of [manager, member]) await inviteAndAccept(owner.user, p.user, teamR, 'restricted');
    await setMemberRoles(owner.user, teamR, manager.user.id, { isManager: true });
    await addTeamRepo(owner.user, teamR, urlA);
    await addTeamRepo(owner.user, teamR, urlS);
    const teamT = await createTeam(owner.user, `Live T ${run}`);
    expect((await owner.user.api.patch(`/api/v1/teams/${teamT}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
    await addTeamRepo(owner.user, teamT, urlS);
    await keepLive();

    return {
      teamR,
      teamT,
      sid: { shared, otelOnly, personal, old, mgr, mem },
      root: {
        shared: await rootIdOf(shared),
        otelOnly: await rootIdOf(otelOnly),
        personal: await rootIdOf(personal),
        old: await rootIdOf(old),
        mgr: await rootIdOf(mgr),
        mem: await rootIdOf(mem),
      },
      ownerRepoP: await ownRepoId(owner.user.api, urlP),
      ownerRepoS: await ownRepoId(owner.user.api, urlS),
    };
  });
  const { teamR, teamT, sid, root, ownerRepoP, ownerRepoS } = setup;
  const homeMicros = micros(0.2) + micros(0.07) + micros(0.05) + micros(0.3) + micros(0.4);
  // The tree also lists the recently ended «old» (0.09); the header status stays live-only.
  const treeHomeMicros = homeMicros + micros(0.09);
  const personalRepoKey = `repo:${ownerRepoP}@noteam`;

  await test.step('AC-1, AC-2, AC-4. the header dot shows within 30 s; a click opens a ~90 % dialog at live=home with Home selected; ?live=repo:<id> survives a reload; Back closes the modal', async () => {
    const status = await liveStatus(owner.user);
    expect(status).toMatchObject({ live: true, liveSessions: 5, costUsdMicros: String(homeMicros) });
    // Header sparkline: 15 one-minute points; the setup calls (~5 min old) are in it, unless a
    // slow setup pushed them past 15 min — so only «some tokens, no more cost than home».
    expect(status.spark?.minutes).toBe(15);
    expect(status.spark?.tokens).toHaveLength(15);
    expect(status.spark!.tokens.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(status.spark!.costUsdMicros.reduce((a, b) => a + Number(b), 0)).toBeLessThanOrEqual(homeMicros);

    await skipNewUserNudge(page.context());
    await owner.user.signIn(page);
    await page.goto(`/#/repos/${ownerRepoP}`);
    // The first status fetch happens on load.
    await page.reload();
    await expect(page.getByTestId('nav-live-dot')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('nav-live')).toHaveAttribute('data-live', 'true');
    // 100 px button: the dot plus the token sparkline; hovering shows the last-minutes summary.
    await expect(page.getByTestId('nav-live-spark')).toBeVisible();
    await page.getByTestId('nav-live').hover();
    const tip = page.getByTestId('nav-live-tooltip').first();
    await expect(tip).toContainText('Last 15 min:');
    await expect(tip).toContainText('tokens');
    await expect(tip).toContainText('Click for details');

    await page.getByTestId('nav-live').click();
    const modal = page.getByTestId('live-modal');
    await expect(modal).toBeVisible();
    expect(liveParam(page)).toBe('home');
    await expect(treeNode(page, 'home').locator('button[aria-current="true"]')).toHaveCount(1, { timeout: 20_000 });
    const viewport = page.viewportSize()!;
    await expect
      .poll(async () => {
        const box = await modal.boundingBox();
        return box ? [Math.round((box.width / viewport.width) * 100), Math.round((box.height / viewport.height) * 100)] : null;
      }, { message: 'the dialog is 90 % × 90 % of the viewport' })
      .toEqual([90, 90]);

    await page.goBack();
    await expect(modal).toHaveCount(0);
    expect(liveParam(page)).toBeNull();

    await page.goto(`/#/repos/${ownerRepoP}?live=${encodeURIComponent(personalRepoKey)}`);
    await page.reload();
    await expect(page.getByTestId('live-view')).toHaveAttribute('data-key', personalRepoKey, { timeout: 20_000 });
    expect(liveParam(page)).toBe(personalRepoKey);
    await expect(page.getByTestId('live-view-title')).toHaveText(urlP);
    await page.getByTestId('live-close').click();
    await expect(modal).toHaveCount(0);
    expect(liveParam(page)).toBeNull();
  });

  await test.step('AC-3, AC-3a, AC-3b. the session in S sits under both teams, home counts it once, the personal session sits under No team, a recently ended session is listed greyed and counts in the sums but not in the live counts or the header status', async () => {
    await keepLive();
    const res = await liveApi(owner.user);
    expect(res.selected).toBe('home');
    const sharedNodes = res.nodes.filter((n) => n.type === 'session' && n.rootId === root.shared);
    expect(sharedNodes.map((n) => n.key).sort()).toEqual([`session:${root.shared}@${teamR}`, `session:${root.shared}@${teamT}`].sort());
    for (const n of sharedNodes) {
      const repo = nodeOf(res, n.parentKey!);
      expect(repo).toMatchObject({ type: 'repo', label: urlS, teamId: n.teamId });
      expect(repo.parentKey).toBe(`team:${n.teamId}`);
      expect(n.totals.costUsdMicros).toBe(String(micros(0.2)));
    }
    expect(nodeOf(res, `team:${teamT}`).totals.costUsdMicros).toBe(String(micros(0.2)));
    expect(nodeOf(res, `team:${teamR}`).totals.costUsdMicros).toBe(String(homeMicros - micros(0.05)));
    expect(homeOf(res).totals).toMatchObject({ costUsdMicros: String(treeHomeMicros), liveSessions: 5 });

    const personal = nodeOf(res, `session:${root.personal}@noteam`);
    expect(personal).toMatchObject({ teamId: null, parentKey: personalRepoKey, userEmail: owner.user.email });
    expect(personal.label).toBe(`${owner.user.email} · ${prompt('personal')}`);
    expect(nodeOf(res, personalRepoKey).parentKey).toBe('noteam');
    expect(nodeOf(res, 'noteam').totals.costUsdMicros).toBe(String(micros(0.05) + micros(0.09)));

    // «old» ended 30 min ago — inside OTEL_LIVE_RECENT_MS (2 h) — so it and its agent are listed
    // ended; every other node is live.
    const oldKey = `session:${root.old}@noteam`;
    const oldNodes = res.nodes.filter((n) => n.rootId === root.old);
    expect(oldNodes.length, 'the ended session and its agent').toBeGreaterThan(1);
    for (const n of oldNodes) expect(n, n.key).toMatchObject({ live: false, inTree: true });
    expect(nodeOf(res, oldKey).totals).toMatchObject({ costUsdMicros: String(micros(0.09)), liveSessions: 0, liveAgents: 0 });
    expect(res.nodes.filter((n) => !n.live && n.rootId !== root.old).map((n) => n.key), 'only «old» is ended').toEqual([]);

    await openLive(page, owner.user, `/#/repos/${ownerRepoP}`);
    await expect(treeNode(page, 'home')).toContainText(otelUsd(treeHomeMicros));
    await expect(treeNode(page, `session:${root.shared}@${teamR}`)).toBeVisible();
    await expect(treeNode(page, `session:${root.shared}@${teamT}`)).toBeVisible();
    await expect(treeNode(page, `session:${root.personal}@noteam`)).toBeVisible();
    await expect(treeNode(page, 'noteam')).toContainText('No team');
    await expect(treeNode(page, oldKey)).toHaveAttribute('data-live', 'false');
    await expect(treeNode(page, oldKey)).toContainText('ended');
    const oldAgents = page.locator(`[data-testid="live-tree-node"][data-key^="agent:${root.old}:"]`);
    await expect(oldAgents.first()).toHaveAttribute('data-live', 'false');
    // The chevron really collapses a session's agents and expands them again.
    const oldToggle = treeNode(page, oldKey).getByTestId('live-tree-toggle');
    await expect(oldToggle).toHaveAttribute('aria-expanded', 'true');
    await oldToggle.click();
    await expect(oldAgents).toHaveCount(0);
    await expect(oldToggle).toHaveAttribute('aria-expanded', 'false');
    expect(liveParam(page), 'collapsing does not select').not.toBe(oldKey);
    await oldToggle.click();
    await expect(oldAgents.first()).toBeVisible();

    // The last carousel page splits Home by team / repository / user: three doughnuts, the
    // personal and «old» sessions under No team next to the team ones.
    const carousel = page.getByTestId('live-chart-carousel');
    await page.getByTestId('live-chart-prev').click();
    await expect(carousel).toHaveAttribute('data-page', 'share');
    const pies = carousel.getByTestId('live-share-pie');
    await expect(pies).toHaveCount(3);
    await expect(pies.nth(0)).toHaveAttribute('data-dimension', 'team');
    await expect(pies.nth(0).getByTestId('live-share-legend-item').filter({ hasText: 'No team' })).toHaveCount(1);
    expect(Number(await pies.nth(0).getAttribute('data-slices'))).toBeGreaterThanOrEqual(2);
    await expect(pies.nth(2).getByTestId('live-share-legend-item').filter({ hasText: owner.user.email })).toHaveCount(1);
  });

  const repoAKey = await test.step('AC-5, AC-6. a selected repository shows the tiles, the FR-5 breakdown columns and the cost and tokens charts; the OTEL-only session is listed; after a realtime call the session’s Live cost = its session OTEL tab cost', async () => {
    await keepLive();
    const res = await liveApi(owner.user);
    const repoA = res.nodes.find((n) => n.type === 'repo' && n.teamId === teamR && n.label === urlA);
    expect(repoA, 'repository A under team R').toBeTruthy();
    await selectNode(page, repoA!.key);
    expect(liveParam(page)).toBe(repoA!.key);

    for (const id of ['live-kpi-cost', 'otel-kpi-tokens', 'live-kpi-live', 'live-kpi-cost-rate']) {
      await expect(page.getByTestId('live-kpi-tiles').getByTestId(id), id).toBeVisible();
    }
    await expect(page.getByTestId('live-kpi-cost')).toContainText(otelUsd(micros(0.07) + micros(0.3) + micros(0.4)));
    await expect(page.getByTestId('live-breakdown-table').locator('thead th')).toHaveText(['Name', 'Cost', 'In', 'Out', 'Cache R', 'Cache W', 'Calls', 'Running', 'Last activity']);
    const carousel = page.getByTestId('live-chart-carousel');
    await expect(carousel).toHaveAttribute('data-page', 'cost');
    await expect(carousel.getByTestId('otel-cost-chart')).toBeVisible();
    await page.getByTestId('live-chart-next').click();
    await expect(carousel).toHaveAttribute('data-page', 'tokens');
    await expect(carousel.getByTestId('otel-cost-chart')).toBeVisible();

    // The sankey: a repository flows cost model → user → session; its rows are the API's
    // root × model rows of the 2 h window and sum to the window cost of its sessions.
    const flow = page.getByTestId('live-flow');
    await expect(flow).toContainText('Cost flow');
    await expect(flow).toContainText('model → user → session');
    await expect(flow.getByTestId('otel-flow-band').first()).toBeVisible();
    const repoView = await liveApi(owner.user, { node: repoA!.key });
    expect(repoView.view.flows.length).toBeGreaterThan(0);
    expect(repoView.view.flows.every((f) => f.agentKey === null)).toBe(true);
    // A session flows tokens model → agent; an agent has no sankey.
    const sessionView = await liveApi(owner.user, { node: `session:${root.mem}@${teamR}` });
    expect(sessionView.view.flows.length).toBeGreaterThan(0);
    expect(sessionView.view.flows.every((f) => f.rootId === root.mem)).toBe(true);
    expect(sessionView.view.flows.some((f) => f.agentKey !== null && BigInt(f.tokens) > 0n), 'a per-agent token row').toBe(true);

    // AC-6: the session with OTEL data and only its artisyn log (no claude transcript) is listed.
    const otelOnlyRow = page.locator(`[data-testid="live-breakdown-row"][data-key="session:${root.otelOnly}@${teamR}"]`);
    await expect(otelOnlyRow).toContainText(prompt('otelonly'));
    await expect(otelOnlyRow).toContainText(otelUsd(micros(0.07)));

    // DD-22: the stored totals follow the realtime write and equal the session tab (Σ otel_calls).
    await realtimeCall(sid.shared, 0.05);
    const expected = micros(0.2) + micros(0.05);
    const tab = await sessionOtel(owner.user, ownerRepoS, sid.shared);
    expect(Number(tab.kpis!.totalCostUsdMicros)).toBe(expected);
    const after = await liveApi(owner.user);
    for (const teamId of [teamR, teamT]) {
      expect(nodeOf(after, `session:${root.shared}@${teamId}`).totals.costUsdMicros).toBe(tab.kpis!.totalCostUsdMicros);
    }
    expect(homeOf(after).totals.costUsdMicros).toBe(String(treeHomeMicros + micros(0.05)));
    return repoA!.key;
  });

  const sharedKey = `session:${root.shared}@${teamR}`;
  await test.step('AC-7, AC-8. a realtime call shows within one poll; Pause freezes the view while the header status still polls; Resume shows the latest; the aged session shows «ended»', async () => {
    await keepLive();
    await selectNode(page, sharedKey);
    const cost = page.getByTestId('live-kpi-cost');
    await expect(cost).toContainText(otelUsd(micros(0.2) + micros(0.05)));

    const sentAt = Date.now();
    await realtimeCall(sid.shared, 0.1);
    await expect(cost).toContainText(otelUsd(micros(0.35)), { timeout: 10_000 });
    expect(Date.now() - sentAt, 'one 5 s poll plus slack').toBeLessThan(10_000);
    // The tree row whose cost grew on this poll flashes (until the next poll without growth).
    await expect(treeNode(page, sharedKey)).toHaveAttribute('data-ticked', 'true');

    const counts = countLiveRequests(page);
    await page.getByTestId('live-pause').click();
    await expect(page.getByTestId('live-paused-badge')).toContainText('Paused at');
    const before = counts.live();
    await realtimeCall(sid.shared, 0.1);
    // LIVE_STATUS_POLL_MS is 10 s: the header status polls on while the modal is paused.
    await page.waitForRequest((r) => new URL(r.url()).pathname === '/api/v1/otel/live/status', { timeout: 20_000 });
    expect(counts.live(), 'no live poll while paused').toBe(before);
    await expect(cost).toContainText(otelUsd(micros(0.35)));
    await expect(page.getByTestId('nav-live-dot')).toBeVisible();

    await page.getByTestId('live-resume').click();
    await expect(page.getByTestId('live-paused-badge')).toHaveCount(0);
    await expect(cost).toContainText(otelUsd(micros(0.45)), { timeout: 10_000 });

    // AC-8: the selected session aged past OTEL_SESSION_ENDED_MS stays on screen as ended (DD-5).
    liveSids.delete(sid.shared);
    await age(sid.shared);
    await keepLive();
    await expect(page.getByTestId('live-view-ended')).toBeVisible({ timeout: 15_000 });
    await expect(treeNode(page, sharedKey)).toHaveAttribute('data-live', 'false');
    await expect(treeNode(page, sharedKey)).toContainText('ended');
    expect(liveParam(page)).toBe(sharedKey);
    const res = await liveApi(owner.user, { node: sharedKey });
    expect(res.selected).toBe(sharedKey);
    expect(nodeOf(res, sharedKey).live).toBe(false);
    expect(homeOf(res).totals.liveSessions).toBe(4);
  });

  await test.step('AC-9, AC-10. a breakdown row click opens the details panel; «Open session ↗» closes the modal and lands on ?session=', async () => {
    await keepLive();
    await selectNode(page, repoAKey);
    const memKey = `session:${root.mem}@${teamR}`;
    const row = page.locator(`[data-testid="live-breakdown-row"][data-key="${memKey}"]`);
    await row.click();
    await expect(page.getByTestId('live-details-pane')).toBeVisible();
    await expect(page.getByTestId('live-details')).toHaveAttribute('data-key', memKey, { timeout: 15_000 });
    await expect(page.getByTestId('live-details-prompt')).toContainText(prompt('mem'));
    // Both splitters are draggable: the tree widens when dragged right, the details panel when
    // dragged left.
    for (const [splitter, pane, dx] of [
      ['live-tree-splitter', 'live-tree-pane', 80],
      ['live-details-splitter', 'live-details-pane', -80],
    ] as const) {
      const before = (await page.getByTestId(pane).boundingBox())!.width;
      const handle = (await page.getByTestId(splitter).boundingBox())!;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(handle.x + handle.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + dx, y, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => (await page.getByTestId(pane).boundingBox())!.width).toBeGreaterThan(before + 40);
    }
    await page.getByTestId('live-details-close').click();
    await expect(page.getByTestId('live-details-pane')).toHaveCount(0);

    await row.getByTestId('live-breakdown-open-session').click();
    await expect(page.getByTestId('live-modal')).toHaveCount(0);
    await expect.poll(() => hashParam(page, 'session')).toBe(sid.mem);
    expect(liveParam(page)).toBeNull();
    expect(new URL(page.url()).hash).toMatch(new RegExp(`^#/teams/${teamR}/repos/\\d+\\?`));
  });

  await test.step('AC-11, AC-11a. the plain member sees only own sessions under the 🔒 team with matching totals; the manager sees everyone with others’ prompts masked', async () => {
    await keepLive();
    const ownerView = await liveApi(owner.user);
    const memInOwner = nodeOf(ownerView, `session:${root.mem}@${teamR}`);

    const memberView = await liveApi(member.user);
    const memberTeam = nodeOf(memberView, `team:${teamR}`);
    expect(memberTeam.restricted).toBe(true);
    const memberSessions = memberView.nodes.filter((n) => n.type === 'session');
    expect(memberSessions.map((n) => n.rootId)).toEqual([root.mem]);
    expect(memberSessions[0].totals.costUsdMicros).toBe(memInOwner.totals.costUsdMicros);
    expect(memberTeam.totals.costUsdMicros).toBe(String(micros(0.4)));
    expect(homeOf(memberView).totals).toMatchObject({ costUsdMicros: String(micros(0.4)), liveSessions: 1 });
    expect((await liveStatus(member.user)).liveSessions).toBe(1);

    const managerView = await liveApi(manager.user);
    expect(nodeOf(managerView, `team:${teamR}`).restricted).toBe(false);
    const byRoot = new Map(managerView.nodes.filter((n) => n.type === 'session').map((n) => [n.rootId, n]));
    // The shared session ended two steps above but is still within 2 h, so it is listed, ended.
    expect([...byRoot.keys()].sort((a, b) => a! - b!)).toEqual([root.shared, root.otelOnly, root.mgr, root.mem].sort((a, b) => a - b));
    expect(byRoot.get(root.shared)!.live).toBe(false);
    expect(byRoot.get(root.mgr)!.label).toBe(`${manager.user.email} · ${prompt('mgr')}`);
    expect(byRoot.get(root.mem)!.label).toBe(`${member.user.email} · prompt hidden`);
    expect(byRoot.get(root.otelOnly)!.label).toBe(`${owner.user.email} · prompt hidden`);
    expect(byRoot.get(root.mem)!.totals.costUsdMicros, 'aggregates stay unmasked').toBe(String(micros(0.4)));
    const panel = await liveApi(manager.user, { panel: `session:${root.mem}@${teamR}` });
    expect(panel.details).toMatchObject({ key: `session:${root.mem}@${teamR}`, firstPrompt: null, attributesMasked: true });

    const origin = new URL(page.url()).origin;
    for (const p of [member, manager]) {
      const ctx = await browser.newContext({ baseURL: origin });
      const other = await ctx.newPage();
      await openLive(other, p.user, '/#/main');
      if (p === member) {
        await expect(treeNode(other, `team:${teamR}`).getByTestId('live-tree-restricted')).toBeVisible();
        await expect(other.locator('[data-testid="live-tree-node"][data-key^="session:"]')).toHaveCount(1);
        await expect(treeNode(other, `team:${teamR}`)).toContainText(otelUsd(micros(0.4)));
      } else {
        await expect(treeNode(other, `team:${teamR}`).getByTestId('live-tree-restricted')).toHaveCount(0);
        await expect(treeNode(other, `session:${root.mem}@${teamR}`)).toContainText('prompt hidden');
        await treeNode(other, `session:${root.mem}@${teamR}`).hover();
        await treeNode(other, `session:${root.mem}@${teamR}`).getByTestId('live-tree-info').click();
        await expect(other.getByTestId('live-details-masked')).toBeVisible({ timeout: 15_000 });
        await expect(other.getByTestId('live-details-prompt')).toContainText('prompt hidden');
      }
      await ctx.close();
    }
  });

  await test.step('AC-13. a failing refresh shows the «Connection lost» banner and keeps the data; it clears once requests succeed again', async () => {
    await keepLive();
    await openLive(page, owner.user, `/#/repos/${ownerRepoP}`);
    await expect(treeNode(page, `session:${root.personal}@noteam`)).toBeVisible({ timeout: 20_000 });
    const isLive = (url: URL) => url.pathname === '/api/v1/otel/live';
    await page.route(isLive, (route) => route.abort());
    const banner = page.getByTestId('live-error-banner');
    await expect(banner).toContainText('Connection lost — showing data from', { timeout: 15_000 });
    await expect(banner).toContainText('retrying');
    // The shared session ended in the step above; it stays listed, greyed, and in home's sum.
    const kept = homeOf(await liveApi(owner.user)).totals.costUsdMicros;
    await expect(treeNode(page, 'home')).toContainText(otelUsd(Number(kept)));
    await expect(treeNode(page, `session:${root.shared}@${teamR}`)).toHaveAttribute('data-live', 'false');
    await expect(treeNode(page, `session:${root.personal}@noteam`)).toBeVisible();
    await page.unroute(isLive);
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
  });
});
