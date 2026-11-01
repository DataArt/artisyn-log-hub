import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import type {
  RepoConfigJson,
  SessionAttributionAttributeDef,
} from '../database/schema/index';
import {
  logRepositories,
  logs,
  repoConfig,
  repositories,
  sessions,
  teams,
  teamMembers,
  teamRepositories,
  userFavoriteSessions,
  users,
} from '../database/schema/index';
import {
  CACHE_CREATION_THRESHOLD_MAX,
  CACHE_CREATION_THRESHOLD_MIN,
  DEFAULT_HIGH_CACHE_CREATION_THRESHOLD,
} from './cache-ratio.sql';
import {
  EMPTY_HOOK_EDIT_RECORDS,
  extractEditResultRecords,
  extractGitRoots,
  extractTimestampRange,
  selectEditResultRecordsForSession,
  type HookEditRecordIndex,
} from './artisyn-extractor';
import { loadArtisynRootsBySessionIds } from './change-surface/changed-paths.sql';
import { upsertSessionChangedPaths } from './change-surface/session-changed-paths-writer';
import {
  DEFAULT_FILE_CATEGORIES,
  extractClaudeStats,
  type FileCategory,
} from './claude-extractor';
import {
  upsertSessionCauseStatsRow,
  type CauseStatsScope,
} from './session-cause-stats-writer';
import { writeSessionFileStats } from './session-file-stats-writer';
import { getDescendantSessionIds } from './session-tree.sql';
import { enqueueOtelReclass } from './otel/otel-facts-writer';
import {
  replaceSessionCallTokens,
  replaceSessionRequestIds,
  upsertSessionStatsRow,
} from './session-stats-writer';
import { upsertSessionToolStatsRows } from './session-tool-stats-writer';
import { recomputeSessionCosts } from './session-cost/session-cost-writer';
import { upsertSessionHarnessUsageRows } from './session-harness-usage-writer';
import { rebuildOkfAccessForNodes } from './okf/okf-access-writer';
import type { TeamScope } from './team-scope';
import {
  DEFAULT_TEAM_VIEW_CONFIG,
  deleteTeamRepoConfig,
  findPersonalRepoConfig,
  findTeamRepoConfig,
  readConfigThreshold,
  resolveUserTeamForUrl,
  upsertTeamRepoConfig,
} from './team-repo-config';
import { classifyTurnCauses, walkTurns } from './turn-walk';
import { markTreesStale } from './tool-monitoring/tool-usage-writer';

export interface RepoSettingsResponse {
  effectiveConfig: RepoConfigJson;
  teamConfig: RepoConfigJson | null;
  userConfig: RepoConfigJson | null;
  teamId: number | null;
  canEditTeamConfig: boolean;
}

export interface ExportSessionRow {
  sessionId: string;
  firstPrompt: string | null;
  startTime: string;
  endTime: string;
  userId: number;
  userEmail: string;
}

export type AuthUser = { id: number; role: 'admin' | 'user' };

export type RepositoryRow = typeof repositories.$inferSelect;

/** Where an effective high-cache-creation threshold came from. */
export type CacheThresholdSource = 'user' | 'team' | 'default';

export interface EffectiveCacheThreshold {
  threshold: number;
  source: CacheThresholdSource;
}

// `sessionAttribution.attributes` validation caps,
// mirroring `fileCategories`' own validation block's shape.
const SESSION_ATTRIBUTION_KEY_REGEX = /^[a-z][a-z0-9_]{0,31}$/;
const SESSION_ATTRIBUTION_MAX_ATTRIBUTES = 12;
const SESSION_ATTRIBUTION_MAX_LABEL_LENGTH = 60;
const SESSION_ATTRIBUTION_MAX_PROMPT_LENGTH = 1000;
const SESSION_ATTRIBUTION_TYPES = [
  'string',
  'string[]',
  'boolean',
  'number',
] as const;

@Injectable()
export class RepositoriesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /** True when `userId` is the owner of `teamId`. */
  async isTeamOwner(userId: number, teamId: number): Promise<boolean> {
    const [team] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.ownerId, userId)));
    return !!team;
  }

  /**
   * Loads `repoId`, throwing if it doesn't exist or the caller has no access to it.
   * The rule is per route and ignores the caller's app role (the admin role grants
   * no data access). Without `teamId` (personal route), only the `repositories` row
   * owner passes — even when a team links the same repo URL. With `teamId` (team
   * route), the caller must be a member of that team and the team must have a
   * linked repository sharing the same `repoUrl`.
   */
  async assertRepoAccess(
    user: AuthUser,
    repoId: number,
    teamId?: number,
  ): Promise<RepositoryRow> {
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId));

    if (!repo) {
      throw new NotFoundException('Repository not found');
    }

    if (teamId === undefined) {
      if (repo.userId !== user.id) {
        throw new ForbiddenException();
      }
    } else {
      const [membership] = await this.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(
          and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)),
        );

      if (!membership) {
        throw new ForbiddenException();
      }

      const [teamRepo] = await this.db
        .select({ id: teamRepositories.id })
        .from(teamRepositories)
        .where(
          and(
            eq(teamRepositories.teamId, teamId),
            eq(teamRepositories.repoUrl, repo.repoUrl),
          ),
        );

      if (!teamRepo) {
        throw new ForbiddenException();
      }
    }

    return repo;
  }

  /**
   * Like {@link assertRepoAccess}, but when `teamId` is provided the caller must be
   * that team's owner — not merely a member. Without `teamId` the caller must own
   * the repo. Used by endpoints whose requirements are stricter than plain team
   * visibility (export/import).
   */
  async assertRepoOwnerOrTeamOwner(
    user: AuthUser,
    repoId: number,
    teamId?: number,
  ): Promise<RepositoryRow> {
    const repo = await this.assertRepoAccess(user, repoId, teamId);

    if (teamId !== undefined) {
      const [team] = await this.db
        .select({ ownerId: teams.ownerId })
        .from(teams)
        .where(eq(teams.id, teamId));

      if (!team || team.ownerId !== user.id) {
        throw new ForbiddenException();
      }
    }

    return repo;
  }

  /**
   * Resolves the set of `repositories.id` values sharing `repoUrl` across every
   * member of `teamId` (falling back to just `[repoId]` when `teamId` is omitted
   * or no team-wide rows are found).
   */
  async resolveRepoIds(
    repoId: number,
    repoUrl: string,
    teamId?: number,
  ): Promise<number[]> {
    if (teamId === undefined) {
      return [repoId];
    }
    const rows = await this.db
      .selectDistinct({ id: repositories.id })
      .from(repositories)
      .innerJoin(
        teamMembers,
        and(
          eq(teamMembers.userId, repositories.userId),
          eq(teamMembers.teamId, teamId),
        ),
      )
      .where(eq(repositories.repoUrl, repoUrl));
    return rows.length > 0 ? rows.map((r) => r.id) : [repoId];
  }

  /**
   * Resolves the caller's personal repository row for `repoUrl`, creating it
   * if it doesn't already exist yet (same `onConflictDoNothing` + re-select
   * pattern `LogsService.importSession()`'s repo-link step already uses).
   * Backs the "bootstrap import" endpoints — importing a previously exported
   * zip with no existing target repoId, letting sessions land on an empty
   * server or under a brand-new personal repo named after the export's own
   * `meta.sourceRepoUrl`.
   */
  async resolveOrCreatePersonalRepo(
    userId: number,
    repoUrl: string,
  ): Promise<RepositoryRow> {
    await this.db
      .insert(repositories)
      .values({ repoUrl, userId })
      .onConflictDoNothing({
        target: [repositories.userId, repositories.repoUrl],
      });

    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.userId, userId), eq(repositories.repoUrl, repoUrl)),
      );

    if (!repo) {
      throw new Error(
        `Failed to resolve or create a repository for ${repoUrl}`,
      );
    }
    return repo;
  }

  /**
   * Resolves what `user` may see inside `teamId` — the single entry point every
   * team-scoped read path uses instead of the old `allow_member_session_visibility`
   * boolean.
   *
   * `restricted` teams (the default) resolve by role:
   *
   * | caller                    | `visibility`        | `analyticsAllowed` |
   * |---------------------------|---------------------|--------------------|
   * | team owner                | `team-with-prompts` | `true`             |
   * | `adlc trainer` + `manager`| `team-with-prompts` | `true`             |
   * | `adlc trainer` only       | `team-with-prompts` | `false`            |
   * | `manager` only            | `team-no-prompts`   | `true`             |
   * | plain member / non-member | `own-only`          | `false`            |
   *
   * The other two cases are flat:
   *
   * | case                                | `visibility`        | `visibleUserIds` | `analyticsAllowed` |
   * |-------------------------------------|---------------------|------------------|--------------------|
   * | `teamId === undefined` (personal)   | `own-only`          | `[user.id]`      | `true`             |
   * | mode `transparent`, any caller      | `team-with-prompts` | `null`           | `true`             |
   *
   * A `null` `visibleUserIds` means "emit no user predicate at all", preserving the
   * exact SQL a `transparent` team produced before access modes existed.
   *
   * The app-level `admin` is deliberately **not** special-cased here: the admin role
   * grants no data access anywhere, so an admin is scoped by their team role like
   * any other member.
   */
  async resolveTeamScope(
    user: AuthUser,
    teamId: number | undefined,
  ): Promise<TeamScope> {
    // Personal (non-team) view: the caller only ever sees their own rows, and no
    // analytics gate applies. `accessMode` is reported as `restricted` because no team
    // contract is in force — nothing may read it as "this team is transparent".
    if (teamId === undefined) {
      return {
        accessMode: 'restricted',
        visibility: 'own-only',
        visibleUserIds: [user.id],
        analyticsAllowed: true,
        isTeamOwner: false,
        isManager: false,
        isAdlcTrainer: false,
      };
    }

    // One query: the team plus the caller's own membership row (absent for a
    // non-member reaching in).
    const [row] = await this.db
      .select({
        accessMode: teams.accessMode,
        ownerId: teams.ownerId,
        memberUserId: teamMembers.userId,
        isManager: teamMembers.isManager,
        isAdlcTrainer: teamMembers.isAdlcTrainer,
      })
      .from(teams)
      .leftJoin(
        teamMembers,
        and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, user.id)),
      )
      .where(eq(teams.id, teamId));

    const isTeamOwner = row?.ownerId === user.id;
    const isManager = row?.memberUserId != null && row.isManager === true;
    const isAdlcTrainer =
      row?.memberUserId != null && row.isAdlcTrainer === true;

    // A missing team row behaves like the restrictive default rather than throwing:
    // authorization itself is `assertRepoAccess`/`TeamAccessGuard`'s job, not the
    // scope resolver's.
    if (row?.accessMode === 'transparent') {
      return {
        accessMode: 'transparent',
        visibility: 'team-with-prompts',
        visibleUserIds: null,
        analyticsAllowed: true,
        isTeamOwner,
        isManager,
        isAdlcTrainer,
      };
    }

    // Restricted. Role flags only ever matter here.
    const seesTeam = isTeamOwner || isManager || isAdlcTrainer;

    if (!seesTeam) {
      return {
        accessMode: 'restricted',
        visibility: 'own-only',
        visibleUserIds: [user.id],
        analyticsAllowed: false,
        isTeamOwner,
        isManager,
        isAdlcTrainer,
      };
    }

    return {
      accessMode: 'restricted',
      visibility:
        isTeamOwner || isAdlcTrainer ? 'team-with-prompts' : 'team-no-prompts',
      visibleUserIds: await this.resolveAcknowledgedUserIds(teamId, user.id),
      analyticsAllowed: isTeamOwner || isManager,
      isTeamOwner,
      isManager,
      isAdlcTrainer,
    };
  }

  /**
   * The user ids a team-wide `restricted` scope may read: every member who has
   * acknowledged the disclosure, always unioned with the caller's own
   * id — a caller never loses sight of their own sessions, acknowledged or not.
   */
  private async resolveAcknowledgedUserIds(
    teamId: number,
    callerUserId: number,
  ): Promise<number[]> {
    const rows = await this.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          isNotNull(teamMembers.disclosureAcknowledgedAt),
        ),
      );

    return [...new Set([callerUserId, ...rows.map((r) => r.userId)])];
  }

  /**
   * The `logs.user_id` values the two **owner-only export surfaces** may read for
   * `teamId` — `GET :repoId/sessions/export-scope` and the ZIP `POST :repoId/export`.
   *
   * Those two routes deliberately bypass the per-caller visibility
   * narrowing (they are `assertRepoOwnerOrTeamOwner`/team-owner gated and keep returning
   * prompts in full), but the disclosure-acknowledgement gate still reaches them — a member who
   * has not acknowledged the disclosure is invisible to the team owner everywhere,
   * exports included. Unlike {@link resolveTeamScope} this is caller-independent: the
   * route's own gate already restricts the caller to the team owner.
   *
   * Returns `null` for a `transparent` team — "emit no user predicate at all", the exact
   * SQL those queries ran before access modes existed.
   */
  async resolveExportVisibleUserIds(teamId: number): Promise<number[] | null> {
    const [team] = await this.db
      .select({ accessMode: teams.accessMode, ownerId: teams.ownerId })
      .from(teams)
      .where(eq(teams.id, teamId));

    if (team === undefined || team.accessMode === 'transparent') {
      return null;
    }

    const rows = await this.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          isNotNull(teamMembers.disclosureAcknowledgedAt),
        ),
      );

    // The team owner is always in scope for their own export, acknowledged or not —
    // the owner row is stamped at creation, so this only matters for a team whose
    // owner row predates the feature and was never backfilled.
    return [...new Set([team.ownerId, ...rows.map((r) => r.userId)])];
  }

  /**
   * Guards a single-session route: throws `ForbiddenException` unless the caller may
   * read the session whose `sessions.id` is `sessionRowId`.
   *
   * List and aggregate routes row-filter instead — "you see only your own sessions" is
   * a filtered list, not a denied one — but a request that names one session by id has
   * no filtered form, so it must 403.
   *
   * Consulting `visibleUserIds` rather than only `visibility === 'own-only'` is what
   * stops a team owner or an `adlc trainer` reading a session belonging to a member who
   * has not acknowledged the disclosure yet. A `null` `visibleUserIds`
   * (a `transparent` team) skips the check entirely, preserving today's behaviour.
   */
  async assertSessionVisible(
    user: AuthUser,
    scope: TeamScope,
    sessionRowId: number,
  ): Promise<void> {
    if (scope.visibleUserIds === null) {
      return;
    }

    // The log type is deliberately NOT pinned to `artisyn`: a `claude-subagent` session
    // has no artisyn log of its own, and the change-surface routes must still answer for
    // one when it is opened directly (`ChangeSurfaceService.resolveSessionRowId` makes
    // the same allowance). Every log of a session carries the uploading user, so the
    // artisyn-first ordering only makes the pick deterministic.
    const [ownerRow] = await this.db
      .select({ userId: logs.userId })
      .from(logs)
      .where(eq(logs.sessionId, sessionRowId))
      .orderBy(sql`CASE WHEN ${logs.logType} = 'artisyn' THEN 0 ELSE 1 END`)
      .limit(1);

    const ownerId = ownerRow?.userId;
    if (ownerId === user.id) {
      return;
    }

    if (ownerId === undefined || !scope.visibleUserIds.includes(ownerId)) {
      throw new ForbiddenException();
    }
  }

  /**
   * The shared `WHERE` fragments every session-list route builds on, plus the caller's
   * resolved {@link TeamScope} so the route's projection can mask prompts without
   * resolving the scope a second time.
   *
   * `ownerCondition` is the team access-mode row filter: `logs.user_id IN
   * (visibleUserIds)` in a `restricted` team — which is `[user.id]` for a plain member,
   * and the acknowledged members for an owner/manager/trainer — and nothing at all in a
   * `transparent` team, preserving the exact SQL that ran before access modes existed.
   * It stays gated on `teamId !== undefined`: the personal route is owner-only
   * (`assertRepoAccess` admits only the `repositories` row owner, whatever their app
   * role), so that gate is the whole personal-view rule and no extra row filter applies.
   */
  async buildSessionListConditions(
    user: AuthUser,
    repoId: number,
    teamId: number | undefined,
    branchParam: string | undefined,
  ) {
    const repo = await this.assertRepoAccess(user, repoId, teamId);
    const scope = await this.resolveTeamScope(user, teamId);
    const repoIds = await this.resolveRepoIds(repoId, repo.repoUrl, teamId);
    const repoCondition =
      repoIds.length === 1
        ? eq(repositories.id, repoIds[0])
        : inArray(repositories.id, repoIds);

    const branchCondition =
      branchParam === undefined
        ? undefined
        : branchParam === ''
          ? or(isNull(logs.gitBranch), eq(logs.gitBranch, ''))
          : eq(logs.gitBranch, branchParam);

    const ownerCondition =
      teamId !== undefined && scope.visibleUserIds !== null
        ? inArray(logs.userId, scope.visibleUserIds)
        : undefined;

    // Callers that also need to resolve attribute
    // definitions (`attr=` filtering, orphan stripping) need the repo's `repoUrl` for
    // `SessionAttributionService.resolveDefinitions()` — returned alongside the
    // existing conditions rather than forcing a second `assertRepoAccess()` call.
    return {
      repoCondition,
      branchCondition,
      ownerCondition,
      repoUrl: repo.repoUrl,
      scope,
    };
  }

  /**
   * The settings tab payload, resolved per the team-vs-personal rules:
   *
   * - `teamId` given (team view): the team is exactly `teamId`; `effectiveConfig` is that
   *   team's config, else the default — the caller's personal config is ignored.
   * - no `teamId` (personal view): the team is the lowest-id team of the caller linking the
   *   URL; `effectiveConfig` falls back personal → that team → default.
   *
   * `userConfig` is always the caller's own personal config for the URL (looked up by URL,
   * not by `repoId`, so a member opening a colleague's repository row sees their own), and
   * `teamConfig` the single config of the resolved team for the URL.
   */
  async getRepoSettings(
    userId: number,
    repoId: number,
    teamId?: number,
  ): Promise<RepoSettingsResponse> {
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId));

    if (!repo) {
      throw new NotFoundException('Repository not found');
    }

    const resolvedTeamId =
      teamId ?? (await resolveUserTeamForUrl(this.db, userId, repo.repoUrl));
    const canEditTeamConfig =
      resolvedTeamId !== null
        ? await this.isTeamOwner(userId, resolvedTeamId)
        : false;

    const { config: effectiveConfig } = await this.resolveEffectiveConfig(
      userId,
      repo.repoUrl,
      teamId,
    );

    // `sessionAttribution` is resolved by the dedicated team-only path, not
    // `resolveEffectiveConfig()`'s personal-then-team walk, so the settings tab reads a
    // `sessionAttribution` block that correctly answers "no team at all" (`null`).
    const { config: teamOnlySessionAttribution } =
      await this.resolveTeamOnlyConfig(userId, repo.repoUrl, teamId);

    const userConfig = await findPersonalRepoConfig(
      this.db,
      userId,
      repo.repoUrl,
    );
    const teamConfig =
      resolvedTeamId !== null
        ? ((await findTeamRepoConfig(this.db, resolvedTeamId, repo.repoUrl))
            ?.config ?? null)
        : null;

    return {
      effectiveConfig: {
        ...effectiveConfig,
        sessionAttribution:
          teamOnlySessionAttribution ?? effectiveConfig.sessionAttribution,
      },
      teamConfig,
      userConfig,
      teamId: resolvedTeamId,
      canEditTeamConfig,
    };
  }

  /**
   * The config in force for `userId` on `repoUrl`.
   *
   * - Team view (`teamId` given): team `teamId`'s config → `DEFAULT_TEAM_VIEW_CONFIG`; the
   *   returned `teamId` is always `teamId`.
   * - Personal view: the caller's personal config → the config of their lowest-id team
   *   linking the URL → `DEFAULT_TEAM_VIEW_CONFIG`; the returned `teamId` is set only when the
   *   team config was used.
   */
  async resolveEffectiveConfig(
    userId: number,
    repoUrl: string,
    teamId?: number,
  ): Promise<{ config: RepoConfigJson; teamId: number | null }> {
    if (teamId !== undefined) {
      const team = await findTeamRepoConfig(this.db, teamId, repoUrl);
      return { config: team?.config ?? DEFAULT_TEAM_VIEW_CONFIG, teamId };
    }

    const personal = await findPersonalRepoConfig(this.db, userId, repoUrl);
    if (personal) {
      return { config: personal, teamId: null };
    }

    const fallbackTeamId = await resolveUserTeamForUrl(
      this.db,
      userId,
      repoUrl,
    );
    if (fallbackTeamId !== null) {
      const team = await findTeamRepoConfig(this.db, fallbackTeamId, repoUrl);
      if (team) {
        return { config: team.config, teamId: fallbackTeamId };
      }
    }

    return { config: DEFAULT_TEAM_VIEW_CONFIG, teamId: null };
  }

  /**
   * The team-only config resolution `sessionAttribution` needs. Unlike
   * {@link resolveEffectiveConfig}, this:
   *
   * - Skips the personal config entirely — `sessionAttribution` is a team-only field.
   * - Resolves the team even when it has no config yet (`teamId` given, else the caller's
   *   lowest-id team linking `repoUrl`), so the caller can tell "this repo belongs to no
   *   team" from "it belongs to a team that simply hasn't configured this yet" (the latter
   *   falls back to `DEFAULT_ATTRIBUTES`, the former must not).
   * - Short-circuits to `{ config: null, teamId: null }` when no team is found — a repo with
   *   no team never silently inherits the built-in defaults it can never be given a chance
   *   to edit.
   *
   * Returns the raw stored `sessionAttribution` block (or `null` if the team hasn't saved
   * one) plus the resolved `teamId`. Applying `DEFAULT_ATTRIBUTES` when `config` is `null`
   * but `teamId` is not is the caller's job (`session-attribution.service.ts`'s
   * `resolveDefinitions()`).
   */
  async resolveTeamOnlyConfig(
    userId: number,
    repoUrl: string,
    teamId?: number,
  ): Promise<{
    config: NonNullable<RepoConfigJson['sessionAttribution']> | null;
    teamId: number | null;
  }> {
    const resolvedTeamId =
      teamId ?? (await resolveUserTeamForUrl(this.db, userId, repoUrl));
    if (resolvedTeamId === null) {
      return { config: null, teamId: null };
    }

    const team = await findTeamRepoConfig(this.db, resolvedTeamId, repoUrl);
    return {
      config: team?.config.sessionAttribution ?? null,
      teamId: resolvedTeamId,
    };
  }

  /**
   * `previousConfig` — the config row this update is replacing, when known — is used only
   * for the `sessionAttribution.attributes[].key` immutable-type check:
   * a `key` that also existed in `previousConfig` must keep its declared `type`. It is
   * optional and defaults to skipping that one check (e.g. for a brand-new config row, or a
   * call site that does not yet track the previous value).
   */
  validateConfig(
    config: RepoConfigJson,
    previousConfig?: RepoConfigJson | null,
  ): void {
    const { fileCategories } = config;

    if (!Array.isArray(fileCategories)) {
      throw new BadRequestException('fileCategories must be an array');
    }

    if (fileCategories.length > 20) {
      throw new BadRequestException('Maximum 20 categories allowed');
    }

    const names = new Set<string>();
    for (const category of fileCategories) {
      const { name, patterns } = category;

      if (typeof name !== 'string' || name.trim() === '') {
        throw new BadRequestException(
          'Each category name must be a non-empty string',
        );
      }

      if (name.length > 64) {
        throw new BadRequestException(
          `Category name "${name}" exceeds 64 characters`,
        );
      }

      if (names.has(name)) {
        throw new BadRequestException(`Duplicate category name: "${name}"`);
      }
      names.add(name);

      if (!Array.isArray(patterns) || patterns.length === 0) {
        throw new BadRequestException(
          `Category "${name}" must have at least one pattern`,
        );
      }

      for (const p of patterns) {
        if (typeof p !== 'string' || p.trim() === '') {
          throw new BadRequestException(
            `Category "${name}" has an empty pattern`,
          );
        }

        try {
          new RegExp(p);
        } catch {
          throw new BadRequestException(
            `Category "${name}" has an invalid regexp pattern: ${p}`,
          );
        }
      }
    }

    // Optional; absent means DEFAULT_HIGH_CACHE_CREATION_THRESHOLD.
    const threshold = config.highCacheCreationThreshold;
    if (threshold !== undefined && threshold !== null) {
      if (typeof threshold !== 'number' || !Number.isInteger(threshold)) {
        throw new BadRequestException(
          'highCacheCreationThreshold must be an integer',
        );
      }

      if (
        threshold < CACHE_CREATION_THRESHOLD_MIN ||
        threshold > CACHE_CREATION_THRESHOLD_MAX
      ) {
        throw new BadRequestException(
          `highCacheCreationThreshold must be between ${CACHE_CREATION_THRESHOLD_MIN} and ${CACHE_CREATION_THRESHOLD_MAX}`,
        );
      }
    }

    // Optional; absent means the feature is off (dual-scope) — no built-in default
    // `minSessionCostUsd` here (that lives in
    // turn-end-cost-advisor.service.ts's own gate resolution).
    if (config.turnEndCostAdvisor !== undefined) {
      const { enabled, minSessionCostUsd } = config.turnEndCostAdvisor;

      if (typeof enabled !== 'boolean') {
        throw new BadRequestException(
          'turnEndCostAdvisor.enabled must be a boolean',
        );
      }

      if (minSessionCostUsd !== undefined && minSessionCostUsd !== null) {
        if (
          typeof minSessionCostUsd !== 'number' ||
          !Number.isFinite(minSessionCostUsd) ||
          minSessionCostUsd <= 0
        ) {
          throw new BadRequestException(
            'turnEndCostAdvisor.minSessionCostUsd must be a positive number',
          );
        }
      }
    }

    // Optional; team-only scope, never present on a
    // user-scoped config row. Follows fileCategories' own validation shape exactly:
    // array, length cap, per-item required fields, name/key uniqueness.
    if (config.sessionAttribution !== undefined) {
      const { enabled, attributes } = config.sessionAttribution;

      if (typeof enabled !== 'boolean') {
        throw new BadRequestException(
          'sessionAttribution.enabled must be a boolean',
        );
      }

      if (!Array.isArray(attributes)) {
        throw new BadRequestException(
          'sessionAttribution.attributes must be an array',
        );
      }

      if (attributes.length > SESSION_ATTRIBUTION_MAX_ATTRIBUTES) {
        throw new BadRequestException(
          `Maximum ${SESSION_ATTRIBUTION_MAX_ATTRIBUTES} attributes allowed`,
        );
      }

      const previousAttributesByKey = new Map<
        string,
        SessionAttributionAttributeDef
      >(
        (previousConfig?.sessionAttribution?.attributes ?? []).map((a) => [
          a.key,
          a,
        ]),
      );

      const seenKeys = new Set<string>();
      for (const attribute of attributes) {
        const { key, label, type, prompt } = attribute;

        if (
          typeof key !== 'string' ||
          !SESSION_ATTRIBUTION_KEY_REGEX.test(key)
        ) {
          throw new BadRequestException(
            `Attribute key "${String(key)}" is invalid — must match ${SESSION_ATTRIBUTION_KEY_REGEX}`,
          );
        }

        const keyLower = key.toLowerCase();
        if (seenKeys.has(keyLower)) {
          throw new BadRequestException(`Duplicate attribute key: "${key}"`);
        }
        seenKeys.add(keyLower);

        if (typeof label !== 'string' || label.trim() === '') {
          throw new BadRequestException(
            `Attribute "${key}" must have a non-empty label`,
          );
        }

        if (label.length > SESSION_ATTRIBUTION_MAX_LABEL_LENGTH) {
          throw new BadRequestException(
            `Attribute "${key}" label exceeds ${SESSION_ATTRIBUTION_MAX_LABEL_LENGTH} characters`,
          );
        }

        if (!(SESSION_ATTRIBUTION_TYPES as readonly string[]).includes(type)) {
          throw new BadRequestException(
            `Attribute "${key}" has an invalid type: ${String(type)}`,
          );
        }

        if (typeof prompt !== 'string' || prompt.trim() === '') {
          throw new BadRequestException(
            `Attribute "${key}" must have a non-empty prompt`,
          );
        }

        if (prompt.length > SESSION_ATTRIBUTION_MAX_PROMPT_LENGTH) {
          throw new BadRequestException(
            `Attribute "${key}" prompt exceeds ${SESSION_ATTRIBUTION_MAX_PROMPT_LENGTH} characters`,
          );
        }

        // Immutable key: once a key has been saved with a given
        // type, that binding cannot change — even across a later remove/re-add of the
        // same key — because historical session_attribution.values are typed by it.
        const previous = previousAttributesByKey.get(key);
        if (previous && previous.type !== type) {
          throw new BadRequestException(
            `Attribute "${key}" type is immutable and cannot change from "${previous.type}" to "${type}"`,
          );
        }
      }
    }
  }

  /**
   * Resolves the high-cache-creation threshold in force for `userId` on `repoUrl`, and
   * where it came from. An absent (or malformed) value falls through to the next scope,
   * ending at {@link DEFAULT_HIGH_CACHE_CREATION_THRESHOLD}.
   *
   * - Team view (`teamId` given): team `teamId`'s config → default; the personal config is
   *   ignored.
   * - Personal view: personal config → the caller's lowest-id team linking the URL →
   *   default, matching `resolveEffectiveConfig`.
   */
  async getEffectiveCacheThreshold(
    userId: number,
    repoUrl: string,
    teamId?: number,
  ): Promise<EffectiveCacheThreshold> {
    if (teamId === undefined) {
      const personal = readConfigThreshold(
        await findPersonalRepoConfig(this.db, userId, repoUrl),
      );
      if (personal !== null) return { threshold: personal, source: 'user' };
    }

    const resolvedTeamId =
      teamId ?? (await resolveUserTeamForUrl(this.db, userId, repoUrl));
    if (resolvedTeamId !== null) {
      const team = readConfigThreshold(
        (await findTeamRepoConfig(this.db, resolvedTeamId, repoUrl))?.config,
      );
      if (team !== null) return { threshold: team, source: 'team' };
    }

    return {
      threshold: DEFAULT_HIGH_CACHE_CREATION_THRESHOLD,
      source: 'default',
    };
  }

  /**
   * Resolves which `session_cause_stats` rows a reader must read.
   *
   * Ingest and recompute write a team-scoped row set for every team linking the session's
   * URL (its config, else the default threshold) and a personal row set for the uploader
   * (personal threshold, else the default) — see `LogsService.resolveCauseStatsScopes`. So
   * team view always reads `{ teamId }` and personal view always reads `{ userId }`.
   */
  resolveCauseStatsScope(userId: number, teamId?: number): CauseStatsScope {
    return teamId !== undefined ? { teamId } : { userId };
  }

  /**
   * Saves (or, with `null`, deletes) the single team config of a (team, repoUrl) pair, then
   * recomputes that team's derived stats over every same-URL session.
   *
   * - `teamId` given: writes exactly that team's config; the caller must own it and the team
   *   must link the repository's URL.
   * - no `teamId`: writes the config of the caller's lowest-id owned team linking the URL.
   *
   * Anything else is 403 — admins get no write bypass.
   */
  async saveTeamConfig(
    userId: number,
    repoId: number,
    config: RepoConfigJson | null,
    teamId?: number,
  ): Promise<RepoSettingsResponse> {
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId));

    if (!repo) {
      throw new NotFoundException('Repository not found');
    }

    let targetTeamId: number | null;
    if (teamId !== undefined) {
      const ownsLinkedTeam =
        (await this.isTeamOwner(userId, teamId)) &&
        (await this.teamLinksUrl(teamId, repo.repoUrl));
      targetTeamId = ownsLinkedTeam ? teamId : null;
    } else {
      targetTeamId = await resolveUserTeamForUrl(
        this.db,
        userId,
        repo.repoUrl,
        { ownerOnly: true },
      );
    }

    if (targetTeamId === null) {
      throw new ForbiddenException('Only the team owner can edit team config');
    }

    if (config === null) {
      await deleteTeamRepoConfig(this.db, targetTeamId, repo.repoUrl);
    } else {
      this.validateConfig(config);
      await upsertTeamRepoConfig(this.db, targetTeamId, repo.repoUrl, config);
    }

    await this.recomputeTeamScope(targetTeamId, repo.repoUrl);
    return this.getRepoSettings(userId, repoId, teamId);
  }

  /** True when team `teamId` links `repoUrl` in `team_repositories`. */
  private async teamLinksUrl(
    teamId: number,
    repoUrl: string,
  ): Promise<boolean> {
    const [link] = await this.db
      .select({ id: teamRepositories.id })
      .from(teamRepositories)
      .where(
        and(
          eq(teamRepositories.teamId, teamId),
          eq(teamRepositories.repoUrl, repoUrl),
        ),
      );
    return !!link;
  }

  async saveUserConfig(
    userId: number,
    repoId: number,
    config: RepoConfigJson | null,
  ): Promise<RepoSettingsResponse> {
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId));

    if (!repo) {
      throw new NotFoundException('Repository not found');
    }

    if (config === null) {
      await this.db
        .delete(repoConfig)
        .where(
          and(eq(repoConfig.repoId, repoId), eq(repoConfig.userId, userId)),
        );
    } else {
      this.validateConfig(config);
      await this.db.execute(
        sql`INSERT INTO repo_config (repo_id, user_id, config, updated_at)
            VALUES (${repoId}, ${userId}, ${JSON.stringify(config)}::jsonb, now())
            ON CONFLICT (repo_id, user_id) WHERE user_id IS NOT NULL
            DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      );
    }

    await this.recomputeForRepo(repoId, { userId });
    return this.getRepoSettings(userId, repoId);
  }

  /**
   * Recomputes one scope's derived stats (`session_file_stats` / `session_cause_stats`).
   * The team scope is URL-wide and delegates to {@link recomputeTeamScope}; the personal
   * scope rewrites the user's rows with their personal config, else the defaults.
   */
  async recomputeForRepo(
    repoId: number,
    scope: { teamId: number } | { userId: number },
  ): Promise<void> {
    const [repo] = await this.db
      .select({ repoUrl: repositories.repoUrl })
      .from(repositories)
      .where(eq(repositories.id, repoId));
    if (!repo) return;

    if ('teamId' in scope) {
      await this.recomputeTeamScope(scope.teamId, repo.repoUrl);
      return;
    }

    const userId = scope.userId;

    // Fetch config for this user+repo
    const [configRow] = await this.db
      .select({ config: repoConfig.config })
      .from(repoConfig)
      .where(and(eq(repoConfig.repoId, repoId), eq(repoConfig.userId, userId)));

    if (!configRow) {
      // Config was deleted — the user falls back to the default categories, which
      // is exactly what ingest writes for an uploader with no personal config. Rewrite
      // this user's file stats with the defaults instead of deleting them.
      await this.recomputeSessionFileStats(
        repo.repoUrl,
        DEFAULT_FILE_CATEGORIES,
        { userId },
      );
      // The cause decomposition is scoped the same way and is just as stale.
      await this.db.execute(
        sql`DELETE FROM session_cause_stats
            WHERE user_id = ${userId}
              AND session_id IN (
                SELECT DISTINCT s.id
                FROM sessions s
                INNER JOIN logs l ON l.session_id = s.id
                INNER JOIN log_repositories lr ON lr.log_id = l.id
                WHERE lr.repo_id = ${repoId}
              )`,
      );
      return;
    }

    const causeScope: CauseStatsScope = { userId };
    await this.recomputeSessionCauseStats(repoId, configRow.config, causeScope);
    await this.recomputeSessionFileStats(
      repo.repoUrl,
      configRow.config.fileCategories,
      causeScope,
    );
  }

  /**
   * Rewrites team `teamId`'s derived stats for `repoUrl`: cause stats and file stats of every
   * root session linked to any `repositories` row of the URL plus their descendants, using
   * the team's config, else `DEFAULT_TEAM_VIEW_CONFIG` and the default threshold. A URL with
   * no sessions (or no `repositories` row) is a no-op.
   */
  async recomputeTeamScope(teamId: number, repoUrl: string): Promise<void> {
    const config =
      (await findTeamRepoConfig(this.db, teamId, repoUrl))?.config ??
      DEFAULT_TEAM_VIEW_CONFIG;
    const tree = await this.gatherUrlSessionTree(repoUrl);
    if (!tree) return;

    const scope: CauseStatsScope = { teamId };
    await this.recomputeSessionCauseStatsForSessions(
      tree.treeSessionIds,
      config,
      scope,
    );
    await this.writeFileStatsForTree(tree, config.fileCategories, scope);
  }

  /**
   * Lists sessions in scope for the "Session Statistics Export" feature.
   *
   * Callers reach this method only after the controller has already verified the
   * caller is the repo's owner (personal view) or the team owner (team
   * view) — see `getSessionsExportScope` in repositories.controller.ts. Given that,
   * this deliberately does NOT apply the per-caller visibility narrowing that
   * `getRepositorySessions`/`buildSessionListConditions` enforce for ordinary
   * team-member session listing: the privileged caller is meant to see every
   * member's sessions in the date range, not just their own.
   *
   * The one team-access-mode rule that *does* reach here is the disclosure-acknowledgement
   * gate: in a `restricted` team a member who has not acknowledged
   * the disclosure is invisible to the team owner everywhere, exports included. See
   * {@link resolveExportVisibleUserIds}.
   */
  async getSessionsForExport(
    repoId: number,
    teamId: number | undefined,
    filters: { from: Date; to: Date; userId?: number },
  ): Promise<ExportSessionRow[]> {
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId));

    if (!repo) {
      throw new NotFoundException('Repository not found');
    }

    // Resolve repo id(s): in team view, other members' personal repos sharing the
    // same repoUrl are in scope too (mirrors the controller's own resolveRepoIds).
    let repoIds = [repoId];
    if (teamId !== undefined) {
      const rows = await this.db
        .selectDistinct({ id: repositories.id })
        .from(repositories)
        .innerJoin(
          teamMembers,
          and(
            eq(teamMembers.userId, repositories.userId),
            eq(teamMembers.teamId, teamId),
          ),
        )
        .where(eq(repositories.repoUrl, repo.repoUrl));
      if (rows.length > 0) {
        repoIds = rows.map((r) => r.id);
      }
    }

    const repoCondition =
      repoIds.length === 1
        ? eq(logRepositories.repoId, repoIds[0])
        : inArray(logRepositories.repoId, repoIds);

    const userCondition =
      filters.userId !== undefined
        ? eq(logs.userId, filters.userId)
        : undefined;

    // Acknowledged members only, in a `restricted` team.
    const visibleUserIds =
      teamId === undefined
        ? null
        : await this.resolveExportVisibleUserIds(teamId);
    const visibilityCondition =
      visibleUserIds === null
        ? undefined
        : visibleUserIds.length === 0
          ? sql`false`
          : inArray(logs.userId, visibleUserIds);

    const rows = await this.db
      .selectDistinct({
        sessionId: sessions.sessionId,
        firstPrompt: logs.firstPrompt,
        startTime: logs.startTime,
        endTime: logs.endTime,
        updatedAt: logs.updatedAt,
        userId: logs.userId,
        userEmail: users.email,
        // Postgres requires every ORDER BY expression to appear in the select
        // list for SELECT DISTINCT — included here only to satisfy that and
        // stripped back out in the .map() below before returning to the caller.
        sortKey: sql<string>`COALESCE(${logs.endTime}, ${logs.updatedAt})`,
      })
      .from(sessions)
      .innerJoin(logs, eq(logs.sessionId, sessions.id))
      .innerJoin(logRepositories, eq(logRepositories.logId, logs.id))
      .innerJoin(users, eq(users.id, logs.userId))
      .where(
        and(
          repoCondition,
          eq(logs.logType, 'artisyn'),
          isNotNull(logs.firstPrompt),
          eq(sessions.deleted, false),
          exists(
            this.db
              .select({ id: logs.id })
              .from(logs)
              .where(
                and(
                  eq(logs.sessionId, sessions.id),
                  eq(logs.logType, 'claude'),
                ),
              ),
          ),
          gte(logs.startTime, filters.from),
          lte(logs.startTime, filters.to),
          userCondition,
          visibilityCondition,
        ),
      )
      .orderBy(desc(sql`COALESCE(${logs.endTime}, ${logs.updatedAt})`));

    return rows.map((r) => ({
      sessionId: r.sessionId,
      firstPrompt: r.firstPrompt,
      startTime: (r.startTime ?? r.updatedAt).toISOString(),
      endTime: (r.endTime ?? r.updatedAt).toISOString(),
      userId: r.userId,
      userEmail: r.userEmail,
    }));
  }

  /**
   * Recomputes `session_stats` for every session linked to `repoId`, regardless of
   * team/user scope — `session_stats` has no scoping column (one row per session), so
   * unlike `recomputeForRepo`/`recomputeSessionStats` (which are per team/user config,
   * for the scoped `session_file_stats` table) this is scope-independent.
   *
   * Callers reach this method only after the controller has already verified the
   * caller is the repo's owner (personal view) or the team owner (team
   * view) — see `recomputeAllSessions` in repositories.controller.ts.
   */
  async recomputeAllSessionStats(
    repoId: number,
  ): Promise<{ recomputed: number }> {
    // Mirrors the session-gathering query in `recomputeSessionStats` (linked via the
    // artisyn log's log_repositories row), but unscoped by team/user config.
    const linkedSessionIds = await this.db
      .selectDistinct({ sessionId: sessions.id })
      .from(sessions)
      .innerJoin(logs, eq(logs.sessionId, sessions.id))
      .innerJoin(logRepositories, eq(logRepositories.logId, logs.id))
      .where(eq(logRepositories.repoId, repoId));

    if (linkedSessionIds.length === 0) return { recomputed: 0 };

    const rootSessionIds = linkedSessionIds.map((r) => r.sessionId);

    // `log_repositories` only ever links the **artisyn** log, so a sub-agent session
    // has no repo row of its own — measured 0 repo links across all 603 workflow-agent
    // sessions. Gathering by repo link alone therefore skipped every descendant, which left
    // their strictly-per-node `session_stats` permanently stale after any extraction fix: this
    // endpoint reported "recomputed: 115" for a repo whose tree has 320 more nodes, and the
    // diff-counter fix could not be backfilled through it at all. Descendants are pulled
    // in via the canonical recursive helper so the recompute covers the same tree every read
    // path already rolls up.
    const descendantsByRoot = await getDescendantSessionIds(
      this.db,
      rootSessionIds,
    );
    const sessionIdValues = [
      ...new Set([
        ...rootSessionIds,
        ...[...descendantsByRoot.values()].flat(),
      ]),
    ];

    type SessionLogRow = {
      sessionId: number;
      sessionKey: string;
      logType: string;
      body: object[];
    };

    // Backfill: extractTimestampRange's non-activity-line skip only runs at
    // upload time, so pre-existing `artisyn` logs still carry the old (unfiltered)
    // start/end times. Reprocess each linked session's artisyn body here too, so this
    // one endpoint backfills the start/end times alongside the other recomputed stats.
    //
    // Moved this block AHEAD of the per-node extraction below, because the same
    // bodies carry two more things the extraction now depends on: the repo roots (which
    // must be on the `logs` row before a changed path can be normalised against them) and
    // the hook-derived per-call records. Reading them here costs nothing extra —
    // the bodies are fetched either way.
    const artisynRows = (await this.db
      .select({
        sessionId: sessions.id,
        body: logs.body,
      })
      .from(sessions)
      .innerJoin(logs, eq(logs.sessionId, sessions.id))
      .where(
        // Roots only: a descendant has no artisyn log by construction (that is exactly why
        // it has no repo link), so widening this list would only grow the IN clause.
        and(inArray(sessions.id, rootSessionIds), eq(logs.logType, 'artisyn')),
      )) as { sessionId: number; body: object[] }[];

    const rootsByRootId = new Map<number, string[]>();
    const hookRecordsByRootId = new Map<number, HookEditRecordIndex>();

    for (const row of artisynRows) {
      const { startTime, endTime } = extractTimestampRange(row.body);
      const gitRoots = extractGitRoots(row.body);

      rootsByRootId.set(
        row.sessionId,
        [gitRoots.root, gitRoots.worktreeRoot].filter(
          (root): root is string => root !== null,
        ),
      );
      hookRecordsByRootId.set(
        row.sessionId,
        extractEditResultRecords(row.body),
      );

      // Each group of columns is written only when this body actually carried it. The
      // timestamp pair keeps its original all-or-nothing rule; the roots are additive on
      // top, so a body with no git object cannot clear a root learned from an earlier
      // upload of the same session (and vice versa).
      const columns = {
        ...(startTime !== null || endTime !== null
          ? {
              startTime: startTime ? new Date(startTime) : null,
              endTime: endTime ? new Date(endTime) : null,
            }
          : {}),
        ...(gitRoots.root !== null ? { gitRepoRoot: gitRoots.root } : {}),
        ...(gitRoots.worktreeRoot !== null
          ? { gitWorktreeRoot: gitRoots.worktreeRoot }
          : {}),
      };
      if (Object.keys(columns).length === 0) continue;

      await this.db
        .update(logs)
        .set(columns)
        .where(
          and(eq(logs.sessionId, row.sessionId), eq(logs.logType, 'artisyn')),
        );
    }

    // Every node of a tree resolves its roots and its hook records from the tree ROOT's
    // artisyn log — a sub-agent session has none of its own.
    const rootByNodeId = new Map<number, number>();
    for (const rootId of rootSessionIds) rootByNodeId.set(rootId, rootId);
    for (const [rootId, descendantIds] of descendantsByRoot) {
      for (const nodeId of descendantIds) rootByNodeId.set(nodeId, rootId);
    }

    const sessionRows = (await this.db
      .select({
        sessionId: sessions.id,
        sessionKey: sessions.sessionId,
        logType: logs.logType,
        body: logs.body,
      })
      .from(sessions)
      .innerJoin(logs, eq(logs.sessionId, sessions.id))
      .where(
        and(
          inArray(sessions.id, sessionIdValues),
          inArray(logs.logType, ['claude', 'claude-subagent']),
        ),
      )) as SessionLogRow[];

    for (const row of sessionRows) {
      const rootId = rootByNodeId.get(row.sessionId);
      const isSubagent = row.logType === 'claude-subagent';
      // Feeding the hook records back INTO extraction is what makes a
      // recompute reproduce the coverage instead of erasing it. A row merged into
      // `session_stats` after the fact would be wiped by this very loop.
      const hookEditRecords = selectEditResultRecordsForSession(
        (rootId === undefined ? undefined : hookRecordsByRootId.get(rootId)) ??
          EMPTY_HOOK_EDIT_RECORDS,
        row.sessionKey,
        isSubagent,
      );
      const stats = extractClaudeStats(
        row.body,
        '',
        isSubagent,
        hookEditRecords,
      );
      // One transaction, so a reader never sees the session's request ids deleted but not
      // yet re-inserted.
      await this.db.transaction(async (tx) => {
        await upsertSessionStatsRow(tx, row.sessionId, stats);
        await replaceSessionRequestIds(tx, row.sessionId, stats.requestIds);
        await enqueueOtelReclass(tx, row.sessionId);
        await replaceSessionCallTokens(tx, row.sessionId, stats.callTokens);
        await recomputeSessionCosts(tx, [row.sessionId]);
      });
      // The changed paths and the `cs_*` counters are rebuilt on the same pass, so
      // this endpoint is also the change-surface backfill for every session that predates the feature.
      await upsertSessionChangedPaths(
        this.db,
        row.sessionId,
        stats.changedPaths,
        (rootId === undefined ? undefined : rootsByRootId.get(rootId)) ?? [],
      );
      // The backfill path must populate the new per-tool table too, otherwise
      // POST :repoId/recompute-all-sessions leaves tool analytics empty for old sessions.
      await upsertSessionToolStatsRows(this.db, row.sessionId, stats.toolStats);
      // Same reasoning — without this, a pre-existing session's
      // `session_harness_usage` rows stay stuck on whatever counting logic wrote them at
      // upload time (e.g. the original self-report-based skill/rule counting), even after
      // the extraction logic is fixed, until its `claude` log happens to be re-uploaded.
      await upsertSessionHarnessUsageRows(
        this.db,
        row.sessionId,
        stats.harnessUsage,
      );
    }

    // FR-5: the same endpoint backfills the OKF access rows of every node of the gathered trees
    // (scope-independent, so once per tree here — not in the per-scope `writeFileStatsForTree`).
    await this.recomputeOkfAccess(sessionIdValues, rootByNodeId);

    // Tools/MCP tab (DD-7): the same endpoint re-extracts the tool usage of every gathered tree,
    // through the background drain (which picks the marked trees up on its next tick).
    await markTreesStale(this.db, sessionIdValues);

    return { recomputed: sessionRows.length };
  }

  /**
   * Rebuilds `session_okf_access` for every node of the given trees from its stored
   * `claude` / `claude-subagent` body (impl-plan DD-9). Roots follow the one root rule: the
   * node's own artisyn roots, else its tree root's — the same lookup as `writeFileStatsForTree`.
   * Runs after the artisyn bodies above have refreshed the `logs` root columns.
   */
  private async recomputeOkfAccess(
    treeSessionIds: number[],
    rootByNodeId: Map<number, number>,
  ): Promise<void> {
    if (treeSessionIds.length === 0) return;
    const rootsBySessionId = await loadArtisynRootsBySessionIds(
      this.db,
      treeSessionIds,
    );
    // One tree at a time, so only that tree's bodies are held in memory.
    const nodesByTreeRoot = new Map<number, number[]>();
    for (const nodeId of treeSessionIds) {
      const treeRootId = rootByNodeId.get(nodeId) ?? nodeId;
      const nodes = nodesByTreeRoot.get(treeRootId) ?? [];
      nodes.push(nodeId);
      nodesByTreeRoot.set(treeRootId, nodes);
    }
    for (const [treeRootId, nodeIds] of nodesByTreeRoot) {
      const bodyRows = await this.db
        .select({
          sessionId: logs.sessionId,
          logType: logs.logType,
          body: logs.body,
        })
        .from(logs)
        .where(
          and(
            inArray(logs.sessionId, nodeIds),
            inArray(logs.logType, ['claude', 'claude-subagent']),
          ),
        )
        .orderBy(asc(logs.id));
      await rebuildOkfAccessForNodes(
        this.db,
        bodyRows,
        (nodeId) =>
          rootsBySessionId.get(nodeId) ??
          rootsBySessionId.get(treeRootId) ??
          [],
      );
    }
  }

  async setSessionFavorite(
    userId: number,
    _repoId: number,
    sessionId: string,
    favorite: boolean,
  ): Promise<{ isFavorite: boolean }> {
    // assertRepoAccess in the controller already verified the user can access repoId.
    // We only need the sessions.id integer PK — one indexed lookup on the unique session_id string.
    const [sessionRow] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1);

    if (!sessionRow) {
      throw new NotFoundException('Session not found in repository');
    }

    if (favorite) {
      await this.db.execute(
        sql`INSERT INTO user_favorite_sessions (user_id, session_id)
            VALUES (${userId}, ${sessionRow.id})
            ON CONFLICT DO NOTHING`,
      );
    } else {
      await this.db
        .delete(userFavoriteSessions)
        .where(
          and(
            eq(userFavoriteSessions.userId, userId),
            eq(userFavoriteSessions.sessionId, sessionRow.id),
          ),
        );
    }

    return { isFavorite: favorite };
  }

  async getFavoriteSessionIds(
    userId: number,
    sessionIds: number[],
  ): Promise<Set<number>> {
    if (sessionIds.length === 0) {
      return new Set<number>();
    }

    const rows = await this.db
      .select({ sessionId: userFavoriteSessions.sessionId })
      .from(userFavoriteSessions)
      .where(
        and(
          eq(userFavoriteSessions.userId, userId),
          inArray(userFavoriteSessions.sessionId, sessionIds),
        ),
      );

    return new Set(rows.map((r) => r.sessionId));
  }

  /**
   * Re-derive the cache-creation cause decomposition for ONE personal scope over the
   * sessions linked to `repoId`. The threshold is a scoped config field, so a config save
   * that changes it must rewrite exactly this scope's rows and leave every other scope's
   * alone.
   */
  private async recomputeSessionCauseStats(
    repoId: number,
    config: RepoConfigJson,
    causeScope: CauseStatsScope,
  ): Promise<void> {
    // Repos are linked via artisyn logs (the artisyn log_id appears in log_repositories),
    // not via claude logs. So we first find sessions that have any log linked to the repo,
    // then fetch the claude logs for those sessions separately.
    const linkedSessionIds = await this.db
      .selectDistinct({ sessionId: sessions.id })
      .from(sessions)
      .innerJoin(logs, eq(logs.sessionId, sessions.id))
      .innerJoin(logRepositories, eq(logRepositories.logId, logs.id))
      .where(eq(logRepositories.repoId, repoId));

    await this.recomputeSessionCauseStatsForSessions(
      linkedSessionIds.map((r) => r.sessionId),
      config,
      causeScope,
    );
  }

  /** Rewrites `causeScope`'s `session_cause_stats` rows of `sessionIds`. */
  private async recomputeSessionCauseStatsForSessions(
    sessionIds: number[],
    config: RepoConfigJson,
    causeScope: CauseStatsScope,
  ): Promise<void> {
    if (sessionIds.length === 0) return;

    // Sub-agent transcripts are fetched too: `session_cause_stats` is written for them on
    // upload (`logs.service.ts` step 3c), so a recompute that skipped them would leave
    // their cause rows pinned to an old threshold.
    const logRows = (await this.db
      .select({
        sessionId: sessions.id,
        logType: logs.logType,
        body: logs.body,
      })
      .from(sessions)
      .innerJoin(logs, eq(logs.sessionId, sessions.id))
      .where(
        and(
          inArray(sessions.id, sessionIds),
          inArray(logs.logType, ['claude', 'claude-subagent']),
        ),
      )) as { sessionId: number; logType: string; body: object[] }[];

    const threshold =
      readConfigThreshold(config) ?? DEFAULT_HIGH_CACHE_CREATION_THRESHOLD;

    // `walkTurns` is threshold-free, so the transcript is parsed once per session.
    for (const row of logRows) {
      const walk = walkTurns(row.body, row.logType === 'claude-subagent');
      await upsertSessionCauseStatsRow(
        this.db,
        row.sessionId,
        causeScope,
        threshold,
        classifyTurnCauses(walk, threshold),
      );
    }
  }

  /**
   * The session trees of `repoUrl`: root sessions gathered by URL across owners (not by
   * `repo_id` — ingest matches configs by URL, so another owner's same-URL sessions carry
   * the same scopes' rows) plus their descendants (sub-agent sessions). `null` when the URL
   * has no linked session.
   */
  private async gatherUrlSessionTree(repoUrl: string): Promise<{
    treeSessionIds: number[];
    rootByNodeId: Map<number, number>;
  } | null> {
    const rootRows = await this.db
      .selectDistinct({ sessionId: logs.sessionId })
      .from(logs)
      .innerJoin(logRepositories, eq(logRepositories.logId, logs.id))
      .innerJoin(repositories, eq(repositories.id, logRepositories.repoId))
      .where(eq(repositories.repoUrl, repoUrl));

    if (rootRows.length === 0) return null;

    const rootSessionIds = rootRows.map((r) => r.sessionId);
    const descendantsByRoot = await getDescendantSessionIds(
      this.db,
      rootSessionIds,
    );

    const rootByNodeId = new Map<number, number>();
    for (const rootId of rootSessionIds) rootByNodeId.set(rootId, rootId);
    for (const [rootId, descendantIds] of descendantsByRoot) {
      for (const nodeId of descendantIds) rootByNodeId.set(nodeId, rootId);
    }
    return { treeSessionIds: [...rootByNodeId.keys()], rootByNodeId };
  }

  /**
   * Rewrites ONE scope's `session_file_stats` rows for every session tree that belongs to
   * `repoUrl` (see {@link gatherUrlSessionTree}).
   */
  private async recomputeSessionFileStats(
    repoUrl: string,
    categories: FileCategory[],
    scope: CauseStatsScope,
  ): Promise<void> {
    const tree = await this.gatherUrlSessionTree(repoUrl);
    if (!tree) return;
    await this.writeFileStatsForTree(tree, categories, scope);
  }

  /**
   * Classifies both `claude` and `claude-subagent` transcripts of the tree — the same set
   * ingest writes. Each node classifies against its own artisyn roots, else its tree root's
   * (only a tree root ever carries an artisyn log). Only this one scope is touched, through
   * the single writer, so other scopes' rows (including another user's default-category
   * rows) survive.
   */
  private async writeFileStatsForTree(
    tree: { treeSessionIds: number[]; rootByNodeId: Map<number, number> },
    categories: FileCategory[],
    scope: CauseStatsScope,
  ): Promise<void> {
    const { treeSessionIds, rootByNodeId } = tree;
    const logRows = (await this.db
      .select({ sessionId: logs.sessionId, body: logs.body })
      .from(logs)
      .where(
        and(
          inArray(logs.sessionId, treeSessionIds),
          inArray(logs.logType, ['claude', 'claude-subagent']),
        ),
      )) as { sessionId: number; body: object[] }[];

    if (logRows.length === 0) return;

    const rootsBySessionId = await loadArtisynRootsBySessionIds(
      this.db,
      treeSessionIds,
    );
    const scopes = [{ scope, categories }];

    for (const row of logRows) {
      const treeRootId = rootByNodeId.get(row.sessionId);
      const roots =
        rootsBySessionId.get(row.sessionId) ??
        (treeRootId === undefined
          ? undefined
          : rootsBySessionId.get(treeRootId)) ??
        [];
      await writeSessionFileStats(
        this.db,
        row.sessionId,
        row.body,
        roots,
        scopes,
      );
    }
  }
}
