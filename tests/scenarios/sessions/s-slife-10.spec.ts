// S-SLIFE-10. What team members see: transparent shows everyone's sessions, restricted only
// one's own; raw logs follow the access mode (docs/qaa-overview/scenarios/02-repos-sessions.md
// §S-SLIFE-10; no mode in the design → A and C, DD SC4).
//
// Uploads go through POST /api/v2/logs (impl-plan DD SC3). Both users upload to the same remote,
// so each has a repository row of their own (`repoA`, `repoB`); the team view merges them.
//
// Overlap with S-TEAM-02/03 (design: «согласовать, чтобы остался один экземпляр»): those two own
// the roles, the UI and the access-mode switch; this one owns the session-scoped routes for one
// member in both modes side by side — list, branches, session contexts, timeline, work time, raw
// logs — the owner's exception and the disclosure gate.
//
// Set-up as the code allows it:
//   - step 6: a member who has not acknowledged the disclosure exists only after a force-invite or
//     a repository import (both covered for real in S-TEAM-04 / S-REPO-11). Here C joins Team-Y
//     normally and the acknowledgement stamp is cleared in the stand schema (DD 1), then C
//     acknowledges through the public `POST /teams/:id/acknowledge-disclosure`.
//
// Code facts that differ from the design text:
//   - step 4: in a `transparent` team a member reads another member's raw logs (200) — the code
//     opens them on purpose («every member sees everything, raw logs included»); the design's
//     «403 always» holds for `restricted` and for A's repository without `teamId` (task Notes, as
//     in S-TEAM-03). Through B's own repository without `teamId` the answer is 404: SA is not in
//     B's personal scope at all.
//
// Replaces:
//   - server/test/team-cross-member-sessions.e2e-spec.ts (16; shared with S-TEAM-03, which keeps
//     the UI and the switch)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, rangeAround, uploadPromptSession, type PromptSession } from '../helpers/prompt-session';
import { addTeamRepo, createTeam, inviteAndAccept } from '../helpers/teams';

interface SessionRow {
  sessionId: string;
}
interface BranchRow {
  branch: string;
  sessionCount: number;
}

test('@S-SLIFE-10 team members: transparent shows everyone, restricted only own, raw logs by access mode @mode-a @mode-c', async ({
  api,
  db,
  users,
}) => {
  test.setTimeout(180_000);
  const run = randomBytes(4).toString('hex');
  const repoUrl = `https://git.arrakis.test/scn/${run}/slife10`;
  const userA = await users.user('user', { label: 'sl10-a' });
  const userB = await users.user('user', { label: 'sl10-b' });
  const userC = await users.user('user', { label: 'sl10-c' });
  const nonowner = await users.user('user', { label: 'sl10-x' });
  const session = (who: string): PromptSession => ({
    sessionId: `sl10-${run}-${who}`,
    prompt: `${who} prompt ${run}`,
    repoUrl,
    context: { owner: `ctx-${who}-${run}` },
  });
  const SA = session('a');
  const SB = session('b');
  const SC = session('c');
  const range = rangeAround();

  const { X, Y, repoA, repoB } = await test.step('setup: SA, SB, SC uploaded; Team-X transparent (A owner, B), Team-Y restricted (A owner, B, C); the repo in both', async () => {
    for (const [user, s] of [
      [userA, SA],
      [userB, SB],
      [userC, SC],
    ] as Array<[ScenarioUser, PromptSession]>) {
      const key = await createApiKey(user.api);
      await uploadPromptSession(api, key.key, s, { db, userId: user.id });
    }
    const X = await createTeam(userA, `X-${run}`);
    expect((await userA.api.patch(`/api/v1/teams/${X}`, { data: { accessMode: 'transparent' } })).status()).toBe(200);
    await inviteAndAccept(userA, userB, X, 'transparent');
    const Y = await createTeam(userA, `Y-${run}`);
    await inviteAndAccept(userA, userB, Y, 'restricted');
    await inviteAndAccept(userA, userC, Y, 'restricted');
    await addTeamRepo(userA, X, repoUrl);
    await addTeamRepo(userA, Y, repoUrl);
    return { X, Y, repoA: await ownRepoId(userA.api, repoUrl), repoB: await ownRepoId(userB.api, repoUrl) };
  });

  const q = (teamId?: number, extra = '') => {
    const parts = [teamId !== undefined ? `teamId=${teamId}` : '', extra].filter(Boolean);
    return parts.length ? `?${parts.join('&')}` : '';
  };
  const listOf = async (user: ScenarioUser, repoId: number, teamId?: number) => {
    const res = await user.api.get(`/api/v1/repositories/${repoId}/sessions${q(teamId)}`);
    expect(res.status(), `${user.email} sessions ${repoId}${q(teamId)}`).toBe(200);
    return ((await res.json()) as SessionRow[]).map((r) => r.sessionId).sort();
  };
  const status = async (user: ScenarioUser, path: string) => (await user.api.get(path)).status();
  const repoPath = (repoId: number) => `/api/v1/repositories/${repoId}`;
  const logs = (repoId: number, s: PromptSession, teamId?: number) => `${repoPath(repoId)}/sessions/${s.sessionId}/logs${q(teamId)}`;
  const contexts = (repoId: number, s: PromptSession, teamId?: number) => `${repoPath(repoId)}/sessions/${s.sessionId}/contexts${q(teamId)}`;
  const timeline = (repoId: number, teamId?: number) => `${repoPath(repoId)}/analytics/timeline${q(teamId, range)}`;
  const workTime = (repoId: number, teamId?: number) => `${repoPath(repoId)}/analytics/work-time${q(teamId, `${range}&groupBy=user`)}`;
  const branchesOf = async (user: ScenarioUser, repoId: number, teamId?: number) => {
    const res = await user.api.get(`${repoPath(repoId)}/sessions/branches${q(teamId)}`);
    expect(res.status()).toBe(200);
    return (await res.json()) as BranchRow[];
  };
  const both = [SA.sessionId, SB.sessionId].sort();

  await test.step('1. transparent: B sees SA and SB through repoA and through repoB with teamId=X; repoB without teamId → only SB', async () => {
    expect(await listOf(userB, repoA, X)).toEqual(both);
    expect(await listOf(userB, repoB, X)).toEqual(both);
    expect(await listOf(userB, repoB)).toEqual([SB.sessionId]);
    expect(await status(userB, `${repoPath(repoA)}/sessions`)).toBe(403);
  });

  await test.step('2. transparent: branches hold both; A’s session contexts readable; timeline and work time cover both', async () => {
    expect((await branchesOf(userB, repoB, X)).find((b) => b.branch === 'main')?.sessionCount).toBe(2);
    const ctx = await userB.api.get(contexts(repoB, SA, X));
    expect(ctx.status()).toBe(200);
    expect(await ctx.json()).toEqual(expect.arrayContaining([{ key: 'owner', value: `ctx-a-${run}` }]));
    const tl = await userB.api.get(timeline(repoB, X));
    expect(tl.status()).toBe(200);
    expect(((await tl.json()) as SessionRow[]).map((r) => r.sessionId).sort()).toEqual(both);
    const wt = await userB.api.get(workTime(repoB, X));
    expect(wt.status()).toBe(200);
    const groups = new Set(((await wt.json()) as Array<{ group: string | null }>).map((b) => b.group));
    expect(groups).toContain(userA.email);
    expect(groups).toContain(userB.email);
  });

  await test.step('3. restricted (teamId=Y): B sees only SB; branches only own; A’s contexts 403 (own 200); timeline and work time 403', async () => {
    expect(await listOf(userB, repoA, Y)).toEqual([SB.sessionId]);
    expect(await listOf(userB, repoB, Y)).toEqual([SB.sessionId]);
    expect((await branchesOf(userB, repoB, Y)).find((b) => b.branch === 'main')?.sessionCount).toBe(1);
    expect(await status(userB, contexts(repoB, SA, Y))).toBe(403);
    expect(await status(userB, contexts(repoB, SB, Y))).toBe(200);
    expect(await status(userB, timeline(repoB, Y))).toBe(403);
    expect(await status(userB, workTime(repoB, Y))).toBe(403);
  });

  await test.step('4. raw logs of SA for B: transparent X → 200 (code); restricted Y, no teamId, own repoId with Y → 403', async () => {
    expect(await status(userB, logs(repoA, SA, X))).toBe(200);
    expect(await status(userB, logs(repoB, SA, X))).toBe(200);
    for (const path of [logs(repoA, SA, Y), logs(repoB, SA, Y), logs(repoA, SA)]) {
      expect(await status(userB, path), path).toBe(403);
    }
    // B's own repository in the personal scope holds only B's sessions: SA is simply not there.
    const personal = await userB.api.get(logs(repoB, SA));
    expect(personal.status()).toBe(404);
    expect(await personal.text()).not.toContain(SA.prompt);
  });

  await test.step('5. the team owner (A) reads member B’s raw logs with teamId=Y → 200', async () => {
    const res = await userA.api.get(logs(repoA, SB, Y));
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(SB.prompt);
  });

  await test.step('6. a member without the disclosure acknowledgement (C) is in no list nor export-scope until C acknowledges', async () => {
    const exportScope = async () => {
      const res = await userA.api.get(`${repoPath(repoA)}/sessions/export-scope`, {
        params: { teamId: String(Y), from: new Date(Date.now() - 10 * 86_400_000).toISOString(), to: new Date().toISOString() },
      });
      expect(res.status()).toBe(200);
      return ((await res.json()) as SessionRow[]).map((r) => r.sessionId).sort();
    };
    expect(await listOf(userA, repoA, Y)).toContain(SC.sessionId);
    await db.query('UPDATE team_members SET disclosure_acknowledged_at = NULL WHERE team_id = $1 AND user_id = $2', [Y, userC.id]);
    expect(await listOf(userA, repoA, Y)).toEqual(both);
    expect(await exportScope()).toEqual(both);
    expect(await status(userA, logs(repoA, SC, Y))).toBe(403);

    const ack = await userC.api.post(`/api/v1/teams/${Y}/acknowledge-disclosure`, { data: { acknowledgedAccessMode: 'restricted' } });
    expect(ack.status()).toBe(200);
    expect(await listOf(userA, repoA, Y)).toEqual([...both, SC.sessionId].sort());
    expect(await exportScope()).toEqual([...both, SC.sessionId].sort());
  });

  await test.step('7. NONOWNER (in no team): every one of these → 403', async () => {
    const paths = [
      `${repoPath(repoA)}/sessions`,
      ...[X, Y].flatMap((t) => [
        `${repoPath(repoA)}/sessions${q(t)}`,
        `${repoPath(repoA)}/sessions/branches${q(t)}`,
        contexts(repoA, SA, t),
        timeline(repoA, t),
        workTime(repoA, t),
        logs(repoA, SA, t),
      ]),
    ];
    for (const path of paths) expect(await status(nonowner, path), path).toBe(403);
  });
});
