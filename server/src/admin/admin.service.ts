import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  and,
  asc,
  countDistinct,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  min,
  sql,
} from 'drizzle-orm';
import { MailService } from '../mail/mail.service';
import { getEmailLinkBaseUrl } from '../common/public-base-url';
import { EmailConfirmationTokensService } from '../auth/email-confirmation-tokens.service';
import { TooManyRequestsException } from '../auth/exceptions/too-many-requests.exception';
import { UsersService } from '../users/users.service';
import { SessionsService } from '../sessions/sessions.service';
import { TeamsService } from '../teams/teams.service';
import { getDescendantSessionIds } from '../logs/session-tree.sql';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import {
  emailConfirmationTokens,
  logRepositories,
  logs,
  repositories,
  teamMembers,
  teamRepositories,
  teams,
  users,
} from '../database/schema/index';

export interface AdminAuthConfig {
  mode: string | undefined;
  smtp?: { host: string; port: number; from: string };
  azure?: {
    tenantId: string;
    clientId: string;
    redirectUri: string;
    authority: string;
  };
}

export interface PendingRegistration {
  id: number;
  email: string;
  registeredAt: Date;
  tokenExpiresAt: Date;
}

export interface RepoRow {
  id: number | null;
  repoUrl: string;
  ownerEmail: string | null;
  sessionCount: number;
  rawUploadCount: number;
  logSize: number;
  maxUploadBytes: number | null;
  lastSession: Date | null;
  firstSeen: Date | null;
  /** Orphan rows (`id === null`) only — the `team_repositories` link they stand for. */
  teamId?: number;
  teamRepoId?: number;
  /**
   * Orphan rows: the linking team's name. Real rows: every team linking the URL,
   * comma-joined by name, or `null` when no team links it.
   */
  teamName?: string | null;
}

/** Member identity only — the admin "Set new owner" picker never sees session data. */
export interface AdminTeamMemberRow {
  userId: number;
  email: string;
  isOwner: boolean;
}

export interface TeamRow {
  id: number;
  name: string;
  ownerEmail: string;
  createdAt: Date;
  memberCount: number;
  repoCount: number;
}

export interface UserRow {
  id: number;
  email: string;
  role: string;
  createdAt: Date;
  teamCount: number;
  lastActivity: Date | null;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly emailConfirmationTokensService: EmailConfirmationTokensService,
    private readonly mailService: MailService,
    private readonly sessionsService: SessionsService,
    private readonly teamsService: TeamsService,
  ) {}

  getAuthConfig(): AdminAuthConfig {
    const mode = this.configService.get<string>('AUTH_MODE');
    const response: AdminAuthConfig = { mode };

    // Only when SMTP applies to the mode and SMTP_HOST is set (Mode 3, or
    // Mode 2 with SMTP). No code defaults: the card shows the real settings.
    if (this.mailService.isConfigured()) {
      response.smtp = {
        host: this.configService.get<string>('SMTP_HOST') ?? '',
        port: Number(this.configService.get<string>('SMTP_PORT')),
        from: this.configService.get<string>('SMTP_FROM') ?? '',
      };
    }
    if (mode === 'azure-oauth') {
      const tenantId = this.configService.get<string>('AZURE_TENANT_ID', '');
      response.azure = {
        tenantId,
        clientId: this.configService.get<string>('AZURE_CLIENT_ID', ''),
        redirectUri: this.configService.get<string>('AZURE_REDIRECT_URI', ''),
        authority: this.configService.get<string>(
          'AZURE_AUTHORITY',
          `https://login.microsoftonline.com/${tenantId}/v2.0`,
        ),
      };
    }
    return response;
  }

  async getPendingRegistrations(): Promise<PendingRegistration[]> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        registeredAt: users.createdAt,
        tokenExpiresAt: max(emailConfirmationTokens.expiresAt),
      })
      .from(users)
      .innerJoin(
        emailConfirmationTokens,
        eq(emailConfirmationTokens.userId, users.id),
      )
      .where(
        and(
          isNotNull(users.passwordHash),
          isNull(users.emailConfirmedAt),
          isNull(emailConfirmationTokens.consumedAt),
        ),
      )
      .groupBy(users.id, users.email, users.createdAt)
      .orderBy(asc(users.createdAt))
      .execute();

    return rows
      .filter((r): r is typeof r & { tokenExpiresAt: Date } =>
        Boolean(r.tokenExpiresAt),
      )
      .map((r) => ({
        id: r.id,
        email: r.email,
        registeredAt: r.registeredAt,
        tokenExpiresAt: r.tokenExpiresAt,
      }));
  }

  /** 404 if the id no longer exists; 409 if already confirmed. */
  async resendPendingRegistration(
    userId: number,
  ): Promise<{ email_delivery: 'sent' | 'failed' }> {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException();
    if (user.emailConfirmedAt) throw new ConflictException();

    const result = await this.emailConfirmationTokensService.issueWithCooldown(
      user.id,
    );
    if (result.status === 'cooldown') {
      throw new TooManyRequestsException(result.retryAfterSeconds);
    }

    // Emailed link: PUBLIC_BASE_URL only, never the request Host.
    const base = getEmailLinkBaseUrl(this.logger);
    if (base === null) return { email_delivery: 'failed' };
    const confirmUrl = `${base}/#/confirm-email?token=${result.token}`;
    const email_delivery = await this.mailService.sendConfirmationEmail(
      user.email,
      confirmUrl,
    );
    return { email_delivery };
  }

  /** Same 404-vs-409 guard as resend — a since-confirmed account is not deleted. */
  async revokePendingRegistration(userId: number): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException();
    if (user.emailConfirmedAt) throw new ConflictException();

    const deletedId = await this.usersService.deleteIfUnconfirmed(userId);
    if (deletedId === null) throw new NotFoundException();
  }

  async getRepos(): Promise<RepoRow[]> {
    const rows = await this.db
      .select({
        id: repositories.id,
        repoUrl: repositories.repoUrl,
        ownerEmail: users.email,
        rawUploadCount: countDistinct(logs.sessionId),
        sessionCount: sql<number>`(
          SELECT COUNT(DISTINCT l.session_id)
          FROM logs l
          INNER JOIN log_repositories lr ON lr.log_id = l.id AND lr.repo_id = ${repositories.id}
          INNER JOIN sessions s ON s.id = l.session_id AND s.deleted = false
          WHERE l.log_type = 'artisyn'
            AND l.first_prompt IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM logs cl
              WHERE cl.session_id = l.session_id
                AND cl.log_type = 'claude'
            )
        )`,
        // pg_column_size() reads the on-disk (TOASTed) representation directly;
        // octet_length(body::text) forces a full JSON re-serialization of every
        // row before summing, which is fine for small payloads but turns into a
        // multi-second scan once individual log bodies reach multi-MB size.
        logSize: sql<number>`COALESCE(SUM(pg_column_size(${logs.body})), 0)`,
        maxUploadBytes: max(repositories.maxUploadBytes),
        lastSession: max(logs.endTime),
        firstSeen: min(logs.startTime),
        teamName: sql<string | null>`(
          SELECT string_agg(t.name, ', ' ORDER BY t.name)
          FROM team_repositories tr
          INNER JOIN teams t ON t.id = tr.team_id
          WHERE tr.repo_url = ${repositories.repoUrl}
        )`,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.userId))
      .leftJoin(logRepositories, eq(logRepositories.repoId, repositories.id))
      .leftJoin(logs, eq(logs.id, logRepositories.logId))
      .groupBy(repositories.id, repositories.repoUrl, users.email)
      .orderBy(asc(repositories.repoUrl))
      .execute();

    const repoRows: RepoRow[] = rows.map((r) => ({
      id: r.id,
      repoUrl: r.repoUrl,
      ownerEmail: r.ownerEmail,
      rawUploadCount: Number(r.rawUploadCount),
      sessionCount: Number(r.sessionCount),
      logSize: Number(r.logSize),
      maxUploadBytes:
        r.maxUploadBytes !== null ? Number(r.maxUploadBytes) : null,
      lastSession: r.lastSession,
      firstSeen: r.firstSeen,
      teamName: r.teamName,
    }));

    const orphanRows = await this.db
      .select({
        teamRepoId: teamRepositories.id,
        repoUrl: teamRepositories.repoUrl,
        teamId: teamRepositories.teamId,
        teamName: teams.name,
      })
      .from(teamRepositories)
      .innerJoin(teams, eq(teams.id, teamRepositories.teamId))
      .leftJoin(
        repositories,
        eq(repositories.repoUrl, teamRepositories.repoUrl),
      )
      .where(isNull(repositories.id))
      .orderBy(asc(teamRepositories.repoUrl))
      .execute();

    const orphanRepoRows: RepoRow[] = orphanRows.map((r) => ({
      id: null,
      repoUrl: r.repoUrl,
      ownerEmail: null,
      rawUploadCount: 0,
      sessionCount: 0,
      logSize: 0,
      maxUploadBytes: null,
      lastSession: null,
      firstSeen: null,
      teamId: r.teamId,
      teamRepoId: r.teamRepoId,
      teamName: r.teamName,
    }));

    return [...repoRows, ...orphanRepoRows];
  }

  async removeRepo(repositoryId: number): Promise<void> {
    const repoRows = await this.db
      .select({ repoUrl: repositories.repoUrl })
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    if (!repoRows[0]) throw new NotFoundException('Repository not found');
    const { repoUrl } = repoRows[0];

    await this.db.transaction(async (tx) => {
      const allRepoRows = await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.repoUrl, repoUrl));

      if (allRepoRows.length > 0) {
        const repoIds = allRepoRows.map((r) => r.id);

        const logRepoRows = await tx
          .select({ logId: logRepositories.logId })
          .from(logRepositories)
          .where(inArray(logRepositories.repoId, repoIds));

        const logIds = [...new Set(logRepoRows.map((r) => r.logId))];

        if (logIds.length > 0) {
          const logRows = await tx
            .select({ sessionId: logs.sessionId })
            .from(logs)
            .where(inArray(logs.id, logIds));

          const sessionIds = [
            ...new Set(
              logRows
                .map((r) => r.sessionId)
                .filter((id): id is number => id !== null),
            ),
          ];

          await tx.delete(logs).where(inArray(logs.id, logIds));

          // Only artisyn logs are linked through log_repositories, and a session
          // has at most one (logs is unique on session_id + log_type). With it
          // gone the session belongs to no repository, so remove the whole
          // family — its claude / claude-otel logs, stats and sub-agent sessions
          // would otherwise stay behind as unreachable rows.
          if (sessionIds.length > 0) {
            const descendants = await getDescendantSessionIds(tx, sessionIds);
            const familyIds = [
              ...new Set([...sessionIds, ...[...descendants.values()].flat()]),
            ];
            await this.sessionsService.hardDeleteSessionsInTx(tx, familyIds);
          }
        }

        await tx.delete(repositories).where(eq(repositories.repoUrl, repoUrl));
      }

      await tx
        .delete(teamRepositories) // team_repo_config rows go by FK cascade
        .where(eq(teamRepositories.repoUrl, repoUrl));
    });
  }

  async getTeams(): Promise<TeamRow[]> {
    const rows = await this.db
      .select({
        id: teams.id,
        name: teams.name,
        ownerEmail: users.email,
        createdAt: teams.createdAt,
        memberCount: countDistinct(teamMembers.userId),
        repoCount: countDistinct(teamRepositories.id),
      })
      .from(teams)
      .innerJoin(users, eq(users.id, teams.ownerId))
      .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .leftJoin(teamRepositories, eq(teamRepositories.teamId, teams.id))
      .groupBy(teams.id, teams.name, users.email, teams.createdAt)
      .orderBy(asc(teams.name))
      .execute();

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerEmail: r.ownerEmail,
      createdAt: r.createdAt,
      memberCount: Number(r.memberCount),
      repoCount: Number(r.repoCount),
    }));
  }

  /** Members of `teamId` by identity only, ordered by email. 404 for an unknown team. */
  async getTeamMembers(teamId: number): Promise<AdminTeamMemberRow[]> {
    const [team] = await this.db
      .select({ ownerId: teams.ownerId })
      .from(teams)
      .where(eq(teams.id, teamId));
    if (!team) throw new NotFoundException('Team not found');

    const rows = await this.db
      .select({ userId: teamMembers.userId, email: users.email })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(users.email))
      .execute();

    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      isOwner: r.userId === team.ownerId,
    }));
  }

  /**
   * FR-8 "Set new owner": the one team action an admin has without being a member.
   * Same rule as the owner's own transfer — the new owner must already be a member
   * (400 otherwise); the previous owner stays a member. 404 for an unknown team.
   */
  async setTeamOwner(teamId: number, userId: number) {
    const [team] = await this.db
      .select({ ownerId: teams.ownerId })
      .from(teams)
      .where(eq(teams.id, teamId));
    if (!team) throw new NotFoundException('Team not found');

    return this.teamsService.transferOwnership(teamId, team.ownerId, userId);
  }

  /**
   * Deletes an orphan team link — a `team_repositories` row whose URL has no
   * `repositories` row (nothing was ever uploaded). Its `team_repo_config` goes by FK
   * cascade. 404 when the link is missing or is not an orphan: a linked repo with data
   * is removed only through {@link removeRepo}.
   */
  async removeOrphanTeamRepo(teamRepoId: number): Promise<void> {
    const deleted = await this.db
      .delete(teamRepositories)
      .where(
        and(
          eq(teamRepositories.id, teamRepoId),
          sql`NOT EXISTS (
            SELECT 1 FROM repositories r
            WHERE r.repo_url = ${teamRepositories.repoUrl}
          )`,
        ),
      )
      .returning({ id: teamRepositories.id });
    if (deleted.length === 0) {
      throw new NotFoundException('Orphan team repository link not found');
    }
  }

  async getUsers(): Promise<UserRow[]> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        createdAt: users.createdAt,
        teamCount: countDistinct(teamMembers.teamId),
        lastActivity: max(logs.endTime),
      })
      .from(users)
      .leftJoin(teamMembers, eq(teamMembers.userId, users.id))
      .leftJoin(logs, eq(logs.userId, users.id))
      .groupBy(users.id, users.email, users.role, users.createdAt)
      .orderBy(asc(users.email))
      .execute();

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      createdAt: r.createdAt,
      teamCount: Number(r.teamCount),
      lastActivity: r.lastActivity,
    }));
  }
}
