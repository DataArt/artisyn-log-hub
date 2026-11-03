import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import * as schema from '../database/schema';
import type {
  AuthUser,
  RepositoriesService,
  RepositoryRow,
} from './repositories.service';

/** What a caller admitted to a session's raw logs may read them by. */
export interface SessionLogsAccess {
  /** The repository row `assertRepoAccess` resolved. */
  repo: RepositoryRow;
  /** Internal `sessions.id` of the requested (root) session. */
  sessionRowId: number;
  harnessSnapshotId: string | null;
  /** The artisyn log owner — the session owner, not the caller. */
  ownerUserId: number | undefined;
}

/**
 * The access chain of the session raw-log routes (`/logs` and `/logs/delta`), so both answer
 * with the same errors by construction:
 *
 * - 400 when `teamId` is not a positive integer;
 * - whatever `assertRepoAccess` throws;
 * - 404 when the session is not linked (through its artisyn log) to this repo — or to any
 *   team-member repo with the same `repoUrl` — or has been soft-deleted;
 * - 403 for a non-owner caller no team rule admits.
 */
export async function resolveSessionLogsAccess(
  db: DrizzleDb,
  repositoriesService: RepositoriesService,
  user: AuthUser,
  repoId: number,
  sessionId: string,
  teamId: number | undefined,
): Promise<SessionLogsAccess> {
  if (teamId !== undefined && teamId <= 0) {
    throw new BadRequestException('teamId must be a positive integer');
  }

  const repo = await repositoriesService.assertRepoAccess(user, repoId, teamId);
  const repoIds = await repositoriesService.resolveRepoIds(
    repoId,
    repo.repoUrl,
    teamId,
  );
  const repoCondition =
    repoIds.length === 1
      ? eq(schema.logRepositories.repoId, repoIds[0])
      : inArray(schema.logRepositories.repoId, repoIds);

  // Step 1: verify session belongs to this repo (or any team-member repo with the
  // same repoUrl) via the artisyn log's repo link.
  // (Only artisyn logs are linked in log_repositories; claude logs share the session row.)
  // Also reject if the session has been soft-deleted.
  const [sessionCheck] = await db
    .select({
      sessionRowId: schema.sessions.id,
      harnessSnapshotId: schema.sessions.harnessSnapshotId,
    })
    .from(schema.sessions)
    .innerJoin(schema.logs, eq(schema.logs.sessionId, schema.sessions.id))
    .innerJoin(
      schema.logRepositories,
      eq(schema.logRepositories.logId, schema.logs.id),
    )
    .where(
      and(
        eq(schema.sessions.sessionId, sessionId),
        repoCondition,
        eq(schema.logs.logType, 'artisyn'),
        eq(schema.sessions.deleted, false),
      ),
    );

  if (!sessionCheck) throw new NotFoundException('Session logs not found');

  // Step 1b: owner-only guard — non-owner callers receive 403 Forbidden unless a
  // team rule below admits them. The app admin role grants no bypass.
  const [sessionOwnerRow] = await db
    .select({ userId: schema.logs.userId })
    .from(schema.logs)
    .where(
      and(
        eq(schema.logs.sessionId, sessionCheck.sessionRowId),
        eq(schema.logs.logType, 'artisyn'),
      ),
    );
  if (sessionOwnerRow?.userId !== user.id) {
    // Team-owner exception: the owner of the team this repo/session is shared with
    // may fetch any member's session logs.
    const isTeamOwnerCaller =
      teamId !== undefined &&
      (await repositoriesService.isTeamOwner(user.id, teamId));

    // This route returns the raw conversation, so the team access
    // mode reaches it through two extra conditions, both only in a `restricted` team:
    //
    // - the team-owner exception above additionally requires the target member to have
    //   acknowledged the disclosure — an unacknowledged member is invisible to
    //   their team owner everywhere, this route included;
    // - a new clause admits an `adlc trainer` (`team-with-prompts` without being the
    //   team owner), under the same acknowledgement condition.
    //
    // A `manager` resolves to `team-no-prompts` and so still gets 403 here (the
    // conversation body is not returned).
    //
    // In a `transparent` team every member sees everything, raw logs included — the old
    // "raw logs stay owner-only" rule no longer applies there. Team membership
    // and the repo's team link were already enforced by `assertRepoAccess`.
    const scope = await repositoriesService.resolveTeamScope(user, teamId);

    let allowed: boolean;
    if (scope.accessMode === 'restricted' && scope.visibleUserIds !== null) {
      const ownerId = sessionOwnerRow?.userId;
      const ownerAcknowledged =
        ownerId !== undefined && scope.visibleUserIds.includes(ownerId);
      allowed =
        ownerAcknowledged &&
        (isTeamOwnerCaller || scope.visibility === 'team-with-prompts');
    } else if (scope.accessMode === 'transparent') {
      allowed = true;
    } else {
      allowed = isTeamOwnerCaller;
    }

    if (!allowed) {
      throw new ForbiddenException();
    }
  }

  return {
    repo,
    sessionRowId: sessionCheck.sessionRowId,
    harnessSnapshotId: sessionCheck.harnessSnapshotId,
    ownerUserId: sessionOwnerRow?.userId,
  };
}
