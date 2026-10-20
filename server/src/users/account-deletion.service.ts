import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, eq, inArray, ne, or } from 'drizzle-orm';
import { AuthSessionsService } from '../auth/auth-sessions.service';
import { invalidateApiKeyCache } from '../cluster/api-key-cache-ipc';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import {
  invitations,
  logs,
  repositories,
  sessions,
  teamRepositories,
  teams,
  users,
} from '../database/schema/index';

export interface DeletedUserSummary {
  id: number;
  email: string;
}

/**
 * Who triggered the deletion, for the security event log. `self-service` is
 * `POST /api/v1/auth/delete-account` (actingUserId === the deleted user);
 * `admin` is `POST /api/v1/admin/users/:id/delete`, where the two differ.
 */
export interface DeletionActor {
  actingUserId: number;
  via: 'self-service' | 'admin';
}

/**
 * Postgres refuses a statement carrying more than 65535 bind parameters, and
 * Drizzle emits one parameter per element of an `inArray(...)` list. A prolific
 * user can easily own more session ids than that, so every id/url list below is
 * walked in bounded batches instead of being interpolated in one go.
 */
const BIND_BATCH_SIZE = 1000;

function batched<T>(items: T[], size = BIND_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Hard-deletes a user account and everything that belongs to it.
 *
 * The owner's decision for this task is explicit: **all** of the user's data
 * goes, logs included. Most of that happens through the FK cascades that
 * already exist on `users.id` — `api_keys`, `password_reset_tokens`,
 * `email_confirmation_tokens`, `repositories`, `logs`, `logs_otel`,
 * `team_members`, `upload_queue`, `export_import_jobs`, `repo_config`
 * (personal rows only; a team's `team_repo_config` cascades from its
 * `team_repositories` link), `session_file_stats`, `session_cause_stats` and `user_favorite_sessions` all
 * carry `ON DELETE CASCADE`. This service only has to handle the rows the
 * cascades do *not* cover, and it does so in one transaction so a partially
 * deleted account can never be observed:
 *
 * 1. `invitations.inviter_id` / `invitee_id` have **no** `onDelete` clause
 *    (`database/schema/index.ts:341-346`), i.e. `NO ACTION` — leaving them in
 *    place would abort the `users` delete with an FK violation.
 * 2. `teams.owner_id` is `ON DELETE RESTRICT`
 *    (`database/schema/index.ts:289-291`), so owned teams are deleted first
 *    (their members, team repositories and invitations cascade away with them).
 * 3. `team_repositories` is keyed by `repo_url`, not by a repository id, so no
 *    cascade can reach it. Rows are dropped only for urls that no *other*
 *    user's `repositories` row still claims — mirroring
 *    `AdminService.removeRepo` (`admin/admin.service.ts:335-340`).
 * 4. `logs.session_id` has no `onDelete` either, so a `sessions` row survives
 *    the cascade that removed its logs. The session ids the user's logs pointed
 *    at are captured *before* the delete and the ones left with no remaining
 *    `logs` row are removed afterwards — the same orphan check as
 *    `AdminService.removeRepo` (`admin/admin.service.ts:316-332`).
 */
@Injectable()
export class AccountDeletionService {
  /** Security event log — ids and emails only, no credentials. */
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly authSessionsService: AuthSessionsService,
  ) {}

  /**
   * Deletes the user and all of their data. Returns the deleted user's id and
   * email so callers can report/log what went away.
   *
   * @param actor who requested the deletion — logged, never used for access
   *   control (both call sites do their own authorization first).
   * @throws NotFoundException when the user does not exist.
   * @throws BadRequestException when the user is the last remaining admin.
   */
  async hardDeleteUser(
    userId: number,
    actor: DeletionActor,
  ): Promise<DeletedUserSummary> {
    const deleted = await this.db.transaction(async (tx) => {
      // `for update` locks the target row for the whole transaction, so a
      // concurrent role change cannot slip past the last-admin guard below.
      const userRows = await tx
        .select({ id: users.id, email: users.email, role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      const user = userRows[0];
      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (user.role === 'admin') {
        const adminRows = await tx
          .select({ value: count() })
          .from(users)
          .where(eq(users.role, 'admin'));
        if ((adminRows[0]?.value ?? 0) <= 1) {
          throw new BadRequestException('Cannot delete the last admin');
        }
      }

      // Captured inside the transaction: a log inserted concurrently would
      // otherwise create a session this pass never checks, leaving an orphan.
      const sessionIdRows = await tx
        .selectDistinct({ sessionId: logs.sessionId })
        .from(logs)
        .where(eq(logs.userId, userId));
      const sessionIds = sessionIdRows.map((r) => r.sessionId);

      // (1) invitations — no cascade on either FK.
      await tx
        .delete(invitations)
        .where(
          or(
            eq(invitations.inviterId, userId),
            eq(invitations.inviteeId, userId),
          ),
        );

      // (2) owned teams — `teams.owner_id` is ON DELETE RESTRICT.
      await tx.delete(teams).where(eq(teams.ownerId, userId));

      // (3) team_repositories rows for urls nobody else owns (their team_repo_config
      //     rows go by FK cascade).
      const ownedUrlRows = await tx
        .selectDistinct({ repoUrl: repositories.repoUrl })
        .from(repositories)
        .where(eq(repositories.userId, userId));
      const ownedUrls = ownedUrlRows.map((r) => r.repoUrl);
      const exclusiveUrls: string[] = [];
      for (const chunk of batched(ownedUrls)) {
        const sharedRows = await tx
          .selectDistinct({ repoUrl: repositories.repoUrl })
          .from(repositories)
          .where(
            and(
              inArray(repositories.repoUrl, chunk),
              ne(repositories.userId, userId),
            ),
          );
        const shared = new Set(sharedRows.map((r) => r.repoUrl));
        exclusiveUrls.push(...chunk.filter((url) => !shared.has(url)));
      }
      for (const chunk of batched(exclusiveUrls)) {
        await tx
          .delete(teamRepositories)
          .where(inArray(teamRepositories.repoUrl, chunk));
      }

      // The cascades do the bulk of the work here.
      await tx.delete(users).where(eq(users.id, userId));

      // (4) sessions left with no logs at all.
      for (const chunk of batched(sessionIds)) {
        const stillReferencedRows = await tx
          .selectDistinct({ sessionId: logs.sessionId })
          .from(logs)
          .where(inArray(logs.sessionId, chunk));
        const stillReferenced = new Set(
          stillReferencedRows.map((r) => r.sessionId),
        );
        const orphanIds = chunk.filter((id) => !stillReferenced.has(id));
        if (orphanIds.length > 0) {
          await tx.delete(sessions).where(inArray(sessions.id, orphanIds));
        }
      }

      return { id: user.id, email: user.email };
    });

    // Runs after the commit: `auth_sessions` is owned by connect-pg-simple and
    // sits outside this transaction, and the pruning must not be able to roll
    // the deletion back (it never throws anyway).
    await this.authSessionsService.deleteAllSessionsForUser(userId);

    // The user's api_keys rows went with the cascade; drop any cached
    // validations too, here and (via the primary) in every other worker.
    invalidateApiKeyCache({ userId });

    this.logger.log(
      `Account deleted: userId=${deleted.id} email=${deleted.email} ` +
        `actingUserId=${actor.actingUserId} via=${actor.via}`,
    );

    return deleted;
  }
}
