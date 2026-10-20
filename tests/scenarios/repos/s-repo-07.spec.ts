// S-REPO-07. Team settings apply to every member in team view, personal settings override them in
// personal view only, and only the team owner writes them
// (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-07; modes A, B and C — the bug this
// guards against, 2026-10-16-team-vs-personal-config, showed up in mode C only).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3).
//
// Code facts that differ from the design text:
//   - repositories are per user (`(user_id, repo_url)`): every member uploads into their own row of
//     the same URL. Team view passes `?teamId=` to `GET …/settings` and `PUT …/settings/team`; then
//     access is team membership and the config is team → default (the personal one is ignored).
//     Without `teamId` the caller must own the repository id and the fallback is personal → team →
//     default;
//   - the team config is one record per (team, URL) (`team_repo_config`), whichever member's
//     repository id it is read or written through;
//   - the cache threshold bounds are 1 000…10 000 000 tokens (`CACHE_CREATION_THRESHOLD_MIN/MAX`),
//     so the design's «70 / 55» are 70 000 and 55 000; the default is 25 000;
//   - `thresholdSource` is read from `causes.thresholdSource` of
//     `GET …/reports/cache-read-ratio`; a plain member of a `restricted` team gets 403 on reports,
//     so Team-X is `transparent`;
//   - step 6 «an owner without his own team»: a user who owns another team (one that does not
//     list this repository) — owning *a* team is not enough.
//
// Replaces:
//   - server/test/repo-settings.e2e-spec.ts (team branch, 1)
//   - server/test/team-repo-config.e2e-spec.ts (1)
//   - server/src/logs/repositories.service.spec.ts (`getEffectiveCacheThreshold`, ≈6)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, rangeAround, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, createTeam, inviteAndAccept } from '../helpers/teams';

interface FileCategory {
  name: string;
  patterns: string[];
}

interface RepoConfig {
  fileCategories: FileCategory[];
  highCacheCreationThreshold?: number;
}

interface RepoSettings {
  effectiveConfig: RepoConfig;
  teamConfig: RepoConfig | null;
  userConfig: RepoConfig | null;
  teamId: number | null;
  canEditTeamConfig: boolean;
}

const DEFAULT_THRESHOLD = 25_000;

test('@S-REPO-07 team settings reach every member in team view, personal ones override in personal view, only the team owner writes @mode-a @mode-b @mode-c', async ({
  api,
  db,
  users,
}) => {
  test.setTimeout(180_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/settings`;
  const admin = await users.user('admin', { label: 'r07-admin' });
  const owner = await users.user('user', { label: 'r07-owner' });
  const regular = await users.user('user', { label: 'r07-member' });
  const nonowner = await users.user('user', { label: 'r07-stranger' });
  const otherOwner = await users.user('user', { label: 'r07-other-owner' });

  const teamDocs: RepoConfig = { fileCategories: [{ name: 'team_docs', patterns: ['^docs/'] }], highCacheCreationThreshold: 55_000 };
  const myCat: RepoConfig = { fileCategories: [{ name: 'my_cat', patterns: ['^src/'] }], highCacheCreationThreshold: 70_000 };
  const memberCat: RepoConfig = { fileCategories: [{ name: 'member_cat', patterns: ['^lib/'] }] };

  const { teamId, linkId, repo } = await test.step('setup: everyone uploads into the same URL; transparent Team-X (owner + member) lists it', async () => {
    const teamId = await createTeam(owner, `Settings-${run}`);
    const mode = await owner.api.patch(`/api/v1/teams/${teamId}`, { data: { accessMode: 'transparent' } });
    expect(mode.status()).toBe(200);
    await inviteAndAccept(owner, regular, teamId, 'transparent');
    await createTeam(otherOwner, `Other-${run}`);
    const repo = new Map<ScenarioUser, number>();
    for (const [who, user] of [
      ['owner', owner],
      ['member', regular],
      ['stranger', nonowner],
      ['other', otherOwner],
    ] as Array<[string, ScenarioUser]>) {
      const key = await createApiKey(user.api);
      await uploadPromptSession(api, key.key, { sessionId: `r07-${run}-${who}`, prompt: `${who} ${run}`, repoUrl }, { db, userId: user.id });
      repo.set(user, await ownRepoId(user.api, repoUrl));
    }
    const linkId = await addTeamRepo(owner, teamId, repoUrl);
    return { teamId, linkId, repo };
  });

  const repoOf = (user: ScenarioUser) => repo.get(user)!;
  const team = `?teamId=${teamId}`;
  const putTeam = (user: ScenarioUser, config: RepoConfig | null, repoId = repoOf(user), query = '') =>
    user.api.put(`/api/v1/repositories/${repoId}/settings/team${query}`, { data: { config } });
  const putUser = (user: ScenarioUser, config: RepoConfig | null) =>
    user.api.put(`/api/v1/repositories/${repoOf(user)}/settings/user`, { data: { config } });
  const settings = async (user: ScenarioUser, query = '', repoId = repoOf(user)) => {
    const res = await user.api.get(`/api/v1/repositories/${repoId}/settings${query}`);
    expect(res.status(), `${user.email} settings${query}`).toBe(200);
    return (await res.json()) as RepoSettings;
  };
  const names = (config: RepoConfig | null) => (config?.fileCategories ?? []).map((c) => c.name);
  const threshold = async (user: ScenarioUser, query = team) => {
    const sep = query === '' ? '?' : '&';
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/reports/cache-read-ratio${query}${sep}${rangeAround()}`);
    expect(res.status(), `${user.email} cache-read-ratio${query}`).toBe(200);
    const { causes } = (await res.json()) as { causes: { thresholdTokens: number; thresholdSource: string } };
    return { tokens: causes.thresholdTokens, source: causes.thresholdSource };
  };
  const teamConfigRows = async () =>
    Number(
      (
        await db.query<{ n: string }>('SELECT count(*) AS n FROM team_repo_config WHERE team_repository_id = $1', [linkId])
      ).rows[0].n,
    );

  await test.step('1. REGULAR (member, not owner): PUT settings/team → 403, on their own row, on the owner’s and with ?teamId', async () => {
    const own = await putTeam(regular, teamDocs);
    expect(own.status()).toBe(403);
    expect(await own.text()).toContain('Only the team owner can edit team config');
    expect((await putTeam(regular, teamDocs, repoOf(owner))).status()).toBe(403);
    expect((await putTeam(regular, teamDocs, repoOf(regular), team)).status()).toBe(403);
  });

  await test.step('2. OWNER: PUT settings/team?teamId {team_docs, 55 000} → 200; no member’s personal config changes (AC-3)', async () => {
    const res = await putTeam(owner, teamDocs, repoOf(owner), team);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as RepoSettings;
    expect(body.teamId).toBe(teamId);
    expect(body.canEditTeamConfig).toBe(true);
    expect(names(body.teamConfig)).toEqual(['team_docs']);
    expect(body.userConfig).toBeNull();
    expect((await settings(regular, team)).userConfig).toBeNull();
    expect(await teamConfigRows()).toBe(1);
  });

  await test.step('3. REGULAR in team view: the effective config is the team’s (team_docs); thresholdSource = team', async () => {
    const s = await settings(regular, team);
    expect(names(s.effectiveConfig)).toEqual(['team_docs']);
    expect(s.teamId).toBe(teamId);
    expect(s.canEditTeamConfig).toBe(false);
    expect(s.userConfig).toBeNull();
    expect(await threshold(regular)).toEqual({ tokens: 55_000, source: 'team' });
  });

  await test.step('4. OWNER: a personal override {my_cat} wins in personal view only; the team config stays (AC-3)', async () => {
    expect((await putUser(owner, myCat)).status()).toBe(200);
    const personal = await settings(owner);
    expect(names(personal.userConfig)).toEqual(['my_cat']);
    expect(names(personal.effectiveConfig)).toEqual(['my_cat']);
    expect(names(personal.teamConfig)).toEqual(['team_docs']);
    const teamView = await settings(owner, team);
    expect(names(teamView.effectiveConfig)).toEqual(['team_docs']);
    expect(names(teamView.userConfig)).toEqual(['my_cat']);
    const theirs = await settings(regular, team);
    expect(names(theirs.effectiveConfig)).toEqual(['team_docs']);
    expect(names(theirs.teamConfig)).toEqual(['team_docs']);
    expect(theirs.userConfig).toBeNull();
  });

  await test.step('5. Threshold: team view uses team → default (AC-2), personal view user 70 000 > team 55 000 > default', async () => {
    expect(await threshold(owner)).toEqual({ tokens: 55_000, source: 'team' });
    expect(await threshold(owner, '')).toEqual({ tokens: 70_000, source: 'user' });
    expect(await threshold(regular)).toEqual({ tokens: 55_000, source: 'team' });
    expect(await threshold(regular, '')).toEqual({ tokens: 55_000, source: 'team' });
    expect((await putUser(owner, null)).status()).toBe(200);
    expect(await threshold(owner, '')).toEqual({ tokens: 55_000, source: 'team' });
    expect(names((await settings(owner)).effectiveConfig)).toEqual(['team_docs']);
  });

  await test.step('6. AC-13: a member opening the owner’s repository id in team view gets their own userConfig; access checks on ?teamId', async () => {
    expect((await putUser(regular, memberCat)).status()).toBe(200);
    const viaOwnerRow = await settings(regular, team, repoOf(owner));
    expect(names(viaOwnerRow.userConfig)).toEqual(['member_cat']);
    expect(names(viaOwnerRow.effectiveConfig)).toEqual(['team_docs']);
    expect((await nonowner.api.get(`/api/v1/repositories/${repoOf(owner)}/settings${team}`)).status()).toBe(403);
    expect((await regular.api.get(`/api/v1/repositories/${repoOf(regular)}/settings?teamId=0`)).status()).toBe(400);
    expect((await putTeam(regular, teamDocs, repoOf(owner), team)).status()).toBe(403);
    expect((await admin.api.get(`/api/v1/repositories/${repoOf(owner)}/settings${team}`)).status()).toBe(200);
  });

  await test.step('7. AC-11: PUT settings/team?teamId null → teamConfig null, team view on the defaults, re-adding does not seed', async () => {
    const res = await putTeam(owner, null, repoOf(owner), team);
    expect(res.status()).toBe(200);
    expect(((await res.json()) as RepoSettings).teamConfig).toBeNull();
    expect(await teamConfigRows()).toBe(0);
    const s = await settings(regular, team);
    expect(s.teamConfig).toBeNull();
    expect(names(s.effectiveConfig)).toEqual(['knowledgebase', 'docs']);
    expect(await threshold(owner)).toEqual({ tokens: DEFAULT_THRESHOLD, source: 'default' });
    expect(await threshold(regular)).toEqual({ tokens: DEFAULT_THRESHOLD, source: 'default' });
    await addTeamRepo(owner, teamId, repoUrl);
    expect((await settings(owner, team)).teamConfig).toBeNull();
    expect(await teamConfigRows()).toBe(0);
  });

  await test.step('8. The owner of another team (one that does not list this repository): PUT settings/team → 403', async () => {
    expect((await putTeam(otherOwner, teamDocs)).status()).toBe(403);
  });

  await test.step('9. NONOWNER (no team): PUT settings/team → 403 on their own row and on the owner’s', async () => {
    expect((await putTeam(nonowner, teamDocs)).status()).toBe(403);
    expect((await putTeam(nonowner, teamDocs, repoOf(owner))).status()).toBe(403);
    expect((await settings(owner)).teamConfig).toBeNull();
  });
});
