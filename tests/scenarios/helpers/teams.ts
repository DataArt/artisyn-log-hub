/**
 * teams.ts — team set-up through the public API (create, invite, accept, roles) and a second
 * browser for another user, for the S-TEAM / S-ACC scenarios.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { ScenarioUser } from '../fixtures';

export type TeamAccessMode = 'restricted' | 'transparent';

export interface TeamInvitation {
  id: number;
  teamId: number;
  teamName: string | null;
  accessMode: TeamAccessMode | null;
  inviterId: number;
  inviteeId: number;
  inviteeEmail: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
}

export interface MemberRoles {
  canInvite?: boolean;
  isManager?: boolean;
  isAdlcTrainer?: boolean;
}

/** `POST /api/v1/teams` as `owner`; returns the new team id. */
export async function createTeam(owner: ScenarioUser, name: string): Promise<number> {
  const res = await owner.api.post('/api/v1/teams', { data: { name } });
  expect(res.status(), `create team ${name}`).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

/** `POST /api/v1/teams/:id/invitations` as `inviter`; returns the pending invitation. */
export async function invite(inviter: ScenarioUser, teamId: number, email: string): Promise<TeamInvitation> {
  const res = await inviter.api.post(`/api/v1/teams/${teamId}/invitations`, { data: { email } });
  expect(res.status(), `invite ${email} into team ${teamId}`).toBe(201);
  return (await res.json()) as TeamInvitation;
}

/** Invites `member` and accepts as them with the team's current access mode (the disclosure). */
export async function inviteAndAccept(
  owner: ScenarioUser,
  member: ScenarioUser,
  teamId: number,
  accessMode: TeamAccessMode = 'restricted',
): Promise<TeamInvitation> {
  const inv = await invite(owner, teamId, member.email);
  const res = await member.api.patch(`/api/v1/invitations/${inv.id}`, {
    data: { action: 'accept', acknowledgedAccessMode: accessMode },
  });
  expect(res.status(), `${member.email} accepts team ${teamId}`).toBe(200);
  return inv;
}

/** `PATCH /api/v1/teams/:teamId/members/:userId` as the owner. */
export async function setMemberRoles(owner: ScenarioUser, teamId: number, userId: number, roles: MemberRoles) {
  const res = await owner.api.patch(`/api/v1/teams/${teamId}/members/${userId}`, { data: roles });
  expect(res.status(), `roles of ${userId} in team ${teamId}`).toBe(200);
}

/** `POST /api/v1/teams/:teamId/repositories` as the owner; returns the link (`team_repositories`) id. */
export async function addTeamRepo(owner: ScenarioUser, teamId: number, repoUrl: string): Promise<number> {
  const res = await owner.api.post(`/api/v1/teams/${teamId}/repositories`, { data: { repoUrl } });
  expect(res.status(), `add ${repoUrl} to team ${teamId}`).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

/** `DELETE /api/v1/teams/:teamId/repositories/:linkId/link` — drops the link only, sessions stay. */
export async function unlinkTeamRepo(owner: ScenarioUser, teamId: number, linkId: number) {
  const res = await owner.api.delete(`/api/v1/teams/${teamId}/repositories/${linkId}/link`);
  expect(res.status(), `unlink ${linkId} from team ${teamId}`).toBe(204);
}

/** `DELETE /api/v1/teams/:teamId/repositories/:linkId` — removes the repository from the team. */
export async function removeTeamRepo(owner: ScenarioUser, teamId: number, linkId: number) {
  const res = await owner.api.delete(`/api/v1/teams/${teamId}/repositories/${linkId}`);
  expect(res.status(), `remove ${linkId} from team ${teamId}`).toBe(204);
}

/** `DELETE /api/v1/teams/:teamId` as the owner. */
export async function deleteTeam(owner: ScenarioUser, teamId: number) {
  const res = await owner.api.delete(`/api/v1/teams/${teamId}`);
  expect(res.status(), `delete team ${teamId}`).toBe(204);
}

/** Session storage key of `useNewUserNudge`: set, a new user is not bounced from /#/main to /#/api-keys. */
const NUDGE_DONE_KEY = 'artisyn:newUserNudgeDone';

/** Marks the new-user nudge as done for every document `target` (a page or a whole context) loads. */
export async function skipNewUserNudge(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript((key) => {
    try {
      sessionStorage.setItem(key, '1');
    } catch {
      // storage disabled — the nudge treats that as "already done" too
    }
  }, NUDGE_DONE_KEY);
}

/** A separate browser (own cookies) signed in as `user`, on `path`. Close the context when done. */
export async function browserAs(
  browser: Browser,
  baseURL: string,
  user: ScenarioUser,
  path = '/#/teams',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  await skipNewUserNudge(context);
  const page = await context.newPage();
  await user.signIn(page);
  await page.goto(path);
  return { context, page };
}
