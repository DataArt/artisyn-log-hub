import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import {
  MAX_MONITORED_TOOLS,
  TOOL_DENYLIST,
  normalizeToolName,
  validateToolName,
} from '@loghub/tool-monitor';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import {
  repoToolMonitorConfig,
  repositories,
  teamMembers,
  teamRepoToolMonitorConfig,
  teamRepositories,
  teams,
  type ToolMonitorCapture,
  type ToolMonitorConfigJson,
  type ToolWrapStatusJson,
} from '../../database/schema/index';
import { normalizeRepoUrl } from '../repo-url-normalizer';
import {
  RepositoriesService,
  type AuthUser,
  type RepositoryRow,
} from '../repositories.service';
import type {
  ResolvedMonitoredTools,
  ToolMonitorConfigError,
  ToolMonitorConfigToolView,
  ToolMonitorConfigView,
  ToolMonitorHint,
  ToolMonitorLevel,
  ToolWrapStatusView,
} from './tool-monitoring.types';

/** The config of a level that has never been saved. */
export const EMPTY_TOOL_MONITOR_CONFIG: ToolMonitorConfigJson = {
  paused: false,
  tools: [],
};

const CAPTURES: readonly ToolMonitorCapture[] = ['full', 'meta'];

function badRequest(field: string, code: string, message: string): never {
  const body: ToolMonitorConfigError = { message, field, code };
  throw new BadRequestException(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a config PUT body (API changes): shape, at most `MAX_MONITORED_TOOLS` tools,
 * case-insensitive unique names and `validateToolName`. Throws a 400 with
 * `{ message, field, code }` on the first problem; returns a clean copy otherwise.
 */
export function parseToolMonitorConfigBody(
  body: unknown,
): ToolMonitorConfigJson {
  if (!isRecord(body)) {
    badRequest('body', 'invalid', 'Body must be an object');
  }
  if (typeof body.paused !== 'boolean') {
    badRequest('paused', 'invalid', '`paused` must be a boolean');
  }
  if (!Array.isArray(body.tools)) {
    badRequest('tools', 'invalid', '`tools` must be an array');
  }
  const rawTools: unknown[] = body.tools;
  if (rawTools.length > MAX_MONITORED_TOOLS) {
    badRequest(
      'tools',
      'too_many',
      `At most ${MAX_MONITORED_TOOLS} tools can be monitored`,
    );
  }

  const seen = new Set<string>();
  const tools: ToolMonitorConfigJson['tools'] = [];
  rawTools.forEach((raw, i) => {
    const at = `tools[${i}]`;
    if (!isRecord(raw)) {
      badRequest(at, 'invalid', 'Each tool must be an object');
    }
    if (typeof raw.name !== 'string') {
      badRequest(`${at}.name`, 'invalid', 'Tool name must be a string');
    }
    const name = raw.name;
    const check = validateToolName(name);
    if (!check.ok) {
      badRequest(`${at}.name`, check.code, check.message);
    }
    const key = normalizeToolName(name);
    if (seen.has(key)) {
      badRequest(
        `${at}.name`,
        'duplicate',
        `\`${name}\` is listed more than once`,
      );
    }
    seen.add(key);
    if (typeof raw.enabled !== 'boolean') {
      badRequest(`${at}.enabled`, 'invalid', '`enabled` must be a boolean');
    }
    const capture = raw.capture;
    if (
      typeof capture !== 'string' ||
      !CAPTURES.includes(capture as ToolMonitorCapture)
    ) {
      badRequest(
        `${at}.capture`,
        'invalid',
        '`capture` must be "full" or "meta"',
      );
    }
    tools.push({
      name,
      enabled: raw.enabled,
      capture: capture as ToolMonitorCapture,
    });
  });

  return { paused: body.paused, tools };
}

/**
 * Tolerant read of a stored config: anything malformed is dropped rather than failing the
 * caller (a row written by a future server may carry fields this one does not know).
 */
function readStoredConfig(value: unknown): ToolMonitorConfigJson {
  if (!isRecord(value)) return { ...EMPTY_TOOL_MONITOR_CONFIG, tools: [] };
  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((t): ToolMonitorConfigJson['tools'] =>
        isRecord(t) && typeof t.name === 'string'
          ? [
              {
                name: t.name,
                enabled: t.enabled !== false,
                capture: t.capture === 'meta' ? 'meta' : 'full',
              },
            ]
          : [],
      )
    : [];
  return { paused: value.paused === true, tools };
}

/**
 * The DD-2 merge: the union of **enabled**, valid, non-denylisted tools by (case-insensitive)
 * name; `capture` is `full` when any enabled level says `full`; `paused` when any level is
 * paused. The first spelling seen wins; levels are listed in input order without repeats.
 */
export function mergeMonitoredTools(
  layers: { level: ToolMonitorLevel; config: ToolMonitorConfigJson }[],
): ResolvedMonitoredTools {
  const byKey = new Map<string, ResolvedMonitoredTools['tools'][number]>();
  let paused = false;
  for (const { level, config } of layers) {
    if (config.paused) paused = true;
    for (const tool of config.tools) {
      if (!tool.enabled || !validateToolName(tool.name).ok) continue;
      const key = normalizeToolName(tool.name);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          name: tool.name,
          capture: tool.capture,
          levels: [level],
        });
        continue;
      }
      if (tool.capture === 'full') existing.capture = 'full';
      if (!existing.levels.includes(level)) existing.levels.push(level);
    }
  }
  return { paused, tools: [...byKey.values()] };
}

/**
 * Normalized names that are enabled in `next` but were not enabled in `prev` — the tools
 * whose scope sessions must be re-extracted (DD-7).
 */
export function newlyEnabledToolNames(
  prev: ToolMonitorConfigJson,
  next: ToolMonitorConfigJson,
): string[] {
  const before = new Set(
    prev.tools.filter((t) => t.enabled).map((t) => normalizeToolName(t.name)),
  );
  const added = new Set<string>();
  for (const tool of next.tools) {
    const key = normalizeToolName(tool.name);
    if (tool.enabled && !before.has(key)) added.add(key);
  }
  return [...added];
}

/**
 * The panel hint of one configured tool (DD-20). Precedence:
 * `preflight_failed` > `breaker` > `hook_too_old` > `no_data_yet`.
 */
export function resolveToolHint(
  toolName: string,
  status: ToolWrapStatusJson | null,
  lastWrapperAt: string | null,
): ToolMonitorHint | null {
  if (status === null) return 'hook_too_old';
  if (status.preflight?.ok === false) return 'preflight_failed';
  const key = normalizeToolName(toolName);
  const breaker = status.breaker;
  if (
    breaker?.global === true ||
    (Array.isArray(breaker?.tools) &&
      breaker.tools.some((t) => normalizeToolName(t) === key))
  ) {
    return 'breaker';
  }
  return lastWrapperAt === null ? 'no_data_yet' : null;
}

/** The latest `lastWrapperAt` of `toolName` over the given statuses. */
function latestWrapperAt(
  toolName: string,
  statuses: ToolWrapStatusJson[],
): string | null {
  const key = normalizeToolName(toolName);
  let latest: string | null = null;
  for (const status of statuses) {
    if (!isRecord(status.tools)) continue;
    for (const [name, entry] of Object.entries(status.tools)) {
      if (normalizeToolName(name) !== key) continue;
      const at = entry?.lastWrapperAt;
      if (typeof at === 'string' && (latest === null || at > latest)) {
        latest = at;
      }
    }
  }
  return latest;
}

function toWrapStatusView(status: ToolWrapStatusJson): ToolWrapStatusView {
  return {
    hookVersion: status.hookVersion ?? null,
    os: status.os ?? null,
    preflight: {
      ok: status.preflight?.ok === true,
      reason: status.preflight?.reason ?? null,
    },
    breaker: {
      global: status.breaker?.global === true,
      tools: Array.isArray(status.breaker?.tools) ? status.breaker.tools : [],
    },
    reportedAt: status.reportedAt,
  };
}

/**
 * Monitored-tools configuration (DD-1, DD-2, DD-17, DD-20): the personal and team levels'
 * CRUD, the personal ∪ team merge the hook and the rebuild use, and the stale marking a newly
 * monitored tool triggers. Access to `repoId` / `teamId` is checked by the controllers
 * (`assertRepoAccess`) before any of these run.
 */
@Injectable()
export class ToolMonitorConfigService {
  private readonly logger = new Logger(ToolMonitorConfigService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly repositoriesService: RepositoriesService,
  ) {}

  private async loadRepo(repoId: number): Promise<RepositoryRow> {
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId));
    if (!repo) {
      throw new NotFoundException('Repository not found');
    }
    return repo;
  }

  /** `team_repositories.id` of team `teamId`'s link to `repoUrl`, or null. */
  private async findTeamRepositoryId(
    teamId: number,
    repoUrl: string,
  ): Promise<number | null> {
    const [link] = await this.db
      .select({ id: teamRepositories.id })
      .from(teamRepositories)
      .where(
        and(
          eq(teamRepositories.teamId, teamId),
          eq(teamRepositories.repoUrl, repoUrl),
        ),
      );
    return link?.id ?? null;
  }

  private async readLevel(
    repo: RepositoryRow,
    teamId: number | undefined,
  ): Promise<ToolMonitorConfigJson> {
    if (teamId === undefined) {
      const [row] = await this.db
        .select({ config: repoToolMonitorConfig.config })
        .from(repoToolMonitorConfig)
        .where(eq(repoToolMonitorConfig.repoId, repo.id));
      return readStoredConfig(row?.config);
    }
    const [row] = await this.db
      .select({ config: teamRepoToolMonitorConfig.config })
      .from(teamRepoToolMonitorConfig)
      .innerJoin(
        teamRepositories,
        eq(teamRepositories.id, teamRepoToolMonitorConfig.teamRepositoryId),
      )
      .where(
        and(
          eq(teamRepositories.teamId, teamId),
          eq(teamRepositories.repoUrl, repo.repoUrl),
        ),
      );
    return readStoredConfig(row?.config);
  }

  /**
   * The stored config of one level: personal (the `repositories` row `repoId`) without
   * `teamId`, else team `teamId`'s link to the repository's URL. An unsaved level reads as
   * `{ paused: false, tools: [] }`.
   */
  async getLevelConfig(
    repoId: number,
    teamId?: number,
  ): Promise<ToolMonitorConfigJson> {
    return this.readLevel(await this.loadRepo(repoId), teamId);
  }

  /**
   * Validates and writes one level's whole list, marks the level's scope sessions stale for
   * newly added or enabled tools (DD-7), and returns the fresh config view. The personal level
   * is writable by the repository row's owner; the team level by the team owner only
   * (`canEditTeamConfig`), else 403.
   */
  async saveLevelConfig(
    user: AuthUser,
    repoId: number,
    teamId: number | undefined,
    body: unknown,
  ): Promise<ToolMonitorConfigView> {
    const config = parseToolMonitorConfigBody(body);
    const repo = await this.loadRepo(repoId);
    const previous = await this.readLevel(repo, teamId);
    const json = JSON.stringify(config);

    if (teamId === undefined) {
      if (repo.userId !== user.id) {
        throw new ForbiddenException();
      }
      await this.db.execute(
        sql`INSERT INTO repo_tool_monitor_config (repo_id, config, updated_at)
            VALUES (${repo.id}, ${json}::jsonb, now())
            ON CONFLICT (repo_id)
            DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      );
    } else {
      const teamRepositoryId = (await this.repositoriesService.isTeamOwner(
        user.id,
        teamId,
      ))
        ? await this.findTeamRepositoryId(teamId, repo.repoUrl)
        : null;
      if (teamRepositoryId === null) {
        throw new ForbiddenException(
          'Only the team owner can edit team config',
        );
      }
      await this.db.execute(
        sql`INSERT INTO team_repo_tool_monitor_config (team_repository_id, config, updated_at)
            VALUES (${teamRepositoryId}, ${json}::jsonb, now())
            ON CONFLICT (team_repository_id)
            DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      );
    }

    const added = newlyEnabledToolNames(previous, config);
    if (added.length > 0) {
      await this.markScopeStale(repo.id, teamId, added);
    }
    return this.buildConfigView(user, repo.id, teamId);
  }

  /**
   * DD-2: the owner's personal row for the (normalized) `repoUrl`, merged with every team
   * config whose team links that URL and has `userId` as a member (or owner).
   */
  async resolveMonitoredTools(
    userId: number,
    repoUrl: string,
  ): Promise<ResolvedMonitoredTools> {
    const url = normalizeRepoUrl(repoUrl);

    const personalRows = await this.db
      .select({ config: repoToolMonitorConfig.config })
      .from(repoToolMonitorConfig)
      .innerJoin(
        repositories,
        eq(repositories.id, repoToolMonitorConfig.repoId),
      )
      .where(
        and(eq(repositories.userId, userId), eq(repositories.repoUrl, url)),
      );

    const teamRows = await this.db
      .selectDistinct({
        teamRepositoryId: teamRepoToolMonitorConfig.teamRepositoryId,
        config: teamRepoToolMonitorConfig.config,
      })
      .from(teamRepoToolMonitorConfig)
      .innerJoin(
        teamRepositories,
        eq(teamRepositories.id, teamRepoToolMonitorConfig.teamRepositoryId),
      )
      .innerJoin(teams, eq(teams.id, teamRepositories.teamId))
      .leftJoin(
        teamMembers,
        and(
          eq(teamMembers.teamId, teamRepositories.teamId),
          eq(teamMembers.userId, userId),
        ),
      )
      .where(
        and(
          eq(teamRepositories.repoUrl, url),
          or(eq(teams.ownerId, userId), isNotNull(teamMembers.userId)),
        ),
      )
      .orderBy(teamRepoToolMonitorConfig.teamRepositoryId);

    return mergeMonitoredTools([
      ...personalRows.map((r) => ({
        level: 'personal' as const,
        config: readStoredConfig(r.config),
      })),
      ...teamRows.map((r) => ({
        level: 'team' as const,
        config: readStoredConfig(r.config),
      })),
    ]);
  }

  /**
   * Marks the level's scope sessions of the repository URL stale (`tool_usage_version =
   * NULL`) so the drain re-extracts them with the newly monitored `toolNames` (DD-7, FR-7).
   * Personal: the owner's sessions of the repository row `repoId`; team: the team members'
   * sessions of every member's repository row for the URL. The root selection is the one
   * `analytics/scoped-sessions.sql.ts` (`loadScopedRootSessions`) uses — the `artisyn` log's
   * session linked through `log_repositories`, uploaded by an in-scope user, not deleted —
   * without its date-range and first-prompt filters, since every session may hold the tool.
   * Marking the roots is enough: the drain rebuilds a claimed session's whole tree.
   */
  async markScopeStale(
    repoId: number,
    teamId: number | undefined,
    toolNames: string[],
  ): Promise<number> {
    if (toolNames.length === 0) return 0;
    const repo = await this.loadRepo(repoId);

    let repoIds: number[];
    let userIds: number[];
    if (teamId === undefined) {
      repoIds = [repo.id];
      userIds = [repo.userId];
    } else {
      const rows = await this.db
        .selectDistinct({ id: repositories.id, userId: repositories.userId })
        .from(repositories)
        .innerJoin(
          teamMembers,
          and(
            eq(teamMembers.userId, repositories.userId),
            eq(teamMembers.teamId, teamId),
          ),
        )
        .where(eq(repositories.repoUrl, repo.repoUrl));
      if (rows.length === 0) return 0;
      repoIds = rows.map((r) => r.id);
      userIds = [...new Set(rows.map((r) => r.userId))];
    }

    // `{…}::int[]` literals, as scoped-sessions.sql.ts does: the ids are integers from the DB.
    const repoIdsLiteral = `{${repoIds.join(',')}}`;
    const userIdsLiteral = `{${userIds.join(',')}}`;
    const result = await this.db.execute(sql`
      UPDATE sessions SET tool_usage_version = NULL
      WHERE tool_usage_version IS NOT NULL
        AND id IN (
          SELECT s.id
          FROM sessions s
          INNER JOIN logs l ON l.session_id = s.id
          INNER JOIN log_repositories lr ON lr.log_id = l.id
          WHERE lr.repo_id = ANY(${repoIdsLiteral}::int[])
            AND l.log_type = 'artisyn'
            AND l.user_id = ANY(${userIdsLiteral}::int[])
            AND s.deleted = false
        )
    `);
    const marked = result.rowCount ?? 0;
    this.logger.log(
      `Tool monitoring: marked ${marked} session(s) stale for ${toolNames.join(', ')} ` +
        `(repo ${repo.id}${teamId === undefined ? '' : `, team ${teamId}`})`,
    );
    return marked;
  }

  /**
   * The repository rows whose `tool_wrap_status` the caller may see: the row itself in the
   * personal view; in the team view every member's row for the URL, narrowed to the caller's
   * visible users (DD-17, DD-20).
   */
  private async loadVisibleWrapStatuses(
    user: AuthUser,
    repo: RepositoryRow,
    teamId: number | undefined,
  ): Promise<ToolWrapStatusJson[]> {
    let repoIds = [repo.id];
    let visibleUserIds: number[] | null = null;
    if (teamId !== undefined) {
      repoIds = await this.repositoriesService.resolveRepoIds(
        repo.id,
        repo.repoUrl,
        teamId,
      );
      visibleUserIds = (
        await this.repositoriesService.resolveTeamScope(user, teamId)
      ).visibleUserIds;
    }
    const rows = await this.db
      .select({ status: repositories.toolWrapStatus })
      .from(repositories)
      .where(
        and(
          inArray(repositories.id, repoIds),
          visibleUserIds === null
            ? undefined
            : inArray(repositories.userId, visibleUserIds),
        ),
      );
    return rows.flatMap((r) =>
      isRecord(r.status) && typeof r.status.reportedAt === 'string'
        ? [r.status]
        : [],
    );
  }

  /**
   * The config GET DTO (API changes, DD-20): the level's own tool list with, per tool, the
   * levels it is enabled at for the caller, the latest wrapper record time and the panel hint;
   * the most recent wrapper status among the visible owners; and the denylist.
   */
  async buildConfigView(
    user: AuthUser,
    repoId: number,
    teamId?: number,
  ): Promise<ToolMonitorConfigView> {
    const repo = await this.loadRepo(repoId);
    const level: ToolMonitorLevel = teamId === undefined ? 'personal' : 'team';
    const canEdit =
      teamId === undefined
        ? repo.userId === user.id
        : await this.repositoriesService.isTeamOwner(user.id, teamId);

    const [config, merged, statuses] = await Promise.all([
      this.readLevel(repo, teamId),
      this.resolveMonitoredTools(user.id, repo.repoUrl),
      this.loadVisibleWrapStatuses(user, repo, teamId),
    ]);

    const latest = statuses.reduce<ToolWrapStatusJson | null>(
      (best, s) => (best === null || s.reportedAt > best.reportedAt ? s : best),
      null,
    );
    const levelsByKey = new Map(
      merged.tools.map((t) => [normalizeToolName(t.name), t.levels]),
    );

    const tools: ToolMonitorConfigToolView[] = config.tools.map((tool) => {
      const levels = [...(levelsByKey.get(normalizeToolName(tool.name)) ?? [])];
      if (tool.enabled && !levels.includes(level)) levels.push(level);
      const lastWrapperAt = latestWrapperAt(tool.name, statuses);
      return {
        name: tool.name,
        enabled: tool.enabled,
        capture: tool.capture,
        levels,
        lastWrapperAt,
        hint: tool.enabled
          ? resolveToolHint(tool.name, latest, lastWrapperAt)
          : null,
      };
    });

    return {
      level,
      canEdit,
      paused: config.paused,
      tools,
      wrapStatus: latest === null ? null : toWrapStatusView(latest),
      denylist: TOOL_DENYLIST.map((e) => e.name),
    };
  }
}
