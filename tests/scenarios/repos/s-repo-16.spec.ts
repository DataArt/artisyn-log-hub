// S-REPO-16. Team-view analytics follow the team config: the file-category stats of every
// member's sessions are classified by the team's single config (the seed, then the owner's save,
// then the defaults after a `null` save), the personal view is untouched, and «Recompute all
// sessions» restores team stats (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-16;
// mode A).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3) with `reads` (Read tool calls of
// `docs/guide.md` and `src/app.ts`). `db` counts stats rows, and deletes the team-scoped rows once
// to stand for the stale pre-migration state no endpoint produces (`db-seed.ts` rule).
//
// Steps 7–11 — the OKF usage tab (2026-10-27-okf-usage-tab, FR-5, FR-17): owner and member each
// upload an OKF session tree (helpers/okf.ts, DD-36) whose snapshot has a tracked bundle
// `docs/kb-<run>` with one gitignored article (`secret.md`) and a gitignored bundle
// `docs/private-<run>`. The personal view shows both bundles and the ignored article; the team
// view (the repo tab and a session's OKF tab) drops every ignored path fail-closed (DD-30).
// «Recompute all sessions» refills `session_okf_access` after its rows are deleted; the bundle
// filter narrows the tiles and the tree.
//
// Steps 12–16 — OKF value signals (2026-11-03-okf-view-kb-value): the owner uploads three more
// trees against a snapshot that adds `route.md`, `yield.md` and `upkeep.md` to the bundle. Their
// article reads name code paths in back-ticks (pointers, DD-8) and their agents read / grep those
// paths (code events, DD-5): a routing miss (FR-3), a followed vs a prompt-named pointer and a
// dead one (FR-1, FR-13), an upkeep read (FR-5); then the team view of a `team-no-prompts`
// manager (patterns shown, task heads masked) and a personal `routingMinSearches` override that
// changes the list at read time, plus the FR-11 «no OKF analysis yet» banner.
// Package 2 (2026-11-05): step 8 checks the repo Checks lines (not enough data, too-small
// folder, the most-read article below 80 %, no big article) and an empty section B; step 12 the
// routing-miss finding listed under section B, not A.
// Package 3 (agent trail): step 12 follows a missing agent's «Agent trail» link from the article
// drill-down to its session's OKF tab (`okfAgent` in the URL) and checks the trail.
//
// Replaces: none (2026-10-16-team-vs-personal-config).
import { randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { expectOkfTreeFits, uploadOkfSessionTree, type OkfAction, type OkfSubAgentSpec } from '../helpers/okf';
import { ownRepoId, rangeAround, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept, setMemberRoles } from '../helpers/teams';

interface RepoConfig {
  fileCategories: Array<{ name: string; patterns: string[] }>;
  highCacheCreationThreshold?: number;
}

interface OkfRepoUsage {
  tiles: {
    kbFiles: number;
    kbSessions: number;
    upkeepOnlySessions?: number;
    pointerYield?: { k: number; n: number } | null;
    routingMissArticles?: number;
    routingMissPairs?: number;
    sessionsWithoutAnalysis?: number;
  };
  bundles: Array<{ root: string }>;
  tree: unknown[];
  hotFiles: Array<{ path: string }>;
  upkeep?: Array<{ path: string; sessions: number; readBytes: number }>;
  thresholds?: { custom: string[] };
  canRecompute?: boolean;
}

interface OkfSessionUsage {
  bundles: Array<{ root: string }>;
  agents: Array<{ id: string; promptNamedPaths?: number; yield?: { k: number; n: number } | null }>;
}

/** `GET …/reports/okf-usage/article` (2026-11-03 OKF value signals, DD-23). */
interface OkfArticle {
  found: boolean;
  reads: { whole: number; section: number; upkeep: number; partial: number };
  yield: { k: number; n: number } | null;
  pointers: Array<{ pointer: string; shown: number; followed: number; dead: boolean; notFound: boolean }>;
  area: string[];
  routingMiss: {
    agents: number;
    areaAgents: number;
    patterns: Array<{ pattern: string; count: number }>;
    missing: Array<{ sessionId: string; agentId: string; taskHead: string; searches: number }>;
  } | null;
  findings: Array<{ rule: string }>;
}

/** The big number of the repo OKF tab's «KB files» tile. */
const kbFilesTile = (page: Page) => page.getByTestId('okf-tile-kb-files').locator('p').first();

interface TimelineRow {
  sessionId: string;
  fileStatsByCategory: Record<string, { files: number; bytes: number }>;
}

const TEAM_DOCS: RepoConfig = { fileCategories: [{ name: 'team_docs', patterns: ['^docs/'] }], highCacheCreationThreshold: 55_000 };
const MEMBER_CAT: RepoConfig = { fileCategories: [{ name: 'member_src', patterns: ['^src/'] }] };

test('@S-REPO-16 team-view analytics follow the team config for every member’s sessions @mode-a', async ({
  api,
  browser,
  db,
  stand,
  users,
}) => {
  test.setTimeout(480_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/team-analytics`;
  const owner = await users.user('user', { label: 'r16-owner' });
  const member = await users.user('user', { label: 'r16-member' });
  const reads = ['docs/guide.md', 'src/app.ts'];
  const sid = (who: string) => `r16-${run}-${who}`;

  const { teamId, repo } = await test.step('setup: transparent team (owner + member); both upload sessions reading docs/guide.md and src/app.ts; the URL is linked', async () => {
    const teamId = await createTeam(owner, `Analytics-${run}`);
    expect((await owner.api.patch(`/api/v1/teams/${teamId}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
    await inviteAndAccept(owner, member, teamId, 'transparent');
    const repo = new Map<ScenarioUser, number>();
    for (const [who, user] of [
      ['owner', owner],
      ['member', member],
    ] as Array<[string, ScenarioUser]>) {
      const key = await createApiKey(user.api);
      await uploadPromptSession(api, key.key, { sessionId: sid(who), prompt: `${who} ${run}`, repoUrl, reads }, { db, userId: user.id });
      repo.set(user, await ownRepoId(user.api, repoUrl));
    }
    await addTeamRepo(owner, teamId, repoUrl);
    return { teamId, repo };
  });

  const repoOf = (user: ScenarioUser) => repo.get(user)!;
  const timeline = async (user: ScenarioUser, query: string) => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/analytics/timeline?${query}${rangeAround()}`);
    expect(res.status(), `${user.email} timeline ${query}`).toBe(200);
    const rows = (await res.json()) as TimelineRow[];
    return new Map(rows.map((r) => [r.sessionId, Object.keys(r.fileStatsByCategory).sort()]));
  };
  const teamTimeline = (user: ScenarioUser) => timeline(user, `teamId=${teamId}&`);
  const personalTimeline = (user: ScenarioUser) => timeline(user, '');
  const putTeam = async (config: RepoConfig | null) => {
    const res = await owner.api.put(`/api/v1/repositories/${repoOf(owner)}/settings/team?teamId=${teamId}`, { data: { config } });
    expect(res.status()).toBe(200);
  };
  const causes = async (user: ScenarioUser, query: string) => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/reports/cache-read-ratio?${query}${rangeAround()}`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { causes: { thresholdTokens: number; thresholdSource: string; sessionsWithoutCauseData: number } })
      .causes;
  };
  const teamRows = async (table: 'session_file_stats' | 'session_cause_stats') =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(DISTINCT t.session_id) AS n FROM ${table} t JOIN sessions s ON s.id = t.session_id
           WHERE t.team_id = $1 AND s.session_id = ANY($2)`,
          [teamId, [sid('owner'), sid('member')]],
        )
      ).rows[0].n,
    );

  // The member's personal config is set before anything else, so the personal view must keep it
  // through every team-side change below.
  expect((await member.api.put(`/api/v1/repositories/${repoOf(member)}/settings/user`, { data: { config: MEMBER_CAT } })).status()).toBe(
    200,
  );
  const personalBefore = await personalTimeline(member);
  expect(personalBefore.get(sid('member'))).toContain('member_src');

  await test.step('1. FR-9 seed: before any save the member’s team view shows the seeded `docs` for both members’ sessions', async () => {
    const t = await teamTimeline(member);
    expect(t.get(sid('owner'))).toContain('docs');
    expect(t.get(sid('member'))).toContain('docs');
  });

  await test.step('2. AC-6 / FR-7: after the owner saves team_docs, the member’s team view shows team_docs for both sessions; threshold = team', async () => {
    await putTeam(TEAM_DOCS);
    const t = await teamTimeline(member);
    for (const who of ['owner', 'member']) {
      expect(t.get(sid(who)), who).toContain('team_docs');
      expect(t.get(sid(who)), who).not.toContain('docs');
    }
    const c = await causes(member, `teamId=${teamId}&`);
    expect({ tokens: c.thresholdTokens, source: c.thresholdSource }).toEqual({ tokens: 55_000, source: 'team' });
    expect(c.sessionsWithoutCauseData).toBe(0);
    expect(await teamRows('session_file_stats')).toBe(2);
    expect(await teamRows('session_cause_stats')).toBe(2);
  });

  await test.step('3. Personal view is untouched; personal cache-read-ratio has the member’s own cause rows (DD 11)', async () => {
    expect(await personalTimeline(member)).toEqual(personalBefore);
    const c = await causes(member, '');
    expect(c.sessionsWithoutCauseData).toBe(0);
  });

  await test.step('4. UI (FR-12): team view Settings → File Categories shows team_docs; personal view shows the member’s own', async () => {
    const { context, page } = await browserAs(
      browser,
      stand.url,
      member,
      `/#/teams/${teamId}/repos/${repoOf(member)}?mtab=settings&stab=file-categories`,
    );
    try {
      await expect(page.getByPlaceholder('Category name').first()).toHaveValue('team_docs');
      await page.goto(`/#/repos/${repoOf(member)}?mtab=settings&stab=file-categories`);
      await page.reload();
      await expect(page.getByPlaceholder('Category name').first()).toHaveValue('member_src');
    } finally {
      await context.close();
    }
  });

  await test.step('5. FR-9: after PUT null the team view shows the default categories, not team_docs', async () => {
    await putTeam(null);
    const t = await teamTimeline(member);
    for (const who of ['owner', 'member']) {
      expect(t.get(sid(who)), who).toContain('docs');
      expect(t.get(sid(who)), who).not.toContain('team_docs');
    }
    expect(await personalTimeline(member)).toEqual(personalBefore);
  });

  await test.step('6. Recompute all sessions (team view, owner) restores deleted team-scoped stats rows', async () => {
    await db.query(
      `DELETE FROM session_file_stats WHERE team_id = $1 AND session_id IN (SELECT id FROM sessions WHERE session_id = ANY($2))`,
      [teamId, [sid('owner'), sid('member')]],
    );
    await db.query(
      `DELETE FROM session_cause_stats WHERE team_id = $1 AND session_id IN (SELECT id FROM sessions WHERE session_id = ANY($2))`,
      [teamId, [sid('owner'), sid('member')]],
    );
    expect(await teamRows('session_file_stats')).toBe(0);
    const res = await owner.api.post(`/api/v1/repositories/${repoOf(owner)}/recompute-all-sessions?teamId=${teamId}`);
    expect(res.status()).toBe(201);
    expect(await teamRows('session_file_stats')).toBe(2);
    expect(await teamRows('session_cause_stats')).toBe(2);
  });

  // ── OKF usage tab: team vs personal, recompute, bundle filter ─────────────────────────────
  const kb = `docs/kb-${run}`;
  const priv = `docs/private-${run}`;
  const secret = `${kb}/secret.md`;
  const okfSid = (who: string) => `r16-${run}-okf-${who}`;
  const okfSnapshot = {
    bundles: [
      { root: kb, files: [`${kb}/a.md`, `${kb}/b.md`, { path: secret, ignored: true }] },
      { root: priv, ignored: true, files: [{ path: `${priv}/notes.md`, ignored: true }] },
    ],
  };
  const okfReads: Record<string, OkfAction[]> = {
    owner: [{ read: `${kb}/index.md` }, { read: `${kb}/a.md` }, { read: secret, bytes: 5000 }, { read: `${priv}/notes.md`, bytes: 7000 }],
    member: [{ read: `${kb}/b.md` }, { read: `${priv}/notes.md`, bytes: 7000 }],
  };
  const repoOkf = async (user: ScenarioUser, query: Record<string, string>) => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/reports/okf-usage?${rangeAround()}`, { params: query });
    expect(res.status(), `okf-usage ${JSON.stringify(query)}`).toBe(200);
    return (await res.json()) as OkfRepoUsage;
  };
  const sessionOkf = async (user: ScenarioUser, query: Record<string, string>) => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/sessions/${okfSid('owner')}/okf-usage`, { params: query });
    expect(res.status(), `session okf-usage ${JSON.stringify(query)}`).toBe(200);
    return (await res.json()) as OkfSessionUsage;
  };
  const okfRowCount = async () =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM session_okf_access a JOIN sessions s ON s.id = a.session_id WHERE s.session_id = ANY($1)`,
          [[okfSid('owner'), okfSid('member')]],
        )
      ).rows[0].n,
    );

  await test.step('7. setup: owner and member each upload an OKF session tree (a tracked bundle with an ignored article, an ignored bundle)', async () => {
    for (const [who, user] of [
      ['owner', owner],
      ['member', member],
    ] as Array<[string, ScenarioUser]>) {
      const key = await createApiKey(user.api);
      await uploadOkfSessionTree(
        api,
        key.key,
        { sessionId: okfSid(who), repoUrl, prompt: `okf ${who} ${run}`, snapshot: okfSnapshot, actions: okfReads[who] },
        { db, userId: user.id },
      );
    }
    expect(await okfRowCount(), 'every read of both trees is stored, ignored paths too (filtered at read time)').toBe(6);
  });

  await test.step('8. FR-17 repo OKF tab: the personal view shows both bundles and the ignored article; the team view drops every ignored path', async () => {
    const personal = await repoOkf(owner, {});
    expect(personal.bundles.map((b) => b.root).sort()).toEqual([kb, priv].sort());
    expect(personal.tiles.kbFiles).toBe(6);
    expect(JSON.stringify(personal)).toContain(secret);
    expect(JSON.stringify(personal)).toContain(`${priv}/notes.md`);

    const team = await repoOkf(member, { teamId: String(teamId) });
    expect(team.bundles.map((b) => b.root)).toEqual([kb]);
    expect(team.tiles.kbFiles, 'index.md, a.md, b.md — not secret.md').toBe(3);
    expect(team.tiles.kbSessions, 'both members’ trees read a visible article').toBe(2);
    expect(JSON.stringify(team)).not.toContain(secret);
    expect(JSON.stringify(team)).not.toContain(priv);

    const { context, page } = await browserAs(browser, stand.url, member, `/#/teams/${teamId}/repos/${repoOf(member)}?mtab=okf`);
    try {
      await expect(page.getByTestId('tab-repo-okf')).toHaveAttribute('data-state', 'active');
      await expect(page.getByTestId('okf-tree')).toContainText(kb);
      await expect(kbFilesTile(page)).toHaveText('3');
      await expect(page.getByTestId('repo-okf-tab')).not.toContainText('secret.md');
      await expect(page.getByTestId('repo-okf-tab')).not.toContainText(priv);

      // Package 2 (2026-11-05): section A's verdict card lists the four repo checks with the
      // counted value and the threshold; section B (value signals) has nothing to check here.
      const sectionA = page.getByTestId('okf-section-a');
      await expect(sectionA.getByTestId('okf-section-title')).toHaveText('A · How the KB was navigated (verified)');
      await expect(sectionA.getByTestId('okf-kpi-tiles')).toHaveCount(1);
      const check = (rule: string) => sectionA.getByTestId('okf-check-line').and(page.locator(`[data-rule="${rule}"]`));
      await expect(sectionA.getByTestId('okf-check-line')).toHaveCount(4);
      await expect(sectionA.getByTestId('okf-checks-repo-note'), 'the repo-level note is the session variant’s').toHaveCount(0);
      await expect(check('kb_sessions')).toHaveAttribute('data-status', 'na');
      await expect(check('kb_sessions').getByTestId('okf-check-text')).toHaveText(
        /^Only 2 of \d+ sessions read the KB — the repository checks need 5, so the level is "Not enough data"$/,
      );
      await expect(check('kb_flood')).toHaveAttribute('data-status', 'na');
      await expect(check('kb_flood').getByTestId('okf-check-text')).toHaveText(
        'No KB folder has 10+ articles — flooding is not judged on small folders',
      );
      // a.md and b.md are each read in 1 of the 2 KB sessions; the first is named.
      await expect(check('always_read')).toHaveAttribute('data-status', 'ok');
      await expect(check('always_read').getByTestId('okf-check-text')).toHaveText(
        `Most-read article: ${kb}/a.md is read in 1 of 2 KB sessions (50 %); finding at ≥ 80 % — an article nearly every session needs belongs in CLAUDE.md`,
      );
      await expect(check('coarse_article')).toHaveAttribute('data-status', 'na');
      await expect(check('coarse_article').getByTestId('okf-check-text')).toHaveText('No article reaches 50 KB — nothing to split');
      const sectionB = page.getByTestId('okf-section-b');
      await expect(sectionB.getByTestId('okf-section-title')).toHaveText('B · Did the articles help? (heuristic — check by hand)');
      await expect(sectionB.getByTestId('okf-section-b-count')).toHaveText('nothing to check');
      await expect(sectionB.getByTestId('okf-signal-findings')).toContainText('No value signal fired in this period.');
    } finally {
      await context.close();
    }
  });

  await test.step('9. FR-17 session OKF tab: the team URL hides the ignored article and bundle; the personal view keeps them', async () => {
    const personal = JSON.stringify(await sessionOkf(owner, {}));
    expect(personal).toContain(secret);
    expect(personal).toContain(`${priv}/notes.md`);
    const team = await sessionOkf(member, { teamId: String(teamId) });
    expect(team.bundles.map((b) => b.root)).toEqual([kb]);
    expect(JSON.stringify(team)).not.toContain(secret);
    expect(JSON.stringify(team)).not.toContain(priv);

    const { context, page } = await browserAs(
      browser,
      stand.url,
      member,
      `/#/teams/${teamId}/repos/${repoOf(member)}?session=${encodeURIComponent(okfSid('owner'))}&tab=okf`,
    );
    try {
      await expect(page.getByTestId('session-okf-tab')).toBeVisible();
      await expect(page.getByTestId('okf-tree-row').filter({ hasText: 'a.md' })).toHaveCount(1);
      await expect(page.getByTestId('session-okf-tab')).not.toContainText('secret.md');
      await expect(page.getByTestId('session-okf-tab')).not.toContainText('notes.md');
    } finally {
      await context.close();
    }
  });

  await test.step('10. FR-5: «Recompute all sessions» refills session_okf_access for sessions whose rows are gone', async () => {
    await db.query(`DELETE FROM session_okf_access WHERE session_id IN (SELECT id FROM sessions WHERE session_id = ANY($1))`, [
      [okfSid('owner'), okfSid('member')],
    ]);
    expect(await okfRowCount()).toBe(0);
    expect((await repoOkf(owner, {})).tiles.kbSessions).toBe(0);
    // A repository row is per user: the owner's recompute covers the sessions linked to the
    // owner's row (4 reads), the member's own recompute the member's (2 reads).
    const recompute = async (user: ScenarioUser) =>
      expect((await user.api.post(`/api/v1/repositories/${repoOf(user)}/recompute-all-sessions`)).status()).toBe(201);
    await recompute(owner);
    expect(await okfRowCount()).toBe(4);
    expect((await repoOkf(owner, {})).tiles.kbSessions).toBe(1);
    await recompute(member);
    expect(await okfRowCount()).toBe(6);
    expect((await repoOkf(member, { teamId: String(teamId) })).tiles.kbSessions).toBe(2);
  });

  await test.step('11. bundle filter (personal view): one bundle narrows the tiles and the tree; the URL keeps it', async () => {
    const one = await repoOkf(owner, { bundle: kb });
    expect(one.bundles.map((b) => b.root)).toEqual([kb]);
    expect(one.tiles.kbFiles).toBe(4);
    expect(JSON.stringify(one.tree)).not.toContain(priv);

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoOf(owner)}?mtab=okf`);
    try {
      await expect(kbFilesTile(page)).toHaveText('6');
      await expect(page.getByTestId('okf-tree')).toContainText(priv);
      await page.getByTestId('okf-bundle-select').click();
      await page.getByRole('option', { name: kb, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`okfBundle=${encodeURIComponent(kb).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      await expect(kbFilesTile(page)).toHaveText('4');
      await expect(page.getByTestId('okf-tree')).toContainText(kb);
      await expect(page.getByTestId('okf-tree')).not.toContainText(priv);
    } finally {
      await context.close();
    }
  });

  // ── OKF value signals (2026-11-03): routing miss, yield, dead pointers, upkeep, thresholds ──
  const route = `${kb}/route.md`;
  const yieldArticle = `${kb}/yield.md`;
  const upkeepArticle = `${kb}/upkeep.md`;
  // The step-7 snapshot plus three articles; every other file keeps its hash (no stale marker).
  const valueSnapshot = {
    bundles: [
      { root: kb, files: [`${kb}/a.md`, `${kb}/b.md`, { path: secret, ignored: true }, route, yieldArticle, upkeepArticle] },
      okfSnapshot.bundles[1],
    ],
  };
  const ROUTER = 'server/route/router.ts';
  const TABLE = 'server/route/table.ts';
  const ROUTE_TEXT = `# Routing\nRouting lives in \`${ROUTER}\`; the table is \`${TABLE}\`.\n`;
  const HIT = 'server/yield/hit.ts';
  const DEAD = 'server/yield/dead.ts';
  const YIELD_TEXT = `# Yield\nStart at \`${HIT}\`; the old flow was in \`${DEAD}\`.\n`;
  const UPKEEP_TEXT = 'Keep `server/upkeep/job.ts` in sync.\n';
  const agent = (name: string) => `agent-${run}-${name}`;
  const greps = (path: string, patterns: string[]): OkfAction[] => patterns.map((pattern) => ({ grep: path, pattern }));
  let ownerKey: string | undefined;
  const uploadValueTree = async (who: string, prompt: string, actions: OkfAction[], subAgents: OkfSubAgentSpec[]) => {
    ownerKey ??= (await createApiKey(owner.api)).key;
    await uploadOkfSessionTree(
      api,
      ownerKey,
      { sessionId: okfSid(who), repoUrl, prompt, snapshot: valueSnapshot, actions, subAgents },
      { db, userId: owner.id },
    );
  };
  const article = async (user: ScenarioUser, path: string, query: Record<string, string> = {}) => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/reports/okf-usage/article?${rangeAround()}`, {
      params: { path, ...query },
    });
    expect(res.status(), `okf article ${path} ${JSON.stringify(query)}`).toBe(200);
    const body = (await res.json()) as OkfArticle;
    expect(body.found, path).toBe(true);
    return body;
  };
  const articleUrl = (path: string) => `okfArticle=${encodeURIComponent(path)}`;
  const routeNodes = [okfSid('route'), agent('reader'), agent('s1'), agent('s2'), agent('s3')];
  /** The routing tree's main agent's task head in a drill-down's missing-agents list. */
  const mainHead = (a: OkfArticle) => a.routingMiss?.missing.find((m) => m.agentId === okfSid('route'))?.taskHead;

  await test.step('12. FR-3 routing miss: 3 agents grep route.md’s area 3× without opening it, one greps 2× → «3 of 4», top patterns; a sub-agent read does not clear the main agent', async () => {
    await uploadValueTree(
      'route',
      `okf route ${run}`,
      greps(ROUTER, ['routeTable', 'routeTable', 'matchPath']),
      [
        { agentId: agent('reader'), task: 'read the routing article', actions: [{ read: route, result: ROUTE_TEXT }] },
        { agentId: agent('s1'), task: 'grep the router for the table', actions: greps(ROUTER, ['routeTable', 'resolveRoute', 'routeTable']) },
        { agentId: agent('s2'), task: 'grep the route table', actions: greps(TABLE, ['routeTable', 'matchPath', 'resolveRoute']) },
        // Two searches only (one through Bash): in the area, but under routingMinSearches (3).
        {
          agentId: agent('s3'),
          task: 'look for the alias',
          actions: [{ grep: ROUTER, pattern: 'routeAlias' }, { bash: `grep -n routeAlias ${ROUTER}`, result: '12:routeAlias' }],
        },
      ],
    );
    const a = await article(owner, route);
    expect(a.area).toEqual([ROUTER, TABLE]);
    expect(a.routingMiss).not.toBeNull();
    expect({ agents: a.routingMiss!.agents, areaAgents: a.routingMiss!.areaAgents }).toEqual({ agents: 3, areaAgents: 4 });
    expect(a.routingMiss!.patterns).toEqual([
      { pattern: 'routeTable', count: 5 },
      { pattern: 'matchPath', count: 2 },
      { pattern: 'resolveRoute', count: 2 },
    ]);
    expect(a.routingMiss!.missing.map((m) => m.agentId).sort(), 'the main agent stays a miss although its sub-agent read route.md').toEqual(
      [okfSid('route'), agent('s1'), agent('s2')].sort(),
    );
    expect(a.routingMiss!.missing.every((m) => m.sessionId === okfSid('route') && m.searches === 3)).toBe(true);
    expect(a.findings.map((f) => f.rule)).toContain('routing_miss');
    const usage = await repoOkf(owner, {});
    expect({ articles: usage.tiles.routingMissArticles, pairs: usage.tiles.routingMissPairs }).toEqual({ articles: 1, pairs: 3 });

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoOf(owner)}?mtab=okf`);
    try {
      const row = page.getByTestId('okf-tree-row').filter({ hasText: 'route.md' });
      await expect(row.getByTestId('okf-tree-route-miss')).toHaveText('3 / 4');
      // Package 2: the routing-miss finding counts for the level but is listed under section B
      // (heuristic), never among section A's structure findings.
      const sectionB = page.getByTestId('okf-section-b');
      await expect(sectionB.getByTestId('okf-section-b-count')).toHaveText(/^[1-9]\d* signals? to check$/);
      await expect(sectionB.getByTestId('okf-why-line').filter({ hasText: 'routing miss: 3 of 4 agents' })).toHaveCount(1);
      await expect(page.getByTestId('okf-section-a').getByTestId('okf-why-line').filter({ hasText: 'routing miss' })).toHaveCount(0);
      await expect(sectionB.getByTestId('okf-tile-routing-miss')).toContainText('3 misses, counted per agent and article');
      // OKF tab quick wins: the repo tree fits beside its side column without sideways scroll.
      await expectOkfTreeFits(page);
      // A real click: at the stand's 1280 px viewport the name cell keeps its minimum width.
      await row.getByTestId('okf-tree-file-link').click();
      await expect(page).toHaveURL(new RegExp(articleUrl(route).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await expect(page.getByTestId('okf-article-signal-routing-miss')).toHaveText('3 of 4 agents');
      const block = page.getByTestId('okf-article-routing-miss');
      await expect(block.getByTestId('okf-article-patterns')).toContainText('routeTable×5');
      await expect(block.getByTestId('okf-article-missing-agent')).toHaveCount(3);
      await expect(block.getByTestId('okf-article-action')).toContainText('without opening');
      await page.getByTestId('okf-article-back').click();
      await expect(page.getByTestId('okf-article-drilldown')).toHaveCount(0);

      // Package 3: a missing agent's «Agent trail» link opens its session on the OKF tab with
      // `okfAgent` set; the trail lists its three searches of the router in order, before any
      // KB read and so with no in-area mark (it never opened route.md).
      await row.getByTestId('okf-tree-file-link').click();
      const link = page
        .getByTestId('okf-article-missing-agent')
        .getByTestId('okf-article-trail-link')
        .and(page.locator(`[href*="okfAgent=${encodeURIComponent(agent('s1'))}"]`));
      await expect(link).toHaveCount(1);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`[?&]session=${okfSid('route')}(&|$)`));
      await expect(page).toHaveURL(/[?&]tab=okf(&|$)/);
      await expect(page).toHaveURL(new RegExp(`[?&]okfAgent=${agent('s1')}(&|$)`));
      await expect(page).not.toHaveURL(/[?&]mtab=/);
      const trail = page.getByTestId('okf-agent-trail');
      await expect(trail).toHaveAttribute('data-agent', agent('s1'));
      const items = trail.getByTestId('okf-trail-item');
      await expect(items).toHaveCount(3);
      await expect(items.getByTestId('okf-trail-pattern')).toHaveText(['"routeTable"', '"resolveRoute"', '"routeTable"']);
      await expect(items.getByTestId('okf-trail-path').first()).toHaveText(ROUTER);
      await expect(trail.locator('[data-in-area="true"]')).toHaveCount(0);
      await expect(trail).toContainText('Before any KB article was read');
    } finally {
      await context.close();
    }
  });

  await test.step('13. FR-1 / FR-13: a followed pointer is a hit, the same path named in a sub-agent’s task is not; a pointer shown in 4 reads and never followed is dead', async () => {
    await uploadValueTree('yield', `okf yield ${run}`, [{ read: yieldArticle, result: YIELD_TEXT }, { read: HIT }], [
      {
        agentId: agent('named'),
        task: `fix the bug in \`${HIT}\``,
        actions: [{ read: yieldArticle, result: YIELD_TEXT }, { read: HIT }],
      },
      { agentId: agent('d1'), task: 'skim the yield article', actions: [{ read: yieldArticle, result: YIELD_TEXT }] },
      { agentId: agent('d2'), task: 'skim the yield article again', actions: [{ read: yieldArticle, result: YIELD_TEXT }] },
    ]);
    const a = await article(owner, yieldArticle);
    expect(a.yield, 'only the main agent’s read had a new pointer that was followed').toEqual({ k: 1, n: 4 });
    expect(a.pointers).toEqual([
      { pointer: DEAD, shown: 4, followed: 0, dead: true, notFound: true },
      { pointer: HIT, shown: 3, followed: 1, dead: false, notFound: false },
    ]);
    expect(a.findings.map((f) => f.rule)).toContain('dead_pointers');

    const res = await owner.api.get(`/api/v1/repositories/${repoOf(owner)}/sessions/${okfSid('yield')}/okf-usage`);
    expect(res.status()).toBe(200);
    const agents = ((await res.json()) as OkfSessionUsage).agents;
    const named = agents.find((x) => x.id === agent('named'));
    expect(named?.yield, 'its hit.ts was named in its task, so its read shows only dead.ts as new').toEqual({ k: 0, n: 1 });
    expect(named?.promptNamedPaths).toBe(1);
    expect(agents.find((x) => x.id === okfSid('yield'))?.yield).toEqual({ k: 1, n: 1 });
    expect((await repoOkf(owner, {})).tiles.pointerYield, 'reader of route.md (0 of 1) + yield.md (1 of 4)').toEqual({ k: 1, n: 5 });

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoOf(owner)}?mtab=okf&${articleUrl(yieldArticle)}`);
    try {
      await expect(page.getByTestId('okf-article-signal-yield')).toHaveText('1 / 4 reads');
      await expect(page.getByTestId('okf-article-signal-dead')).toHaveText('1 dead of 2 shown');
      const first = page.getByTestId('okf-article-pointer').first();
      await expect(first).toHaveAttribute('data-dead', 'true');
      await expect(first).toContainText(DEAD);
      await expect(first.getByTestId('okf-article-pointer-not-found')).toHaveText('path not found in any session');
      await expect(page.getByTestId('okf-article-pointer').nth(1)).toContainText('followed ×1 · shown ×3');
      await expect(page.getByTestId('okf-article-dead').getByTestId('okf-article-action')).toContainText(`remove ${DEAD}`);
    } finally {
      await context.close();
    }
  });

  await test.step('14. FR-5 upkeep: the reads of an agent that edits the article go to the Upkeep panel, not hot files or the yield', async () => {
    await uploadValueTree('upkeep', `okf upkeep ${run}`, [{ edit: upkeepArticle }, { read: upkeepArticle, result: UPKEEP_TEXT }], []);
    const usage = await repoOkf(owner, {});
    expect(usage.upkeep).toEqual([expect.objectContaining({ path: upkeepArticle, sessions: 1, readBytes: UPKEEP_TEXT.length })]);
    expect(usage.hotFiles.map((h) => h.path)).not.toContain(upkeepArticle);
    expect(usage.tiles.upkeepOnlySessions, 'the tree only re-read its own edit').toBe(1);
    expect(usage.tiles.pointerYield, 'the upkeep read’s new pointer is not counted').toEqual({ k: 1, n: 5 });
    const a = await article(owner, upkeepArticle);
    expect(a.reads).toEqual({ whole: 0, section: 0, upkeep: 1, partial: 0 });
    expect(a.yield).toBeNull();

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoOf(owner)}?mtab=okf`);
    try {
      await expect(page.getByTestId('okf-upkeep-row').filter({ hasText: 'upkeep.md' })).toHaveCount(1);
      await expect(page.getByTestId('okf-hot-files')).not.toContainText('upkeep.md');
      const row = page.getByTestId('okf-tree-row').filter({ hasText: 'upkeep.md' });
      await expect(row).toContainText('upkeep ×1');
      await expect(row.getByTestId('okf-tree-yield')).toHaveText('—');
    } finally {
      await context.close();
    }
  });

  await test.step('15. team-no-prompts (restricted team, manager): the drill-down shows the search patterns but masks the missing agents’ task heads; transparent restored', async () => {
    expect((await owner.api.patch(`/api/v1/teams/${teamId}`, { data: { accessMode: 'restricted' } })).status()).toBe(200);
    await setMemberRoles(owner, teamId, member.id, { isManager: true });
    try {
      const personal = await article(owner, route);
      const team = await article(member, route, { teamId: String(teamId) });
      expect(team.routingMiss?.patterns, 'patterns are never masked').toEqual(personal.routingMiss?.patterns);
      expect(team.routingMiss?.missing.map((m) => m.taskHead)).toEqual(['', '', '']);
      // Only the main agent has a first prompt here (the helper's sub-agent logs carry none).
      expect(mainHead(personal)).toBe(`okf route ${run}`);

      const { context, page } = await browserAs(
        browser,
        stand.url,
        member,
        `/#/teams/${teamId}/repos/${repoOf(member)}?mtab=okf&${articleUrl(route)}`,
      );
      try {
        const block = page.getByTestId('okf-article-routing-miss');
        await expect(block.getByTestId('okf-article-patterns')).toContainText('routeTable');
        await expect(block.getByTestId('okf-article-missing-agent')).toHaveCount(3);
        await expect(block.getByTestId('okf-article-missing')).not.toContainText(`okf route ${run}`);
      } finally {
        await context.close();
      }
    } finally {
      // A team with members cannot switch back to transparent (409, S-TEAM-03), so the member
      // leaves, the team switches, and the member joins again acknowledging transparent.
      expect((await owner.api.delete(`/api/v1/teams/${teamId}/members/${member.id}`)).status()).toBe(204);
      expect((await owner.api.patch(`/api/v1/teams/${teamId}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
      await inviteAndAccept(owner, member, teamId, 'transparent');
    }
    const again = await article(member, route, { teamId: String(teamId) });
    expect(mainHead(again), 'transparent again: the task head is visible').toBe(`okf route ${run}`);
  });

  await test.step('16. FR-17 / FR-11: routingMinSearches 2 in Settings → OKF thresholds grows the routing-miss list without recompute; the chip says custom; the banner’s recompute link follows authority', async () => {
    const eventIds = async () =>
      (
        await db.query<{ id: number }>(
          `SELECT e.id FROM session_okf_event e JOIN sessions s ON s.id = e.session_id WHERE s.session_id = ANY($1) ORDER BY e.id`,
          [routeNodes],
        )
      ).rows.map((r) => r.id);
    const before = await eventIds();
    expect(before.length, 'the routing tree’s searches are stored').toBe(11);

    const { context, page } = await browserAs(browser, stand.url, owner, `/#/repos/${repoOf(owner)}?mtab=okf`);
    try {
      const chip = page.getByTestId('okf-thresholds-chip');
      await expect(chip).toHaveAttribute('data-custom', 'false');
      await chip.click();
      const section = page.getByTestId('okf-thresholds-setting');
      await expect(section).toBeVisible();
      await section.getByRole('textbox', { name: 'routingMinSearches', exact: true }).fill('2');
      const saved = page.waitForResponse((r) => /\/settings\/user$/.test(r.url()) && r.request().method() === 'PUT');
      await section.getByRole('button', { name: 'Save for this repo' }).click();
      expect((await saved).status()).toBe(200);

      const a = await article(owner, route);
      expect({ agents: a.routingMiss?.agents, areaAgents: a.routingMiss?.areaAgents }).toEqual({ agents: 4, areaAgents: 4 });
      expect(a.routingMiss?.patterns).toContainEqual({ pattern: 'routeAlias', count: 2 });
      const usage = await repoOkf(owner, {});
      expect(usage.thresholds?.custom).toEqual(['routingMinSearches']);
      expect(usage.tiles.routingMissPairs).toBe(4);
      expect(await eventIds(), 'thresholds apply at read time: no OKF row was rebuilt').toEqual(before);
      const team = await article(member, route, { teamId: String(teamId) });
      expect(team.routingMiss?.agents, 'the team view keeps the team’s (default) thresholds').toBe(3);

      await page.goto(`/#/repos/${repoOf(owner)}?mtab=okf`);
      await page.reload();
      await expect(page.getByTestId('okf-thresholds-chip')).toHaveAttribute('data-custom', 'true');
      await expect(page.getByTestId('okf-thresholds-chip')).toContainText('custom thresholds · 1');
      await expect(page.getByTestId('okf-tree-row').filter({ hasText: 'route.md' }).getByTestId('okf-tree-route-miss')).toHaveText('4 / 4');

      // FR-11: the routing tree's root stands for a session extracted before this version.
      const baseline = (await repoOkf(owner, {})).tiles.sessionsWithoutAnalysis ?? 0;
      await db.query('UPDATE sessions SET okf_extract_version = NULL WHERE session_id = $1', [okfSid('route')]);
      expect((await repoOkf(owner, {})).tiles.sessionsWithoutAnalysis).toBe(baseline + 1);
      const memberView = await repoOkf(member, { teamId: String(teamId) });
      expect(memberView.canRecompute, 'a member is not the team owner').toBe(false);
      expect(memberView.tiles.sessionsWithoutAnalysis ?? 0).toBeGreaterThan(0);

      const memberUi = await browserAs(browser, stand.url, member, `/#/teams/${teamId}/repos/${repoOf(member)}?mtab=okf`);
      try {
        await expect(memberUi.page.getByTestId('okf-analysis-banner')).toBeVisible();
        await expect(memberUi.page.getByTestId('okf-analysis-recompute')).toHaveCount(0);
      } finally {
        await memberUi.context.close();
      }

      await page.reload();
      await expect(page.getByTestId('okf-analysis-banner')).toContainText('have no OKF analysis yet');
      await page.getByTestId('okf-analysis-recompute').click();
      await expect(page.getByTestId('okf-analysis-recompute-result')).toContainText('Recomputed');
      const marker = await db.query<{ v: number | null }>('SELECT okf_extract_version AS v FROM sessions WHERE session_id = $1', [
        okfSid('route'),
      ]);
      expect(marker.rows[0].v, 'the recompute re-extracted the routing tree').not.toBeNull();
    } finally {
      await context.close();
    }
  });
});
