// S-REPO-15. A user in two teams that both link one URL: `?teamId` picks the team for GET and PUT;
// without it the lowest team id wins (settings and the hook's post-turn config); personal configs
// of two members stay apart (docs/qaa-overview/scenarios/02-repos-sessions.md §S-REPO-15; modes A
// and C).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3); the hook endpoint is called with the
// member's API key, the way the hook does.
//
// Replaces: none (2026-10-16-team-vs-personal-config).
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { addTeamRepo, createTeam, inviteAndAccept } from '../helpers/teams';

interface RepoConfig {
  fileCategories: Array<{ name: string; patterns: string[] }>;
}

interface RepoSettings {
  effectiveConfig: RepoConfig;
  teamConfig: RepoConfig | null;
  userConfig: RepoConfig | null;
  teamId: number | null;
  canEditTeamConfig: boolean;
}

const cfg = (name: string): RepoConfig => ({ fileCategories: [{ name, patterns: [`^${name}/`] }] });
const names = (config: RepoConfig | null) => (config?.fileCategories ?? []).map((c) => c.name);

test('@S-REPO-15 two teams on one URL: teamId picks the team, the lowest id wins without it @mode-a @mode-c', async ({
  api,
  db,
  users,
}) => {
  test.setTimeout(180_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/two-teams`;
  const owner = await users.user('user', { label: 'r15-owner' });
  const member = await users.user('user', { label: 'r15-member' });
  const second = await users.user('user', { label: 'r15-second' });
  const t3Owner = await users.user('user', { label: 'r15-t3-owner' });

  const { t1, t2, t3, repo, memberKey } = await test.step('setup: O owns T1 then T2 (T1 < T2), M and S are in both; T3 of another owner links the URL too', async () => {
    const t1 = await createTeam(owner, `T1-${run}`);
    const t2 = await createTeam(owner, `T2-${run}`);
    const t3 = await createTeam(t3Owner, `T3-${run}`);
    expect(t1).toBeLessThan(t2);
    for (const t of [t1, t2]) {
      expect((await owner.api.patch(`/api/v1/teams/${t}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
      await inviteAndAccept(owner, member, t, 'transparent');
      await inviteAndAccept(owner, second, t, 'transparent');
    }
    const repo = new Map<ScenarioUser, number>();
    let memberKey = '';
    for (const [who, user] of [
      ['owner', owner],
      ['member', member],
      ['second', second],
      ['t3', t3Owner],
    ] as Array<[string, ScenarioUser]>) {
      const key = await createApiKey(user.api);
      if (user === member) memberKey = key.key;
      await uploadPromptSession(api, key.key, { sessionId: `r15-${run}-${who}`, prompt: `${who} ${run}`, repoUrl }, { db, userId: user.id });
      repo.set(user, await ownRepoId(user.api, repoUrl));
    }
    for (const t of [t1, t2]) await addTeamRepo(owner, t, repoUrl);
    await addTeamRepo(t3Owner, t3, repoUrl);
    return { t1, t2, t3, repo, memberKey };
  });

  const repoOf = (user: ScenarioUser) => repo.get(user)!;
  const settings = async (user: ScenarioUser, query = '') => {
    const res = await user.api.get(`/api/v1/repositories/${repoOf(user)}/settings${query}`);
    expect(res.status(), `${user.email} settings${query}`).toBe(200);
    return (await res.json()) as RepoSettings;
  };
  const putTeam = (user: ScenarioUser, config: RepoConfig | null, query = '') =>
    user.api.put(`/api/v1/repositories/${repoOf(user)}/settings/team${query}`, { data: { config } });

  await test.step('1. AC-12: PUT settings/team without teamId writes T1 (lowest owned) only; T2 keeps its seed', async () => {
    const res = await putTeam(owner, cfg('t1_cat'));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as RepoSettings;
    expect(body.teamId).toBe(t1);
    expect(names(body.teamConfig)).toEqual(['t1_cat']);
    expect(names((await settings(owner, `?teamId=${t2}`)).teamConfig)).toEqual(['docs']);
  });

  await test.step('2. AC-12: PUT settings/team?teamId=T2 changes T2 only; GET and GET :repoId follow ?teamId', async () => {
    expect((await putTeam(owner, cfg('t2_cat'), `?teamId=${t2}`)).status()).toBe(200);
    for (const [t, name] of [
      [t1, 't1_cat'],
      [t2, 't2_cat'],
    ] as Array<[number, string]>) {
      const s = await settings(member, `?teamId=${t}`);
      expect(s.teamId).toBe(t);
      expect(names(s.teamConfig)).toEqual([name]);
      expect(names(s.effectiveConfig)).toEqual([name]);
      const detail = await member.api.get(`/api/v1/repositories/${repoOf(member)}?teamId=${t}`);
      expect(detail.status()).toBe(200);
      expect(names(((await detail.json()) as { repoConfig: RepoConfig }).repoConfig)).toEqual([name]);
    }
  });

  await test.step('3. AC-12 / FR-13: without teamId the lowest team id wins — settings, GET :repoId and the hook config', async () => {
    const s = await settings(member);
    expect(s.teamId).toBe(t1);
    expect(names(s.effectiveConfig)).toEqual(['t1_cat']);
    const detail = await member.api.get(`/api/v1/repositories/${repoOf(member)}`);
    expect(names(((await detail.json()) as { repoConfig: RepoConfig }).repoConfig)).toEqual(['t1_cat']);
    const hook = await api.get(`/api/v2/post-turn-analysis/config?repoUrl=${encodeURIComponent(repoUrl)}&sessionId=r15-${run}-member`, {
      headers: { 'X-API-Key': memberKey },
    });
    expect(hook.status()).toBe(200);
    const gate = (await hook.json()) as { advisor: { fileCategories: RepoConfig['fileCategories'] }; attribution: object };
    expect(Object.keys(gate).sort()).toEqual(['advisor', 'attribution']);
    expect(gate.advisor.fileCategories.map((c) => c.name)).toEqual(['t1_cat']);
  });

  await test.step('4. AC-1: two members keep separate personal configs in personal view', async () => {
    expect((await member.api.put(`/api/v1/repositories/${repoOf(member)}/settings/user`, { data: { config: cfg('m_cat') } })).status()).toBe(200);
    expect((await second.api.put(`/api/v1/repositories/${repoOf(second)}/settings/user`, { data: { config: cfg('s_cat') } })).status()).toBe(200);
    const m = await settings(member);
    const s = await settings(second);
    expect(names(m.effectiveConfig)).toEqual(['m_cat']);
    expect(names(m.userConfig)).toEqual(['m_cat']);
    expect(names(s.effectiveConfig)).toEqual(['s_cat']);
    expect(names(s.userConfig)).toEqual(['s_cat']);
    expect(names((await settings(member, `?teamId=${t2}`)).effectiveConfig)).toEqual(['t2_cat']);
  });

  await test.step('5. The owner of T3 (also linking the URL) cannot write T1: PUT settings/team?teamId=T1 → 403', async () => {
    const res = await t3Owner.api.put(`/api/v1/repositories/${repoOf(t3Owner)}/settings/team?teamId=${t1}`, {
      data: { config: cfg('hijack') },
    });
    expect(res.status()).toBe(403);
    expect((await putTeam(t3Owner, cfg('t3_cat'), `?teamId=${t3}`)).status()).toBe(200);
    expect(names((await settings(owner, `?teamId=${t1}`)).teamConfig)).toEqual(['t1_cat']);
  });
});
