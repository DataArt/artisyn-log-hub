// S-REPO-14. The team config is one record per (team, URL) and lives with the team-repository link:
// seeded on link (even before anyone uploaded the URL), kept on re-link, independent of the order
// of members' repository rows, surviving a member's account deletion, removed with the link
// (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-14; modes A and C).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). `db` is used only to count
// `team_repo_config` rows.
//
// Replaces: none (2026-10-16-team-vs-personal-config).
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import {
  addTeamRepo,
  createTeam,
  deleteTeam,
  inviteAndAccept,
  removeTeamRepo,
  unlinkTeamRepo,
} from '../helpers/teams';

interface RepoConfig {
  fileCategories: Array<{ name: string; patterns: string[] }>;
  highCacheCreationThreshold?: number;
}

interface RepoSettings {
  effectiveConfig: RepoConfig;
  teamConfig: RepoConfig | null;
  userConfig: RepoConfig | null;
  teamId: number | null;
}

const TEAM_DOCS: RepoConfig = { fileCategories: [{ name: 'team_docs', patterns: ['^docs/'] }], highCacheCreationThreshold: 55_000 };
const names = (config: RepoConfig | null) => (config?.fileCategories ?? []).map((c) => c.name);

test('@S-REPO-14 the team config is one record per (team, URL) that lives with the link @mode-a @mode-c', async ({
  api,
  db,
  users,
}) => {
  test.setTimeout(240_000);
  const run = randomBytes(4).toString('hex');

  const configRows = async (linkId: number) =>
    Number(
      (await db.query<{ n: string }>('SELECT count(*) AS n FROM team_repo_config WHERE team_repository_id = $1', [linkId])).rows[0].n,
    );
  const storedConfig = async (linkId: number) =>
    (await db.query<{ config: RepoConfig }>('SELECT config FROM team_repo_config WHERE team_repository_id = $1', [linkId])).rows[0]
      ?.config ?? null;
  const upload = async (user: ScenarioUser, repoUrl: string, tag: string) => {
    const key = await createApiKey(user.api);
    await uploadPromptSession(api, key.key, { sessionId: `r14-${run}-${tag}`, prompt: `${tag} ${run}`, repoUrl }, { db, userId: user.id });
    return ownRepoId(user.api, repoUrl);
  };
  const settings = async (user: ScenarioUser, repoId: number, teamId: number) => {
    const res = await user.api.get(`/api/v1/repositories/${repoId}/settings?teamId=${teamId}`);
    expect(res.status(), `${user.email} settings?teamId=${teamId}`).toBe(200);
    return (await res.json()) as RepoSettings;
  };
  const threshold = async (user: ScenarioUser, repoId: number, teamId: number) => {
    const res = await user.api.get(
      `/api/v1/repositories/${repoId}/reports/cache-read-ratio?teamId=${teamId}&startDate=2020-01-01&endDate=2100-01-01`,
    );
    expect(res.status()).toBe(200);
    const { causes } = (await res.json()) as { causes: { thresholdTokens: number; thresholdSource: string } };
    return { tokens: causes.thresholdTokens, source: causes.thresholdSource };
  };
  const putTeam = async (owner: ScenarioUser, repoId: number, teamId: number, config: RepoConfig | null) => {
    const res = await owner.api.put(`/api/v1/repositories/${repoId}/settings/team?teamId=${teamId}`, { data: { config } });
    expect(res.status(), `save team ${teamId} config`).toBe(200);
  };
  const transparentTeam = async (owner: ScenarioUser, name: string) => {
    const teamId = await createTeam(owner, name);
    expect((await owner.api.patch(`/api/v1/teams/${teamId}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
    return teamId;
  };

  await test.step('1. FR-5 / AC-8: linking a URL nobody uploaded seeds one default config; a member’s first upload sees the saved team config', async () => {
    const owner = await users.user('user', { label: 'r14-owner' });
    const member = await users.user('user', { label: 'r14-member' });
    const repoUrl = `https://git.arrakis.test/scn/${run}/fresh`;
    const teamId = await transparentTeam(owner, `Fresh-${run}`);
    await inviteAndAccept(owner, member, teamId, 'transparent');

    const linkId = await addTeamRepo(owner, teamId, repoUrl);
    expect(await configRows(linkId)).toBe(1);
    expect(names(await storedConfig(linkId))).toEqual(['docs']);

    const ownerRepo = await upload(owner, repoUrl, 'fresh-owner');
    await putTeam(owner, ownerRepo, teamId, TEAM_DOCS);
    const memberRepo = await upload(member, repoUrl, 'fresh-member');
    const s = await settings(member, memberRepo, teamId);
    expect(names(s.teamConfig)).toEqual(['team_docs']);
    expect(names(s.effectiveConfig)).toEqual(['team_docs']);

    // AC-4: re-linking keeps the saved config and still exactly one record.
    await addTeamRepo(owner, teamId, repoUrl);
    expect(await configRows(linkId)).toBe(1);
    expect(names(await storedConfig(linkId))).toEqual(['team_docs']);
  });

  await test.step('2. AC-5: the effective config does not depend on the order of members’ repository rows', async () => {
    const results: Array<Array<{ names: string[]; tokens: number; source: string }>> = [];
    for (const order of ['owner-first', 'member-first'] as const) {
      const owner = await users.user('user', { label: `r14-${order}-owner` });
      const member = await users.user('user', { label: `r14-${order}-member` });
      const repoUrl = `https://git.arrakis.test/scn/${run}/${order}`;
      const teamId = await transparentTeam(owner, `Order-${order}-${run}`);
      await inviteAndAccept(owner, member, teamId, 'transparent');
      const [first, second] = order === 'owner-first' ? [owner, member] : [member, owner];
      const repoIds = new Map<ScenarioUser, number>();
      repoIds.set(first, await upload(first, repoUrl, `${order}-1`));
      repoIds.set(second, await upload(second, repoUrl, `${order}-2`));
      await addTeamRepo(owner, teamId, repoUrl);
      await putTeam(owner, repoIds.get(owner)!, teamId, TEAM_DOCS);
      const seen: Array<{ names: string[]; tokens: number; source: string }> = [];
      for (const user of [owner, member]) {
        const s = await settings(user, repoIds.get(user)!, teamId);
        seen.push({ names: names(s.effectiveConfig), ...(await threshold(user, repoIds.get(user)!, teamId)) });
      }
      results.push(seen);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0][0]).toEqual({ names: ['team_docs'], tokens: 55_000, source: 'team' });
  });

  await test.step('3. AC-7: a member who uploaded the URL deletes their account — the others keep the team config', async () => {
    const owner = await users.user('user', { label: 'r14-keep-owner' });
    const member = await users.user('user', { label: 'r14-keep-member' });
    const leaver = await users.user('user', { label: 'r14-keep-leaver' });
    const repoUrl = `https://git.arrakis.test/scn/${run}/keep`;
    const teamId = await transparentTeam(owner, `Keep-${run}`);
    await inviteAndAccept(owner, member, teamId, 'transparent');
    await inviteAndAccept(owner, leaver, teamId, 'transparent');
    const leaverRepo = await upload(leaver, repoUrl, 'keep-leaver');
    const ownerRepo = await upload(owner, repoUrl, 'keep-owner');
    const memberRepo = await upload(member, repoUrl, 'keep-member');
    const linkId = await addTeamRepo(owner, teamId, repoUrl);
    // Saved through the leaver's repository id: still the one team record.
    await putTeam(owner, leaverRepo, teamId, TEAM_DOCS);

    expect((await leaver.api.post('/api/v1/auth/delete-account', { data: { confirm: 'delete' } })).status()).toBeLessThan(300);
    expect(await configRows(linkId)).toBe(1);
    expect(names((await settings(owner, ownerRepo, teamId)).teamConfig)).toEqual(['team_docs']);
    expect(names((await settings(member, memberRepo, teamId)).teamConfig)).toEqual(['team_docs']);
  });

  await test.step('4. AC-10: unlink, remove and team delete drop exactly that link’s config; re-linking seeds again', async () => {
    const owner = await users.user('user', { label: 'r14-life-owner' });
    const repoUrl = `https://git.arrakis.test/scn/${run}/life`;
    const ownerRepo = await upload(owner, repoUrl, 'life-owner');
    const keeper = await transparentTeam(owner, `Keeper-${run}`);
    const keeperLink = await addTeamRepo(owner, keeper, repoUrl);
    await putTeam(owner, ownerRepo, keeper, TEAM_DOCS);

    // Unlink: the link's config goes, the other team's stays; re-linking seeds the default.
    const t1 = await transparentTeam(owner, `Unlink-${run}`);
    const link1 = await addTeamRepo(owner, t1, repoUrl);
    await putTeam(owner, ownerRepo, t1, TEAM_DOCS);
    await unlinkTeamRepo(owner, t1, link1);
    expect(await configRows(link1)).toBe(0);
    expect(names(await storedConfig(keeperLink))).toEqual(['team_docs']);
    const relink = await addTeamRepo(owner, t1, repoUrl);
    expect(names(await storedConfig(relink))).toEqual(['docs']);

    // Re-linking seeds the owner's personal config when there is one.
    const mine: RepoConfig = { fileCategories: [{ name: 'mine', patterns: ['^src/'] }] };
    expect((await owner.api.put(`/api/v1/repositories/${ownerRepo}/settings/user`, { data: { config: mine } })).status()).toBe(200);
    await unlinkTeamRepo(owner, t1, relink);
    const relinkMine = await addTeamRepo(owner, t1, repoUrl);
    expect(names(await storedConfig(relinkMine))).toEqual(['mine']);

    // Remove: same, while the keeper team still links the URL.
    const t2 = await transparentTeam(owner, `Remove-${run}`);
    const link2 = await addTeamRepo(owner, t2, repoUrl);
    await removeTeamRepo(owner, t2, link2);
    expect(await configRows(link2)).toBe(0);
    expect(await configRows(keeperLink)).toBe(1);

    // Team delete: cascades through the link.
    const t3 = await transparentTeam(owner, `Delete-${run}`);
    const link3 = await addTeamRepo(owner, t3, repoUrl);
    expect(await configRows(link3)).toBe(1);
    await deleteTeam(owner, t3);
    expect(await configRows(link3)).toBe(0);
    expect(names(await storedConfig(keeperLink))).toEqual(['team_docs']);
  });
});
