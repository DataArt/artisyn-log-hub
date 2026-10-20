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
// Replaces: none (2026-10-16-team-vs-personal-config).
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, rangeAround, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, browserAs, createTeam, inviteAndAccept } from '../helpers/teams';

interface RepoConfig {
  fileCategories: Array<{ name: string; patterns: string[] }>;
  highCacheCreationThreshold?: number;
}

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
});
