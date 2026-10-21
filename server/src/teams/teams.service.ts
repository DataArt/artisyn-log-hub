import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  inArray,
  isNull,
  min,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import * as schema from '../database/schema';
import type { RepoConfigJson } from '../database/schema';
import { deleteOrphanHarnessSnapshots } from '../logs/harness-snapshot';
import { PLACEHOLDER_IMPORT_USER_PASSWORD_HASH } from '../logs/logs.service';
import {
  isRawLocalPath,
  toLocalRepoIdentity,
} from '../logs/local-repo-identity';
import { normalizeRepoUrl } from '../logs/repo-url-normalizer';
import { RepositoriesService } from '../logs/repositories.service';
import {
  findPersonalRepoConfig,
  seedTeamRepoConfig,
} from '../logs/team-repo-config';
import { UsersService } from '../users/users.service';

const TEAM_CREATION_DEFAULT_CONFIG: RepoConfigJson = {
  fileCategories: [{ name: 'docs', patterns: ['\\.md$'] }],
};

const MAX_TEAM_NAME_ATTEMPTS = 20;

@Injectable()
export class TeamsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
    private readonly repositoriesService: RepositoriesService,
  ) {}

  async createTeam(ownerId: number, name: string) {
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(schema.teams)
          .values({ name, ownerId })
          .returning();
        const team = rows[0];

        // The owner authors the team's access mode, so there is nothing to
        // disclose to them — stamped at creation so they never appear as
        // "awaiting disclosure" and their own sessions stay visible.
        await tx.insert(schema.teamMembers).values({
          teamId: team.id,
          userId: ownerId,
          canInvite: false,
          disclosureAcknowledgedAt: new Date(),
        });

        return team;
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Team name already taken');
      }
      throw err;
    }
  }

  /**
   * The caller's own teams only — for every app role (the admin role grants no
   * team visibility; admins see all teams only in the admin panel). `isMember` is
   * always `true` and kept in the response for older clients.
   */
  async listTeams(userId: number) {
    const rows = await this.db
      .selectDistinct({
        id: schema.teams.id,
        name: schema.teams.name,
        ownerId: schema.teams.ownerId,
        createdAt: schema.teams.createdAt,
        accessMode: schema.teams.accessMode,
        myIsManager: schema.teamMembers.isManager,
        myIsAdlcTrainer: schema.teamMembers.isAdlcTrainer,
      })
      .from(schema.teams)
      .innerJoin(
        schema.teamMembers,
        eq(schema.teamMembers.teamId, schema.teams.id),
      )
      .where(eq(schema.teamMembers.userId, userId));
    return rows.map((t) => ({ ...t, isMember: true }));
  }

  /**
   * `callerId` is optional so internal callers (which only need the team row)
   * can skip the extra membership lookup; route handlers always pass it so the
   * response carries the caller's own role flags (`myIsManager` /
   * `myIsAdlcTrainer`).
   */
  async getTeam(teamId: number, callerId?: number) {
    const rows = await this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    if (!rows[0]) throw new NotFoundException('Team not found');
    const team = rows[0];
    if (callerId === undefined) return team;

    const membership = await this.db
      .select({
        isManager: schema.teamMembers.isManager,
        isAdlcTrainer: schema.teamMembers.isAdlcTrainer,
      })
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, teamId),
          eq(schema.teamMembers.userId, callerId),
        ),
      );

    return {
      ...team,
      myIsManager: membership[0]?.isManager ?? false,
      myIsAdlcTrainer: membership[0]?.isAdlcTrainer ?? false,
    };
  }

  async updateTeam(
    teamId: number,
    updates: { name?: string; accessMode?: 'transparent' | 'restricted' },
  ) {
    const set: {
      name?: string;
      accessMode?: 'transparent' | 'restricted';
    } = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.accessMode !== undefined) set.accessMode = updates.accessMode;
    if (Object.keys(set).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    if (set.accessMode === 'transparent') {
      // Members joined under the restricted privacy promise, and that
      // promise cannot be revoked — so switching a team that already has
      // members besides the owner to 'transparent' is permanently locked.
      // The reverse direction (transparent -> restricted) only ever reduces
      // exposure and is never blocked.
      const team = await this.getTeam(teamId);
      const rows = await this.db
        .select({ value: count() })
        .from(schema.teamMembers)
        .where(
          and(
            eq(schema.teamMembers.teamId, teamId),
            ne(schema.teamMembers.userId, team.ownerId),
          ),
        );
      if ((rows[0]?.value ?? 0) > 0) {
        throw new ConflictException(
          'Cannot switch to transparent: the team has members besides the owner',
        );
      }
    }

    try {
      const rows = await this.db
        .update(schema.teams)
        .set(set)
        .where(eq(schema.teams.id, teamId))
        .returning();
      if (!rows[0]) throw new NotFoundException('Team not found');
      return rows[0];
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Team name already taken');
      }
      throw err;
    }
  }

  async deleteTeam(teamId: number) {
    // Cancel pending invitations first (cascade handles members and repos)
    await this.db
      .update(schema.invitations)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(schema.invitations.teamId, teamId),
          eq(schema.invitations.status, 'pending'),
        ),
      );

    // The team's links (and their team_repo_config rows) go by FK cascade.
    await this.db.delete(schema.teams).where(eq(schema.teams.id, teamId));
  }

  /**
   * `caller` decides whether `disclosureAcknowledgedAt` is returned verbatim
   * or nulled out: only the team owner may see who has yet to acknowledge the
   * access-mode disclosure (the app admin role grants nothing here), so one member
   * cannot read another member's acknowledgement state. Omitting `caller`
   * takes the safe branch and nulls every timestamp.
   */
  async getMembers(teamId: number, caller?: { id: number }) {
    const rows = await this.db
      .select({
        userId: schema.teamMembers.userId,
        canInvite: schema.teamMembers.canInvite,
        isManager: schema.teamMembers.isManager,
        isAdlcTrainer: schema.teamMembers.isAdlcTrainer,
        disclosureAcknowledgedAt: schema.teamMembers.disclosureAcknowledgedAt,
        joinedAt: schema.teamMembers.joinedAt,
        email: schema.users.email,
      })
      .from(schema.teamMembers)
      .innerJoin(schema.users, eq(schema.teamMembers.userId, schema.users.id))
      .where(eq(schema.teamMembers.teamId, teamId));

    const team = await this.getTeam(teamId);

    const canSeeAcknowledgement =
      caller !== undefined && caller.id === team.ownerId;

    return rows.map((r) => ({
      ...r,
      disclosureAcknowledgedAt: canSeeAcknowledgement
        ? r.disclosureAcknowledgedAt
        : null,
      isOwner: r.userId === team.ownerId,
    }));
  }

  async updateMember(
    teamId: number,
    targetUserId: number,
    updates: {
      canInvite?: boolean;
      isManager?: boolean;
      isAdlcTrainer?: boolean;
    },
  ) {
    const set: {
      canInvite?: boolean;
      isManager?: boolean;
      isAdlcTrainer?: boolean;
    } = {};
    if (updates.canInvite !== undefined) set.canInvite = updates.canInvite;
    if (updates.isManager !== undefined) set.isManager = updates.isManager;
    if (updates.isAdlcTrainer !== undefined) {
      set.isAdlcTrainer = updates.isAdlcTrainer;
    }
    if (Object.keys(set).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    const rows = await this.db
      .update(schema.teamMembers)
      .set(set)
      .where(
        and(
          eq(schema.teamMembers.teamId, teamId),
          eq(schema.teamMembers.userId, targetUserId),
        ),
      )
      .returning();
    if (!rows[0]) throw new NotFoundException('Member not found');
    return rows[0];
  }

  async removeMember(teamId: number, targetUserId: number) {
    // Cancel any pending invitations for this user in this team
    await this.db
      .update(schema.invitations)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(schema.invitations.teamId, teamId),
          eq(schema.invitations.inviteeId, targetUserId),
          eq(schema.invitations.status, 'pending'),
        ),
      );

    const rows = await this.db
      .delete(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, teamId),
          eq(schema.teamMembers.userId, targetUserId),
        ),
      )
      .returning();
    if (!rows[0]) throw new NotFoundException('Member not found');
  }

  async leaveTeam(teamId: number, userId: number) {
    const team = await this.getTeam(teamId);
    if (team.ownerId === userId) {
      throw new BadRequestException(
        'Owner cannot leave the team. Transfer ownership first.',
      );
    }

    const rows = await this.db
      .delete(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, teamId),
          eq(schema.teamMembers.userId, userId),
        ),
      )
      .returning();
    if (!rows[0])
      throw new NotFoundException('You are not a member of this team');
  }

  async transferOwnership(
    teamId: number,
    _currentOwnerId: number,
    newOwnerId: number,
  ) {
    // Verify new owner is a member
    const members = await this.db
      .select()
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, teamId),
          eq(schema.teamMembers.userId, newOwnerId),
        ),
      );
    if (!members[0]) {
      throw new BadRequestException('New owner must be a current team member');
    }

    const rows = await this.db
      .update(schema.teams)
      .set({ ownerId: newOwnerId })
      .where(eq(schema.teams.id, teamId))
      .returning();
    return rows[0];
  }

  async getTeamRepositories(teamId: number) {
    return this.db
      .select({
        id: schema.teamRepositories.id,
        teamId: schema.teamRepositories.teamId,
        repoUrl: schema.teamRepositories.repoUrl,
        addedAt: schema.teamRepositories.addedAt,
        repositoryId: min(schema.repositories.id),
        sessionCount: countDistinct(schema.logRepositories.logId),
      })
      .from(schema.teamRepositories)
      .leftJoin(
        schema.teamMembers,
        eq(schema.teamMembers.teamId, schema.teamRepositories.teamId),
      )
      .leftJoin(
        schema.repositories,
        and(
          eq(schema.repositories.repoUrl, schema.teamRepositories.repoUrl),
          eq(schema.repositories.userId, schema.teamMembers.userId),
        ),
      )
      .leftJoin(
        schema.logRepositories,
        eq(schema.logRepositories.repoId, schema.repositories.id),
      )
      .where(eq(schema.teamRepositories.teamId, teamId))
      .groupBy(
        schema.teamRepositories.id,
        schema.teamRepositories.teamId,
        schema.teamRepositories.repoUrl,
        schema.teamRepositories.addedAt,
      )
      .orderBy(asc(schema.teamRepositories.repoUrl));
  }

  /**
   * Canonical team repo URL for a user-supplied value. A raw local path (a repo without a git
   * remote) is scoped by the acting user's email first, so it matches the `repositories.repo_url`
   * identity ingest stores for that user.
   */
  private async toTeamRepoUrl(
    raw: string,
    actingUserId: number | undefined,
  ): Promise<string> {
    if (actingUserId !== undefined && isRawLocalPath(raw)) {
      const actingUser = await this.usersService.findById(actingUserId);
      if (actingUser) {
        return normalizeRepoUrl(toLocalRepoIdentity(actingUser.email, raw));
      }
    }
    return normalizeRepoUrl(raw);
  }

  async addTeamRepository(
    teamId: number,
    repoUrl: string,
    actingUserId?: number,
  ) {
    repoUrl = await this.toTeamRepoUrl(repoUrl, actingUserId);
    const rows = await this.db
      .insert(schema.teamRepositories)
      .values({ teamId, repoUrl })
      .onConflictDoNothing()
      .returning();

    if (!rows[0]) {
      // Already linked — return the existing row. Its config (or its deliberate absence
      // after a `null` save) is left alone: re-adding neither seeds nor recomputes.
      const existing = await this.db
        .select()
        .from(schema.teamRepositories)
        .where(
          and(
            eq(schema.teamRepositories.teamId, teamId),
            eq(schema.teamRepositories.repoUrl, repoUrl),
          ),
        );
      return existing[0];
    }

    const teamRepo = rows[0];

    // A new link gets the team's single config for the URL: the owner's personal config
    // when they have one, else the creation default — even when nobody has uploaded the URL
    // yet. The team's derived stats are then written over every same-URL session.
    const team = await this.getTeam(teamId);
    const initialConfig =
      (await findPersonalRepoConfig(this.db, team.ownerId, repoUrl)) ??
      TEAM_CREATION_DEFAULT_CONFIG;
    await seedTeamRepoConfig(this.db, teamRepo.id, initialConfig);
    await this.repositoriesService.recomputeTeamScope(teamId, repoUrl);

    return teamRepo;
  }

  async resolveOrCreateImportTeam(
    ownerId: number,
    repoUrl: string,
  ): Promise<number> {
    repoUrl = await this.toTeamRepoUrl(repoUrl, ownerId);

    const existing = await this.db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .innerJoin(
        schema.teamRepositories,
        eq(schema.teamRepositories.teamId, schema.teams.id),
      )
      .where(
        and(
          eq(schema.teams.ownerId, ownerId),
          eq(schema.teamRepositories.repoUrl, repoUrl),
        ),
      )
      .orderBy(asc(schema.teams.id));

    let teamId: number;
    if (existing[0]) {
      teamId = existing[0].id;
    } else {
      const baseName = `Imported: ${repoUrl}`;
      let attempt = 0;
      let team: typeof schema.teams.$inferSelect | undefined;

      while (true) {
        attempt++;
        const name = attempt === 1 ? baseName : `${baseName} (${attempt})`;
        try {
          team = await this.createTeam(ownerId, name);
          break;
        } catch (err: unknown) {
          if (
            err instanceof ConflictException &&
            attempt < MAX_TEAM_NAME_ATTEMPTS
          ) {
            continue;
          }
          throw err;
        }
      }

      // No visibility override here — an auto-created
      // import team takes the 'restricted' default like every other creation
      // path.
      teamId = team.id;
    }

    await this.addTeamRepository(teamId, repoUrl, ownerId);
    return teamId;
  }

  async addMemberIfRealUser(teamId: number, userId: number): Promise<void> {
    const rows = await this.db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    const passwordHash = rows[0]?.passwordHash;
    if (
      !passwordHash ||
      passwordHash === PLACEHOLDER_IMPORT_USER_PASSWORD_HASH
    ) {
      return;
    }

    // `disclosureAcknowledgedAt` is deliberately left unset. This path
    // (repository import) adds the member with no "Accept" step, so they have
    // never been shown the access-mode disclosure. Until they acknowledge it at
    // login their sessions stay invisible to the team owner and to trainers.
    // Do NOT stamp a timestamp here.
    await this.db
      .insert(schema.teamMembers)
      .values({ teamId, userId, canInvite: false })
      .onConflictDoNothing();
  }

  async unlinkTeamRepository(teamId: number, repoId: number): Promise<void> {
    // The link's team_repo_config row goes with it by FK cascade.
    const rows = await this.db
      .delete(schema.teamRepositories)
      .where(
        and(
          eq(schema.teamRepositories.id, repoId),
          eq(schema.teamRepositories.teamId, teamId),
        ),
      )
      .returning();
    if (!rows[0]) throw new NotFoundException('Repository not found');
  }

  async removeTeamRepository(teamId: number, repoId: number): Promise<void> {
    // 1. Fetch the repoUrl for this (teamId, repoId) pair
    const teamRepoRows = await this.db
      .select()
      .from(schema.teamRepositories)
      .where(
        and(
          eq(schema.teamRepositories.id, repoId),
          eq(schema.teamRepositories.teamId, teamId),
        ),
      );
    if (!teamRepoRows[0]) throw new NotFoundException('Repository not found');
    const { repoUrl } = teamRepoRows[0];

    await this.db.transaction(async (tx) => {
      // 2. Delete this team's team_repositories entry only (its team_repo_config row
      //    goes with it by FK cascade)
      await tx
        .delete(schema.teamRepositories)
        .where(
          and(
            eq(schema.teamRepositories.id, repoId),
            eq(schema.teamRepositories.teamId, teamId),
          ),
        );

      // 3. Check if any other team still references this URL; if so, preserve logs/repositories
      const otherTeamRefs = await tx
        .select({ id: schema.teamRepositories.id })
        .from(schema.teamRepositories)
        .where(eq(schema.teamRepositories.repoUrl, repoUrl))
        .limit(1);

      if (otherTeamRefs.length > 0) {
        return; // Another team still uses this URL — leave repositories and logs intact
      }

      // 4. No other team references the URL — delete logs and repositories
      const repoRows = await tx
        .select({ id: schema.repositories.id })
        .from(schema.repositories)
        .where(eq(schema.repositories.repoUrl, repoUrl));

      if (repoRows.length > 0) {
        const repoIds = repoRows.map((r) => r.id);

        // 4a. Collect logIds from log_repositories
        const logRepoRows = await tx
          .select({ logId: schema.logRepositories.logId })
          .from(schema.logRepositories)
          .where(inArray(schema.logRepositories.repoId, repoIds));

        const logIds = [...new Set(logRepoRows.map((r) => r.logId))];

        if (logIds.length > 0) {
          // 4b. Collect sessionIds from logs
          const logRows = await tx
            .select({ sessionId: schema.logs.sessionId })
            .from(schema.logs)
            .where(inArray(schema.logs.id, logIds));

          const sessionIds = [
            ...new Set(
              logRows
                .map((r) => r.sessionId)
                .filter((id): id is number => id !== null),
            ),
          ];

          // 4c. Delete logs (cascades log_repositories and log_contexts)
          await tx.delete(schema.logs).where(inArray(schema.logs.id, logIds));

          // 4d. Delete orphaned sessions (those with no remaining logs)
          if (sessionIds.length > 0) {
            const stillReferencedRows = await tx
              .selectDistinct({ sessionId: schema.logs.sessionId })
              .from(schema.logs)
              .where(inArray(schema.logs.sessionId, sessionIds));
            const stillReferenced = new Set(
              stillReferencedRows
                .map((r) => r.sessionId)
                .filter((id): id is number => id !== null),
            );
            const orphanIds = sessionIds.filter(
              (id) => !stillReferenced.has(id),
            );
            if (orphanIds.length > 0) {
              await tx
                .delete(schema.sessions)
                .where(inArray(schema.sessions.id, orphanIds));
              // DD-11: sweep harness_snapshots rows no session references any more, now
              // that these orphaned sessions are gone.
              await deleteOrphanHarnessSnapshots(tx);
            }
          }
        }

        // 4e. Delete repositories rows (cascades repo_config)
        await tx
          .delete(schema.repositories)
          .where(eq(schema.repositories.repoUrl, repoUrl));
      }
    });
  }

  async sendInvitation(
    teamId: number,
    inviterId: number,
    inviteeEmail: string,
    force = false,
  ) {
    const team = await this.getTeam(teamId);

    // Check invite permission — the team owner, or a member with `canInvite`
    // (the app admin role grants no override)
    if (team.ownerId !== inviterId) {
      const membership = await this.db
        .select()
        .from(schema.teamMembers)
        .where(
          and(
            eq(schema.teamMembers.teamId, teamId),
            eq(schema.teamMembers.userId, inviterId),
          ),
        );
      if (!membership[0] || !membership[0].canInvite) {
        throw new ForbiddenException(
          'You do not have permission to invite members',
        );
      }
    }

    // Find invitee
    let invitee = await this.usersService.findByEmail(inviteeEmail);
    let autoProvisioned = false;
    if (!invitee) {
      if (!force) {
        throw new NotFoundException({
          error: 'user_not_registered',
          message: 'User not found',
        });
      }
      invitee =
        await this.usersService.findOrCreateAutoProvisioned(inviteeEmail);
      autoProvisioned = true;
    }

    // Check not already a member
    const existing = await this.db
      .select()
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, teamId),
          eq(schema.teamMembers.userId, invitee.id),
        ),
      );
    if (existing[0]) throw new ConflictException('User is already a member');

    if (autoProvisioned) {
      return this.db.transaction(async (tx) => {
        // `disclosureAcknowledgedAt` is deliberately left unset. The
        // force-invite branch grants membership without an "Accept" step, so
        // the auto-provisioned user has never read the access-mode disclosure.
        // Until they acknowledge it at login their sessions stay invisible to
        // the team owner and to trainers. Do NOT stamp a timestamp here.
        await tx.insert(schema.teamMembers).values({
          teamId,
          userId: invitee.id,
          canInvite: false,
        });

        // Stays 'pending' (not 'accepted') even though membership is already
        // granted above: the inviter's Invitations tab should read the same
        // as any other not-yet-accepted invite until the invitee actually
        // logs in for the first time. UsersService.acceptGrantedInvitations()
        // flips it to 'accepted' at that point — see its docstring for why
        // that lives on UsersService rather than here.
        const rows = await tx
          .insert(schema.invitations)
          .values({
            teamId,
            inviterId,
            inviteeId: invitee.id,
            status: 'pending',
          })
          .returning();
        return rows[0];
      });
    }

    // Insert invitation (partial unique index handles duplicate pending)
    try {
      const rows = await this.db
        .insert(schema.invitations)
        .values({
          teamId,
          inviterId,
          inviteeId: invitee.id,
          status: 'pending',
        })
        .returning();
      return rows[0];
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Pending invitation already exists');
      }
      throw err;
    }
  }

  async cancelInvitation(teamId: number, invId: number, callerId: number) {
    const invitation = await this.db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.id, invId),
          eq(schema.invitations.teamId, teamId),
        ),
      );
    if (!invitation[0]) throw new NotFoundException('Invitation not found');

    const team = await this.getTeam(teamId);
    if (team.ownerId !== callerId) {
      throw new ForbiddenException(
        'Only the team owner can cancel invitations',
      );
    }

    const rows = await this.db
      .update(schema.invitations)
      .set({ status: 'cancelled' })
      .where(eq(schema.invitations.id, invId))
      .returning();
    return rows[0];
  }

  /**
   * Invitations the caller is involved in, in BOTH directions: ones addressed
   * to them (the notification bell) and ones they sent (a team's Invitations
   * tab). Callers that only want one direction must filter on
   * `inviteeId`/`inviterId` themselves — `teamName` is joined in so an incoming
   * invitation can be shown by name before the invitee is a member of that
   * team (they cannot read it from GET /api/v1/teams yet).
   *
   * `accessMode` and `hasTrainer` travel with the row so the invitee can be
   * shown the access-mode disclosure before they accept, without first being able to
   * read the team itself.
   */
  async listInvitations(userId: number) {
    const inviteeUsers = alias(schema.users, 'invitee');
    return this.db
      .select({
        id: schema.invitations.id,
        teamId: schema.invitations.teamId,
        teamName: schema.teams.name,
        accessMode: schema.teams.accessMode,
        hasTrainer: sql<boolean>`EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.team_id = ${schema.invitations.teamId}
            AND tm.is_adlc_trainer
        )`,
        inviterId: schema.invitations.inviterId,
        inviteeId: schema.invitations.inviteeId,
        inviteeEmail: inviteeUsers.email,
        status: schema.invitations.status,
        createdAt: schema.invitations.createdAt,
      })
      .from(schema.invitations)
      .innerJoin(
        inviteeUsers,
        eq(inviteeUsers.id, schema.invitations.inviteeId),
      )
      .innerJoin(schema.teams, eq(schema.teams.id, schema.invitations.teamId))
      .where(
        or(
          eq(schema.invitations.inviteeId, userId),
          eq(schema.invitations.inviterId, userId),
        ),
      );
  }

  /**
   * `acknowledgedAccessMode` is the mode the invitee was actually shown in the
   * access-mode disclosure. It is required on `accept` and must still match the
   * team's live mode — otherwise a card rendered before an
   * owner flipped the mode would consent to the wrong contract.
   */
  async respondToInvitation(
    invId: number,
    inviteeId: number,
    action: 'accept' | 'decline',
    acknowledgedAccessMode?: 'transparent' | 'restricted',
  ) {
    const rows = await this.db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.id, invId));
    const invitation = rows[0];
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.inviteeId !== inviteeId) {
      throw new ForbiddenException('Not your invitation');
    }
    if (invitation.status !== 'pending') {
      throw new BadRequestException('Invitation is no longer pending');
    }

    if (action === 'accept') {
      const team = await this.getTeam(invitation.teamId);
      if (acknowledgedAccessMode === undefined) {
        throw new BadRequestException(
          'acknowledgedAccessMode is required when accepting an invitation',
        );
      }
      if (acknowledgedAccessMode !== team.accessMode) {
        throw new BadRequestException(
          "This team's access mode changed — reload the invitation and read the disclosure again",
        );
      }

      const acknowledgedAt = new Date();
      await this.db.transaction(async (tx) => {
        await tx
          .update(schema.invitations)
          .set({ status: 'accepted' })
          .where(eq(schema.invitations.id, invId));

        // Accepting the invitation IS the acknowledgement: the invitee has
        // just been shown the access-mode disclosure for exactly this mode, so they
        // never see the login-time gate for this team.
        await tx.insert(schema.teamMembers).values({
          teamId: invitation.teamId,
          userId: inviteeId,
          canInvite: false,
          disclosureAcknowledgedAt: acknowledgedAt,
        });
      });
    } else {
      await this.db
        .update(schema.invitations)
        .set({ status: 'declined' })
        .where(eq(schema.invitations.id, invId));
    }
  }

  /**
   * Teams the caller belongs to without ever having acknowledged the
   * access-mode disclosure. Populated by the two membership paths that
   * have no "Accept" step — the force-invite branch of `sendInvitation` and
   * `addMemberIfRealUser` — and drained by `acknowledgeDisclosure`. The client
   * shows one modal per returned row at login time.
   */
  async listPendingDisclosures(userId: number) {
    return this.db
      .select({
        teamId: schema.teamMembers.teamId,
        teamName: schema.teams.name,
        accessMode: schema.teams.accessMode,
        hasTrainer: sql<boolean>`EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.team_id = ${schema.teamMembers.teamId}
            AND tm.is_adlc_trainer
        )`,
      })
      .from(schema.teamMembers)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
      .where(
        and(
          eq(schema.teamMembers.userId, userId),
          isNull(schema.teamMembers.disclosureAcknowledgedAt),
        ),
      )
      .orderBy(asc(schema.teamMembers.teamId));
  }

  /**
   * Stamps `disclosure_acknowledged_at` for the caller's own membership row.
   * `acknowledgedAccessMode` is checked against the team's live mode for the
   * same reason as on invitation accept: the modal the
   * member read must describe the contract they are consenting to.
   */
  async acknowledgeDisclosure(
    teamId: number,
    userId: number,
    acknowledgedAccessMode: 'transparent' | 'restricted',
  ) {
    const team = await this.getTeam(teamId);
    if (acknowledgedAccessMode !== team.accessMode) {
      throw new BadRequestException(
        "This team's access mode changed — reload and read the disclosure again",
      );
    }

    const rows = await this.db
      .update(schema.teamMembers)
      .set({ disclosureAcknowledgedAt: new Date() })
      .where(
        and(
          eq(schema.teamMembers.teamId, teamId),
          eq(schema.teamMembers.userId, userId),
        ),
      )
      .returning();
    // TeamAccessGuard already admits members only; a missing row means the
    // membership vanished between the guard and this update.
    if (!rows[0]) throw new NotFoundException('Member not found');

    return { acknowledged: true as const };
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e['code'] === '23505') return true;
  // Drizzle v0.45+ wraps pg errors in DrizzleQueryError — check cause
  if (e['cause'] !== undefined) return isUniqueViolation(e['cause']);
  return false;
}
