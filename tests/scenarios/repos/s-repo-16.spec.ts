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
// Replaces: none (2026-10-16-team-vs-personal-config).
import { randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { uploadOkfSessionTree, type OkfAction } from '../helpers/okf';
import { ownRepoId, rangeAround, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept } from '../helpers/teams';

interface RepoConfig {
  fileCategories: Array<{ name: string; patterns: string[] }>;
  highCacheCreationThreshold?: number;
}

interface OkfRepoUsage {
  tiles: { kbFiles: number; kbSessions: number };
  bundles: Array<{ root: string }>;
  tree: unknown[];
}

interface OkfSessionUsage {
  bundles: Array<{ root: string }>;
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
  test.setTimeout(240_000);
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
});
