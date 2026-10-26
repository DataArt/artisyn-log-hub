import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  lte,
  gte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Request, Response } from 'express';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import type {
  RepoConfigJson,
  SessionAttributionAttributeDef,
} from '../database/schema/index';
import * as schema from '../database/schema';
import { RepositoriesService } from './repositories.service';
import type { RepoSettingsResponse } from './repositories.service';
import { HookStateService } from './hook-state.service';
import type {
  HookRepositorySummary,
  HookStateDetail,
} from './hook-state.service';
import { SetSessionFavoriteDto } from './dto/set-session-favorite.dto';
import { extractWorkflows } from './workflow-extractor';
import {
  descendantSessionsCte,
  getDescendantSessionIds,
} from './session-tree.sql';
import {
  SESSION_TREE_METRICS_CTE,
  loadTreeMetricsByRoot,
  treeMetricsCte,
  withOwnFallback,
} from './session-tree-metrics.sql';
import { EDIT_WRITE_TOOL_NAMES } from './edit-tools';
import { textList } from './analytics/scoped-sessions.sql';
import {
  costMismatch,
  otelCostsCte,
  otelComputedDiscrepancy,
  type CostBreakdown,
} from './otel-cost.sql';
import {
  readTreeCost,
  TREE_COST_COLUMNS_SQL,
  treeCostCtes,
  type TreeCostSqlRow,
} from './session-tree-cost.sql';
import {
  assertKnownGroupByAttrKey,
  assertNoGroupByAttrFilterConflict,
  attrGroupKeysSql,
  attributeFilterSql,
  attributeGroupLabels,
  buildAttributeTypeLookup,
  isOrphanedValue,
  normalizeRepeatableParam,
  parseAttributeFilters,
  parseGroupByAttrKey,
  validateAttributeFilterTypes,
} from './attribute-filter.sql';
import { SessionAttributionService } from './session-attribution/session-attribution.service';
import { loadHarnessSnapshot } from './harness-snapshot';
import {
  ChangeSurfaceAggregateService,
  resolveChangeSurfaceBucket,
  type ChangeSurfaceGroupBy,
} from './change-surface/change-surface-aggregate.service';
import {
  ChangeSurfaceService,
  type ChangeSurfaceSessionScope,
} from './change-surface/change-surface.service';
import {
  CHANGE_SURFACE_MAX_FILE_ROWS,
  type ChangeSurfaceAggregate,
  type ChangeSurfaceFileRow,
  type ChangeSurfaceTimeline,
  type ChangeSurfaceTimelineBucket,
} from './change-surface/change-surface.types';
import { maskFirstPrompt, type TeamScope } from './team-scope';

/**
 * `costBreakdown` of a listed session that has no cost row (no assistant lines yet): nothing
 * calculated, nothing metered. The sessions list always sends a breakdown.
 */
const EMPTY_COST_BREAKDOWN: Readonly<CostBreakdown> = Object.freeze({
  mainCost: null,
  subagentCost: 0,
  utilityCost: 0,
  calculatedCost: null,
  telemetryCost: null,
  mismatch: false,
  utilityPricingMissing: false,
  subagentPricingMissing: false,
  unpricedModels: [],
});

/**
 * The team access-mode row filter, as a raw-SQL fragment for the routes on this
 * controller that hand-write their `WHERE` instead of composing drizzle conditions.
 *
 * Emits nothing (`sql``) outside a team view and in a `transparent` team — a `null`
 * `visibleUserIds` means "no user predicate at all", which keeps the SQL these routes
 * produced before access modes existed byte-identical. Inside a `restricted` team it is
 * `AND <alias>.user_id = ANY('{…}'::int[])`, matching the `{…}::int[]` literal form the
 * repo filters beside it already use (one bind parameter, not N).
 *
 * The `teamId !== undefined` guard is deliberate: the personal view is owner-only
 * (`assertRepoAccess` admits only the `repositories` row owner, whatever their app
 * role), so that gate is the whole personal-view rule and no extra row filter applies.
 *
 * @param logsAlias the `logs` table alias used by the surrounding query.
 */
function teamScopeUserFilterSql(
  teamId: number | undefined,
  scope: TeamScope,
  logsAlias: string,
): SQL {
  if (teamId === undefined || scope.visibleUserIds === null) {
    return sql``;
  }
  const idsLiteral = `{${scope.visibleUserIds.join(',')}}`;
  return sql`AND ${sql.raw(logsAlias)}.user_id = ANY(${idsLiteral}::int[])`;
}

/**
 * The five per-event usage figures the timeline's raw-JSONB `session_events` CTE
 * surfaces beyond the three it already sums, aliased to the exact `session_stats`
 * column names. They are only a fallback for the response's token columns when no
 * `session_stats` row exists yet; cost itself comes from the stored `session_costs`.
 *
 * The 5m/1h split mirrors `splitCacheCreationTokens()`
 * (`claude-extractor.ts`) per event, not per session: `usage.cache_creation`'s two
 * `ephemeral_*` counters win when either is non-zero, otherwise the whole flat
 * `cache_creation_input_tokens` falls into the 5m bucket. Applying the fallback
 * per event keeps `5m + 1h = cache_write_tokens` even in a session that mixes
 * old-format and new-format lines.
 *
 * `speed = 'fast'` tokens are a *subset* of `input_tokens` / `output_tokens`, which the
 * caller keeps summing in full — see `cost.sql.ts` for why fast mode is a surcharge.
 *
 * @param guarded wraps each per-event value in whatever row filter the calling CTE
 *   needs. The sessions-list CTE pre-filters assistant lines in a prior CTE and passes
 *   the value through unchanged; the timeline CTE aggregates all line types at once and
 *   wraps each value in its `type = 'assistant'` CASE.
 */
function jsonbUsageCostColumnsSql(guarded: (value: SQL) => SQL): SQL {
  const usage = sql`evt->'message'->'usage'`;
  const write5m = sql`COALESCE((${usage}->'cache_creation'->>'ephemeral_5m_input_tokens')::bigint, 0)`;
  const write1h = sql`COALESCE((${usage}->'cache_creation'->>'ephemeral_1h_input_tokens')::bigint, 0)`;
  const writeFlat = sql`COALESCE((${usage}->>'cache_creation_input_tokens')::bigint, 0)`;
  const isFast = sql`(${usage}->>'speed') = 'fast'`;
  return sql`SUM(${guarded(
    sql`CASE WHEN ${write5m} + ${write1h} > 0 THEN ${write5m} ELSE ${writeFlat} END`,
  )}) AS cache_write_5m_tokens,
            SUM(${guarded(write1h)}) AS cache_write_1h_tokens,
            SUM(${guarded(
              sql`COALESCE((${usage}->'server_tool_use'->>'web_search_requests')::bigint, 0)`,
            )}) AS web_search_requests,
            SUM(${guarded(
              sql`CASE WHEN ${isFast} THEN COALESCE((${usage}->>'input_tokens')::bigint, 0) ELSE 0 END`,
            )}) AS input_tokens_fast,
            SUM(${guarded(
              sql`CASE WHEN ${isFast} THEN COALESCE((${usage}->>'output_tokens')::bigint, 0) ELSE 0 END`,
            )}) AS output_tokens_fast`;
}

type AttributeValueBucket = {
  value: string | boolean | number;
  sessionCount: number;
};

/**
 * Turns the flat (session, key, raw JSON value) rows
 * `getSessionAttributionValues()` reads out of `session_attribution.values` into
 * `{ [key]: {value, sessionCount}[] }`, capped at 50 per attribute, ordered by `sessionCount`
 * desc. `string[]`-typed attributes fan out: each array element becomes its own value bucket
 * (matching how the `any` operator in `attributeFilterSql()` matches one element), deduplicated
 * per session so a session listing the same element twice never double-counts. Explicit `null`
 * ("not determined") is never a filterable concrete value, so it is skipped rather than bucketed.
 * Orphaned values (`isOrphanedValue()`) are skipped entirely — an unknown
 * key or a value whose runtime type no longer matches its declared type never appears here.
 */
function buildAttributeValueBuckets(
  rows: { sessionRowId: number; key: string; valueJson: string }[],
  typeLookup: ReturnType<typeof buildAttributeTypeLookup>,
  resolvedDefinitions: SessionAttributionAttributeDef[],
): Record<string, AttributeValueBucket[]> {
  const perKey = new Map<string, Map<string | boolean | number, Set<number>>>();

  for (const row of rows) {
    const declaredType = typeLookup.get(row.key);
    if (!declaredType) continue; // unknown key -- orphaned

    let parsed: string | string[] | boolean | number | null;
    try {
      parsed = JSON.parse(row.valueJson) as
        | string
        | string[]
        | boolean
        | number
        | null;
    } catch {
      continue;
    }
    if (parsed === null) continue; // "not determined" -- not a filterable value
    if (isOrphanedValue(row.key, parsed, resolvedDefinitions)) continue;

    const perValue =
      perKey.get(row.key) ?? new Map<string | boolean | number, Set<number>>();
    perKey.set(row.key, perValue);

    if (declaredType === 'string[]') {
      for (const element of parsed as string[]) {
        const sessionIds = perValue.get(element) ?? new Set<number>();
        sessionIds.add(row.sessionRowId);
        perValue.set(element, sessionIds);
      }
    } else {
      const scalar = parsed as string | boolean | number;
      const sessionIds = perValue.get(scalar) ?? new Set<number>();
      sessionIds.add(row.sessionRowId);
      perValue.set(scalar, sessionIds);
    }
  }

  const result: Record<string, AttributeValueBucket[]> = {};
  for (const [key, perValue] of perKey) {
    result[key] = [...perValue.entries()]
      .map(([value, sessionIds]) => ({ value, sessionCount: sessionIds.size }))
      .sort((a, b) => b.sessionCount - a.sessionCount)
      .slice(0, 50);
  }
  return result;
}

interface TimelineSession {
  sessionId: string;
  startTime: string;
  endTime: string;
  firstPrompt: string | null;
  gitBranch: string | null;
  userEmail: string | null;
  group: string | null;
  workTimeMs: number;
  totalCost: number | null;
  /**
   * **tree-scoped** — the session plus every sub-agent session below it at
   * any depth. `session_stats` rows are per-node, so a delegating session used to report 0
   * here while its sub-agents did all the work. The root's own figures are still available
   * additively as `*Own` below; never add those to these (double count — see
   * `session-tree-metrics.sql.ts`).
   */
  filesEditedWritten: number;
  linesChanged: number;
  filesEditedWrittenOwn: number;
  linesChangedOwn: number;
  imageCount: number;
  imageTotalBytes: number;
  mcpCallsTotal: number;
  mcpCallsByServer: Record<string, number>;
  fileStatsByCategory: Record<string, { files: number; bytes: number }>;
  logLineCount: number;
  // Cache tokens for the cache-read-ratio metric. Root values are the
  // session's own tokens; the `descendant*` pair sums all recursive descendants
  // (depth > 0), never a single-level parent match.
  cacheReadTokens: number;
  cacheWriteTokens: number;
  descendantCacheReadTokens: number;
  descendantCacheWriteTokens: number;
  // The remaining inputs to the canonical cost formula (`cost.sql.ts`), so a client
  // recomputing a timeline session's cost lands on the server's figure. `*Fast` are
  // subsets of the session's `input`/`output` totals, not additional tokens, and
  // `webSearchRequests` is priced per request rather than per million tokens.
  webSearchRequests: number;
  inputTokensFast: number;
  outputTokensFast: number;
  /**
   * 'unknown-model' when some model of the session tree (root, sub-agent or utility call)
   * has no `model_pricing` row, which is why `totalCost` is null; null otherwise
   * (including "no stats extracted yet").
   */
  costUnavailableReason: 'unknown-model' | null;
  /** The model ids with no price in Log Hub (sorted; empty when everything is priced). */
  unpricedModels: string[];
  isFavorite: boolean;
}

interface WorkTimeBucket {
  day: string;
  group: string | null;
  workTimeMinutes: number;
}

type AuthUser = { id: number; role: 'admin' | 'user' };

/**
 * The fixed (non-`attr:`) `groupBy` values `analytics/change-surface` accepts, in the
 * same shape `reports.controller.ts` whitelists its own two reports. `attr:<key>` is validated
 * separately, against this repo's resolved attribute definitions.
 */
const CHANGE_SURFACE_GROUP_BY_VALUES: readonly ChangeSurfaceGroupBy[] = [
  'none',
  'branch',
  'user',
];

/** The bucket sizes the timeline may be rendered at; `none` is not one of them. */
const CHANGE_SURFACE_TIMELINE_BUCKETS: readonly ChangeSurfaceTimelineBucket[] =
  ['hour', 'day', 'week'];

function isChangeSurfaceTimelineBucket(
  value: string,
): value is ChangeSurfaceTimelineBucket {
  return (CHANGE_SURFACE_TIMELINE_BUCKETS as readonly string[]).includes(value);
}

@Controller('api/v1/repositories')
@UseGuards(SessionAuthGuard)
export class RepositoriesController {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly repositoriesService: RepositoriesService,
    private readonly hookStateService: HookStateService,
    private readonly sessionAttributionService: SessionAttributionService,
    private readonly changeSurfaceService: ChangeSurfaceService,
    private readonly changeSurfaceAggregateService: ChangeSurfaceAggregateService,
  ) {}

  @Get()
  async listMyRepositories(@Req() req: Request) {
    const user = req.user as AuthUser;

    // Repos this user owns (repositories.userId) OR whose logs this user
    // authored (logs.userId) — these can diverge after an export/import
    // (the importer becomes the repo's owner while imported logs keep their
    // original author, see repository-export-import.service.ts). Left-joined
    // so an owned repo with zero logs (e.g. a freshly imported/registered
    // repo) still shows up, instead of being dropped by an inner join.
    const rows = await this.db
      .selectDistinct({
        id: schema.repositories.id,
        repoUrl: schema.repositories.repoUrl,
      })
      .from(schema.repositories)
      .leftJoin(
        schema.logRepositories,
        eq(schema.logRepositories.repoId, schema.repositories.id),
      )
      .leftJoin(schema.logs, eq(schema.logs.id, schema.logRepositories.logId))
      .where(
        or(
          eq(schema.repositories.userId, user.id),
          eq(schema.logs.userId, user.id),
        ),
      )
      .orderBy(asc(schema.repositories.repoUrl));

    return rows;
  }

  // Must be declared before @Get(':repoId') — Nest/Express match routes in declaration
  // order, so a literal 'hooks' segment here would otherwise be swallowed by :repoId's
  // ParseIntPipe (400 on the non-numeric string "hooks").
  @Get('hooks')
  async listHookRepositories(
    @Req() req: Request,
  ): Promise<HookRepositorySummary[]> {
    const user = req.user as AuthUser;
    return this.hookStateService.listHookRepositories(user.id);
  }

  @Get(':repoId/hook-state')
  async getRepositoryHookState(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<HookStateDetail> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoAccess(user, repoId, teamId);

    const hookState = await this.hookStateService.getHookState(repoId);
    if (!hookState) {
      throw new NotFoundException('Hook state not found for this repository');
    }
    return hookState;
  }

  @Get(':repoId')
  async getRepository(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    // A team member viewing a teammate's repo needs team-scoped access here too, so
    // the repository header can show the repo name in team views.
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const effectiveConfig =
      await this.repositoriesService.resolveEffectiveConfig(
        user.id,
        repo.repoUrl,
        teamId,
      );
    return {
      id: repo.id,
      repoUrl: repo.repoUrl,
      repoConfig: effectiveConfig.config,
    };
  }

  // With `teamId` (team view) access is team membership and the response is resolved for
  // that team; without it, personal ownership of `repoId`.
  @Get(':repoId/settings')
  async getRepoSettings(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<RepoSettingsResponse> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoAccess(user, repoId, teamId);
    return this.repositoriesService.getRepoSettings(user.id, repoId, teamId);
  }

  // With `teamId` writes exactly that team's config (its owner only); without it, the
  // caller's lowest-id owned team linking the URL.
  @Put(':repoId/settings/team')
  async saveTeamConfig(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Body() body: { config: RepoConfigJson | null },
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<RepoSettingsResponse> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoAccess(user, repoId, teamId);
    return this.repositoriesService.saveTeamConfig(
      user.id,
      repoId,
      body.config,
      teamId,
    );
  }

  @Put(':repoId/settings/user')
  async saveUserConfig(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Body() body: { config: RepoConfigJson | null },
  ): Promise<RepoSettingsResponse> {
    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoAccess(user, repoId);
    return this.repositoriesService.saveUserConfig(
      user.id,
      repoId,
      body.config,
    );
  }

  @Get(':repoId/sessions')
  async getRepositorySessions(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('branch') branchParam?: string,
    @Query('attr') attrParam?: string | string[],
  ) {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    const { repoCondition, branchCondition, ownerCondition, repoUrl, scope } =
      await this.repositoriesService.buildSessionListConditions(
        user,
        repoId,
        teamId,
        branchParam,
      );

    // Repeatable `attr=<key>:<op>:<value>`
    // filters, validated against this repo's resolved attribute definitions before being
    // spliced into the session-selection `and(...)` below. `resolvedDefinitions` is also
    // what strips orphaned entries from `attribution`/`lastRun` further
    // down, so it is resolved unconditionally rather than only when `attr=` is present.
    const attributeFilters = parseAttributeFilters(
      normalizeRepeatableParam(attrParam),
    );
    const resolvedDefinitions = await this.sessionAttributionService
      .resolveDefinitions(user.id, repoUrl, teamId)
      .then((d) => d.attributes);
    if (attributeFilters.length > 0) {
      validateAttributeFilterTypes(
        attributeFilters,
        buildAttributeTypeLookup(resolvedDefinitions),
      );
    }
    const attrCondition = attributeFilterSql(
      attributeFilters,
      sql`${schema.sessions.id}`,
    );

    const sessionRows = await this.db
      .selectDistinct({
        sessionId: schema.sessions.sessionId,
        sessionRowId: schema.sessions.id,
        firstPrompt: schema.logs.firstPrompt,
        startTime: schema.logs.startTime,
        endTime: schema.logs.endTime,
        gitBranch: schema.logs.gitBranch,
        userEmail: schema.users.email,
        updatedAt: schema.logs.updatedAt,
        sortTime: sql<Date>`COALESCE(${schema.logs.endTime}, ${schema.logs.updatedAt})`,
        isHookService: sql<boolean>`${schema.logs.body} @> '[{"event":"hook_service"}]'::jsonb`,
      })
      .from(schema.sessions)
      .innerJoin(schema.logs, eq(schema.logs.sessionId, schema.sessions.id))
      .innerJoin(
        schema.logRepositories,
        eq(schema.logRepositories.logId, schema.logs.id),
      )
      .innerJoin(
        schema.repositories,
        eq(schema.repositories.id, schema.logRepositories.repoId),
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.logs.userId))
      .where(
        and(
          repoCondition,
          eq(schema.logs.logType, 'artisyn'),
          isNotNull(schema.logs.firstPrompt),
          eq(schema.sessions.deleted, false),
          exists(
            this.db
              .select({ id: schema.logs.id })
              .from(schema.logs)
              .where(
                and(
                  eq(schema.logs.sessionId, schema.sessions.id),
                  eq(schema.logs.logType, 'claude'),
                ),
              ),
          ),
          branchCondition,
          ownerCondition,
          attrCondition,
        ),
      )
      .orderBy(
        desc(sql`COALESCE(${schema.logs.endTime}, ${schema.logs.updatedAt})`),
      );

    const filtered = sessionRows.filter((r) => r.firstPrompt !== null);

    const costMap = new Map<
      number,
      {
        totalCost: number | null;
        computedCost: number | null;
        otelCost: number | null;
        costUnavailableReason: 'unknown-model' | null;
        costBreakdown: CostBreakdown;
      }
    >();
    if (filtered.length > 0) {
      const sessionRowIds = filtered.map((r) => r.sessionRowId);
      // Pass IDs as a single PostgreSQL array literal string ($1::bigint[]).
      // A plain string becomes ONE bind parameter; number[] would expand to N individual params
      // causing massive planning overhead and "malformed array literal" errors.
      const idsLiteral = `{${sessionRowIds.join(',')}}`;
      const idsArray = sql`${idsLiteral}::bigint[]`;
      type CostRow = TreeCostSqlRow & {
        model: string | null;
        otel_cost: string | null;
      };
      const costResult = await this.db.execute(sql`
        WITH RECURSIVE ${descendantSessionsCte(idsArray)},
        ${otelCostsCte(idsArray)},
        assistant_lines AS (
          -- One API response can be split across multiple transcript lines — one per
          -- content block (thinking/tool_use/text) — each repeating the SAME
          -- message.usage. DISTINCT ON (session, message.id) keeps exactly one line per
          -- real API response so usage isn't summed once per content block — the LAST
          -- one (ord DESC), since a first block line written mid-stream can carry a
          -- partial output_tokens (same rule as extractClaudeStats). A line
          -- missing message.id falls back to its own uuid, which is unique per line, so
          -- it can never collide with another line and is always kept.
          SELECT DISTINCT ON (cl.session_id, COALESCE(evt->'message'->>'id', evt->>'uuid'))
            cl.session_id AS session_row_id,
            ord,
            evt
          FROM logs cl
          CROSS JOIN LATERAL jsonb_array_elements(cl.body) WITH ORDINALITY AS t(evt, ord)
          WHERE cl.log_type = 'claude'
            AND cl.session_id = ANY(${idsArray})
            AND (evt->>'type') = 'assistant'
            AND (evt->>'isSidechain') IS DISTINCT FROM 'true'
          ORDER BY cl.session_id, COALESCE(evt->'message'->>'id', evt->>'uuid'), ord DESC
        ),
        session_events_jsonb AS (
          SELECT
            session_row_id,
            -- First non-null model, in log order — matches extractClaudeStats()'s
            -- "first non-null model wins" logic (claude-extractor.ts). MIN() would pick
            -- the alphabetically-smallest model string instead, which is wrong whenever
            -- a session used more than one model (e.g. manual /model switches) and can
            -- massively over/under-price the session.
            (ARRAY_AGG(evt->'message'->>'model' ORDER BY ord) FILTER (
              WHERE (evt->'message'->>'model') IS NOT NULL
            ))[1] AS model
          FROM assistant_lines
          GROUP BY session_row_id
        ),
        -- Cost comes from the stored session_costs rows (DD10) plus the utility calls,
        -- all in tree_costs (session-tree-cost.sql.ts). The model shown is still taken
        -- ONLY from the JSONB aggregate above, never ss.model (which falls back to the
        -- sidechain model).
        ${treeCostCtes(idsArray)}
        SELECT
          se.session_row_id,
          se.model AS model,
          ${TREE_COST_COLUMNS_SQL},
          oc.otel_cost AS otel_cost
        FROM session_events_jsonb se
        JOIN tree_costs tc ON tc.session_row_id = se.session_row_id
        LEFT JOIN otel_costs oc ON oc.session_row_id = se.session_row_id
      `);
      // The shown cost is the complete computed tree cost (readTreeCost →
      // resolveSessionTotalCost): null as soon as the root, a sub-agent or a utility call is
      // unpriced. The OTEL total is only a cross-check (hasCostDiscrepancy, mismatch).
      const toNum = (v: string | number | null): number | null =>
        v == null ? null : typeof v === 'number' ? v : parseFloat(v);
      for (const row of costResult.rows as unknown as CostRow[]) {
        const tree = readTreeCost(row, row.model);
        const otelCost = toNum(row.otel_cost);
        costMap.set(Number(row.session_row_id), {
          totalCost: tree.total,
          computedCost: tree.total,
          otelCost,
          costBreakdown: {
            mainCost: tree.mainCost,
            subagentCost: tree.subagentCost,
            utilityCost: tree.utilityCost,
            calculatedCost: tree.total,
            telemetryCost: otelCost,
            mismatch: costMismatch(otelCost, tree.total),
            utilityPricingMissing: tree.utilityPricingMissing,
            subagentPricingMissing: tree.subagentPricingMissing,
            unpricedModels: tree.unpricedModels,
          },
          // 'unknown-model' only when some model of the tree has no price. A session
          // whose transcript carries no model at all has nothing to price, so its reason
          // stays null — the missing figure there is "no stats yet".
          costUnavailableReason: tree.costUnavailableReason,
        });
      }
    }

    const sessionDbIds = filtered.map((r) => r.sessionRowId);
    const favoriteIds = await this.repositoriesService.getFavoriteSessionIds(
      user.id,
      sessionDbIds,
    );

    // Fetch owner userId for each session via a separate lookup
    // (do NOT add userId to selectDistinct — it would break distinctness and produce duplicates)
    const ownerMap = new Map<number, number>();
    if (sessionDbIds.length > 0) {
      const idsLiteralOwner = `{${sessionDbIds.join(',')}}`;
      const idsArrayOwner = sql`${idsLiteralOwner}::bigint[]`;
      type OwnerRow = { session_id: string; user_id: string };
      const ownerResult = await this.db.execute(sql`
        SELECT session_id, user_id
        FROM logs
        WHERE session_id = ANY(${idsArrayOwner})
          AND log_type = 'artisyn'
      `);
      for (const row of ownerResult.rows as unknown as OwnerRow[]) {
        ownerMap.set(Number(row.session_id), Number(row.user_id));
      }
    }

    // Build hasWorkflowSet: session row ids whose claude log body contains a Workflow
    // tool_use. The predicate mirrors `extractWorkflows` (workflow-extractor.ts): an
    // assistant event whose `message.content` holds a `tool_use` block named `Workflow`
    // with a non-empty string `id`. The `@>` containment is a cheap jsonb pre-filter;
    // the `EXISTS` is the exact check (the old `body::text LIKE` matched any text that
    // merely mentioned the tool name, and depended on jsonb's text rendering).
    // The `CASE jsonb_typeof(...)` guards keep `jsonb_array_elements` from raising on a
    // non-array value, since Postgres does not guarantee AND evaluation order.
    const hasWorkflowSet = new Set<number>();
    if (sessionDbIds.length > 0) {
      const idsLiteralWorkflow = `{${sessionDbIds.join(',')}}`;
      const idsArrayWorkflow = sql`${idsLiteralWorkflow}::bigint[]`;
      type WorkflowRow = { session_row_id: string };
      const workflowResult = await this.db.execute(sql`
        SELECT DISTINCT s.id AS session_row_id
        FROM sessions s
        INNER JOIN logs cl ON cl.session_id = s.id AND cl.log_type = 'claude'
        WHERE s.id = ANY(${idsArrayWorkflow})
          AND cl.body @> '[{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Workflow"}]}}]'::jsonb
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(cl.body) = 'array' THEN cl.body ELSE '[]'::jsonb END
                 ) AS ev(e),
                 jsonb_array_elements(
                   CASE WHEN jsonb_typeof(ev.e -> 'message' -> 'content') = 'array'
                        THEN ev.e -> 'message' -> 'content' ELSE '[]'::jsonb END
                 ) AS blk(tu)
            WHERE ev.e ->> 'type' = 'assistant'
              AND blk.tu ->> 'type' = 'tool_use'
              AND blk.tu ->> 'name' = 'Workflow'
              AND jsonb_typeof(blk.tu -> 'id') = 'string'
              AND blk.tu ->> 'id' <> ''
          )
      `);
      for (const row of workflowResult.rows as unknown as WorkflowRow[]) {
        hasWorkflowSet.add(Number(row.session_row_id));
      }
    }

    // Claude Code version per session: the transcript-derived value wins, the OTEL
    // `service.version` fallback fills in when the transcript carried none.
    const claudeVersionMap = new Map<number, string>();
    if (sessionDbIds.length > 0) {
      const idsLiteralVersion = `{${sessionDbIds.join(',')}}`;
      const idsArrayVersion = sql`${idsLiteralVersion}::bigint[]`;
      type ClaudeVersionRow = {
        session_id: string;
        claude_version: string | null;
      };
      const versionResult = await this.db.execute(sql`
        SELECT session_id, COALESCE(claude_version, claude_version_otel) AS claude_version
        FROM session_stats
        WHERE session_id = ANY(${idsArrayVersion})
      `);
      for (const row of versionResult.rows as unknown as ClaudeVersionRow[]) {
        if (row.claude_version !== null) {
          claudeVersionMap.set(Number(row.session_id), row.claude_version);
        }
      }
    }

    // Session row ids whose LATEST submitted Turn-End Cost Advisor run
    // (mirrors getLatestResult()'s own "most recent submitted, by started_at" semantics) has
    // a non-empty harnessAdvice array. `turn_end_advisor_runs.session_id` is the raw string
    // session id (varchar since migration 0058), joined against `sessions.session_id`, not
    // `sessions.id`.
    const hasAdvisorAdviceSet = new Set<number>();
    if (sessionDbIds.length > 0) {
      const idsLiteralAdvisor = `{${sessionDbIds.join(',')}}`;
      const idsArrayAdvisor = sql`${idsLiteralAdvisor}::bigint[]`;
      type AdvisorAdviceRow = { session_row_id: string };
      const advisorAdviceResult = await this.db.execute(sql`
        SELECT s.id AS session_row_id
        FROM sessions s
        INNER JOIN LATERAL (
          SELECT harness_advice
          FROM turn_end_advisor_runs t
          WHERE t.session_id = s.session_id AND t.outcome = 'submitted'
            -- Only runs recorded by the
            -- session owner (the artisyn log's user) count; NULL user_id never matches.
            AND t.user_id = (
              SELECT ol.user_id FROM logs ol
              WHERE ol.session_id = s.id AND ol.log_type = 'artisyn'
              LIMIT 1
            )
          ORDER BY t.started_at DESC
          LIMIT 1
        ) latest ON true
        WHERE s.id = ANY(${idsArrayAdvisor})
          AND latest.harness_advice IS NOT NULL
          AND jsonb_array_length(latest.harness_advice) > 0
      `);
      for (const row of advisorAdviceResult.rows as unknown as AdvisorAdviceRow[]) {
        hasAdvisorAdviceSet.add(Number(row.session_row_id));
      }
    }

    // Attribution values + latest run outcome for every session in
    // this page, one batched query (no per-row lookup) via a LEFT JOIN against
    // `session_attribution` and a LATERAL join against `session_attribution_runs` (at most
    // one row per session, its most recent by `started_at`). Orphaned value entries
    // are stripped in JS below via `resolvedDefinitions`, the same list used
    // above to validate `attr=` filters.
    const attributionMap = new Map<
      number,
      {
        values: Record<string, string | string[] | boolean | number | null>;
        promptWatermark: number;
        updatedAt: string;
      }
    >();
    const lastRunMap = new Map<
      number,
      {
        outcome: string;
        finishedAt: string;
        failureReason: string | null;
      }
    >();
    if (sessionDbIds.length > 0) {
      const idsLiteralAttr = `{${sessionDbIds.join(',')}}`;
      const idsArrayAttr = sql`${idsLiteralAttr}::bigint[]`;
      type AttributionRow = {
        session_row_id: string;
        values: Record<
          string,
          string | string[] | boolean | number | null
        > | null;
        prompt_watermark: number | null;
        updated_at: string | null;
        last_run_outcome: string | null;
        last_run_finished_at: string | null;
        last_run_failure_reason: string | null;
      };
      const attributionResult = await this.db.execute(sql`
        SELECT
          s.id AS session_row_id,
          sa.values AS values,
          sa.prompt_watermark AS prompt_watermark,
          sa.updated_at::text AS updated_at,
          lr.outcome AS last_run_outcome,
          lr.finished_at::text AS last_run_finished_at,
          lr.failure_reason AS last_run_failure_reason
        FROM sessions s
        LEFT JOIN session_attribution sa ON sa.session_id = s.id
        LEFT JOIN LATERAL (
          SELECT outcome, finished_at, failure_reason
          FROM session_attribution_runs r
          WHERE r.session_id = s.id
          ORDER BY r.started_at DESC
          LIMIT 1
        ) lr ON true
        WHERE s.id = ANY(${idsArrayAttr})
      `);

      for (const row of attributionResult.rows as unknown as AttributionRow[]) {
        const sessionRowId = Number(row.session_row_id);

        if (row.values != null && row.prompt_watermark != null) {
          const strippedValues: Record<
            string,
            string | string[] | boolean | number | null
          > = {};
          for (const [key, value] of Object.entries(row.values)) {
            if (!isOrphanedValue(key, value, resolvedDefinitions)) {
              strippedValues[key] = value;
            }
          }
          attributionMap.set(sessionRowId, {
            values: strippedValues,
            promptWatermark: row.prompt_watermark,
            updatedAt: new Date(row.updated_at!).toISOString(),
          });
        }

        if (row.last_run_outcome != null && row.last_run_finished_at != null) {
          lastRunMap.set(sessionRowId, {
            outcome: row.last_run_outcome,
            finishedAt: new Date(row.last_run_finished_at).toISOString(),
            failureReason: row.last_run_failure_reason ?? null,
          });
        }
      }
    }

    return filtered.map((r) => {
      const cost = costMap.get(r.sessionRowId);
      const attribution = attributionMap.get(r.sessionRowId) ?? null;
      const lastRun = lastRunMap.get(r.sessionRowId) ?? null;
      const rowUserId = ownerMap.get(r.sessionRowId) ?? null;
      return {
        sessionId: r.sessionId,
        // A `manager` sees every visible member's session row
        // and its statistics, but never another member's prompt text. Masking happens
        // here, in the projection — never in the `WHERE`, where `first_prompt IS NOT
        // NULL` is the root-session discriminator and would delete the whole row.
        // `null` on the wire therefore always means "hidden".
        firstPrompt: maskFirstPrompt(scope, user.id, rowUserId, r.firstPrompt),
        startTime: (r.startTime ?? r.updatedAt).toISOString(),
        endTime: (r.endTime ?? r.updatedAt).toISOString(),
        gitBranch: r.gitBranch ?? undefined,
        userEmail: r.userEmail ?? undefined,
        totalCost: cost?.totalCost ?? null,
        // Always present for a listed session — a session with no cost row (no
        // assistant lines yet) gets the empty breakdown.
        costBreakdown: cost?.costBreakdown ?? EMPTY_COST_BREAKDOWN,
        computedCost: cost?.computedCost ?? null,
        // computedCost here is the utility-inclusive calculatedCost.
        hasCostDiscrepancy: otelComputedDiscrepancy(
          cost?.otelCost ?? null,
          cost?.costBreakdown.calculatedCost ?? null,
        ),
        // Lets the UI say "this model has no pricing row" instead of silently
        // rendering an em dash that is indistinguishable from a genuinely free session.
        costUnavailableReason: cost?.costUnavailableReason ?? null,
        isFavorite: favoriteIds.has(r.sessionRowId),
        userId: rowUserId,
        isHookService: r.isHookService ?? false,
        hasWorkflow: hasWorkflowSet.has(r.sessionRowId),
        hasAdvisorAdvice: hasAdvisorAdviceSet.has(r.sessionRowId),
        claudeVersion: claudeVersionMap.get(r.sessionRowId) ?? null,
        // Null when the session has no attribution row / no run has ever been
        // recorded — never an empty-object placeholder (Visual/UX notes: "a session with no
        // attribution row shows no chips").
        attribution,
        lastRun,
      };
    });
  }

  // Lightweight sibling of getRepositorySessions() for badge-poll callers: same
  // access/filter scoping, but skips firstPrompt and the cost/favorite/hasWorkflow
  // enrichment queries so a 15s poll doesn't repeatedly pay for a full session list.
  @Get(':repoId/sessions/ids')
  async getRepositorySessionIds(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('branch') branchParam?: string,
    @Query('hideHookSessions') hideHookSessionsParam?: string,
    @Query('filterByUserEmail') filterByUserEmail?: string,
  ): Promise<string[]> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    const { repoCondition, branchCondition, ownerCondition } =
      await this.repositoriesService.buildSessionListConditions(
        user,
        repoId,
        teamId,
        branchParam,
      );

    const isHookServiceExpr = sql<boolean>`${schema.logs.body} @> '[{"event":"hook_service"}]'::jsonb`;
    const hideHookSessionsCondition =
      hideHookSessionsParam === 'true'
        ? sql`NOT (${isHookServiceExpr})`
        : undefined;
    const filterByUserEmailCondition = filterByUserEmail
      ? eq(schema.users.email, filterByUserEmail)
      : undefined;

    const rows = await this.db
      .selectDistinct({
        sessionId: schema.sessions.sessionId,
      })
      .from(schema.sessions)
      .innerJoin(schema.logs, eq(schema.logs.sessionId, schema.sessions.id))
      .innerJoin(
        schema.logRepositories,
        eq(schema.logRepositories.logId, schema.logs.id),
      )
      .innerJoin(
        schema.repositories,
        eq(schema.repositories.id, schema.logRepositories.repoId),
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.logs.userId))
      .where(
        and(
          repoCondition,
          eq(schema.logs.logType, 'artisyn'),
          isNotNull(schema.logs.firstPrompt),
          eq(schema.sessions.deleted, false),
          exists(
            this.db
              .select({ id: schema.logs.id })
              .from(schema.logs)
              .where(
                and(
                  eq(schema.logs.sessionId, schema.sessions.id),
                  eq(schema.logs.logType, 'claude'),
                ),
              ),
          ),
          branchCondition,
          ownerCondition,
          hideHookSessionsCondition,
          filterByUserEmailCondition,
        ),
      );

    return rows.map((r) => r.sessionId);
  }

  @Get(':repoId/sessions/branches')
  async getRepositorySessionBranches(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDateParam?: string,
    @Query('endDate') endDateParam?: string,
    @Query('attr') attrParam?: string | string[],
  ) {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    let startDate: Date | undefined;
    let endDate: Date | undefined;
    if (startDateParam || endDateParam) {
      if (!startDateParam || !endDateParam) {
        throw new BadRequestException(
          'startDate and endDate must be provided together',
        );
      }
      startDate = new Date(startDateParam);
      endDate = new Date(endDateParam);
      if (isNaN(startDate.getTime())) {
        throw new BadRequestException(
          'startDate must be a valid ISO 8601 date',
        );
      }
      if (isNaN(endDate.getTime())) {
        throw new BadRequestException('endDate must be a valid ISO 8601 date');
      }
    }

    const user = req.user as AuthUser;
    const repoBranch = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIdsBranch = await this.repositoriesService.resolveRepoIds(
      repoId,
      repoBranch.repoUrl,
      teamId,
    );
    const repoIdsBranchLiteral = `{${repoIdsBranch.join(',')}}`;
    const repoBranchFilter = sql`lr.repo_id = ANY(${repoIdsBranchLiteral}::int[])`;

    // Team access mode: narrow to the user ids this caller may see. A
    // `transparent` team resolves to `null` — no predicate at all, the exact SQL that
    // ran before access modes existed. This route is deliberately NOT analytics-gated:
    // a plain member needs it for their own sessions.
    const scopeBranch = await this.repositoriesService.resolveTeamScope(
      user,
      teamId,
    );
    const ownerBranchFilter = teamScopeUserFilterSql(teamId, scopeBranch, 'l');

    const dateRangeBranchFilter =
      startDate && endDate
        ? sql`AND l.start_time >= ${startDate} AND l.start_time <= ${endDate}`
        : sql``;

    // Feeds the "Cost by Branch"/"Branch Summary"
    // reports, both of which fetch this one route (`fetchRepositoryBranches()`).
    const attributeFilters = parseAttributeFilters(
      normalizeRepeatableParam(attrParam),
    );
    if (attributeFilters.length > 0) {
      const resolvedDefinitions = await this.sessionAttributionService
        .resolveDefinitions(user.id, repoBranch.repoUrl, teamId)
        .then((d) => d.attributes);
      validateAttributeFilterTypes(
        attributeFilters,
        buildAttributeTypeLookup(resolvedDefinitions),
      );
    }
    const attrCondition = attributeFilterSql(
      attributeFilters,
      sql`l.session_id`,
    );
    const attrBranchFilter = attrCondition ? sql`AND ${attrCondition}` : sql``;

    type BranchRow = {
      branch: string | null;
      session_count: string;
      latest_end_time: string;
      total_work_time_ms: string;
      /**
       * Root-only, as this SUM always was — the tree-scoped figure is folded in TS
       * from `loadTreeMetricsByRoot`, because the tree rollup needs a
       * recursive CTE this `git_branch` aggregate cannot host without disturbing its
       * grouping.
       */
      total_lines_changed_own: string;
      /**
       * The branch's root `sessions.id` values, index-paired with
       * `session_lines_changed_own`. Duplicates are possible in principle (one row per
       * `logs`/`log_repositories` match) and are deliberately kept: the pairs are folded
       * index-wise so the own total stays byte-identical to `total_lines_changed_own`.
       */
      session_row_ids: (string | number)[];
      session_lines_changed_own: (string | number)[];
      total_cost: string | null;
    };

    const result = await this.db.execute(sql`
      SELECT
        l.git_branch                                    AS branch,
        COUNT(*)::text                                  AS session_count,
        MAX(COALESCE(l.end_time, l.updated_at))::text  AS latest_end_time,
        -- Temporal, therefore already the correct tree value —
        -- sub-agents run inside the root's wall-clock span. Do NOT roll this up.
        SUM(COALESCE(ss.work_time_ms, 0))::text         AS total_work_time_ms,
        SUM(COALESCE(ss.lines_changed, 0))::text        AS total_lines_changed_own,
        ARRAY_AGG(s.id)                                 AS session_row_ids,
        ARRAY_AGG(COALESCE(ss.lines_changed, 0))        AS session_lines_changed_own,
        -- Stored computed cost of each root (NULL = unpriced / no row). The OTEL total
        -- never stands in for it (Log Hub's price is the source of truth, see
        -- otel-cost.sql.ts). Still root-only: sub-agents and utility calls are not rolled
        -- up here (a known gap, pinned by the golden-load branch scenario).
        SUM(sc.cost)::text                              AS total_cost
      FROM logs l
      INNER JOIN sessions s ON s.id = l.session_id AND s.deleted = false
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      LEFT JOIN session_stats ss ON ss.session_id = l.session_id
      LEFT JOIN session_costs sc ON sc.session_id = l.session_id
      WHERE ${repoBranchFilter}
        AND l.log_type = 'artisyn'
        AND l.first_prompt IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM logs cl
          WHERE cl.session_id = l.session_id AND cl.log_type = 'claude'
        )
        ${ownerBranchFilter}
        ${dateRangeBranchFilter}
        ${attrBranchFilter}
      GROUP BY l.git_branch
      ORDER BY MAX(COALESCE(l.end_time, l.updated_at)) DESC
    `);

    const branchRows = result.rows as unknown as BranchRow[];

    // One extra batched query for the tree rollup of every
    // root on every branch, never a per-branch or per-session round trip. The `git_branch`
    // grouping above stays untouched; the tree total is folded here.
    const branchRootIds = [
      ...new Set(
        branchRows.flatMap((row) =>
          (row.session_row_ids ?? []).map((id) => Number(id)),
        ),
      ),
    ];
    const branchTreeMetrics = await loadTreeMetricsByRoot(
      this.db,
      branchRootIds,
    );

    return branchRows.map((row) => {
      const rootIds = row.session_row_ids ?? [];
      const ownLines = row.session_lines_changed_own ?? [];
      let totalLinesChanged = 0;
      rootIds.forEach((rawId, i) => {
        // withOwnFallback is the only sanctioned tree+own combination: the rollup already
        // contains the root, so the own value is added back only for a root the rollup
        // never counted (no session_stats row, or excluded by the OTEL-only-row guard).
        totalLinesChanged += withOwnFallback(
          branchTreeMetrics.get(Number(rawId)),
          { linesChanged: Number(ownLines[i] ?? 0), filesEditedWritten: 0 },
        ).linesChanged;
      });
      return {
        branch: row.branch,
        sessionCount: Number(row.session_count),
        latestEndTime: row.latest_end_time,
        totalWorkTimeMs: Number(row.total_work_time_ms),
        totalLinesChanged,
        totalLinesChangedOwn: Number(row.total_lines_changed_own),
        totalCost: row.total_cost != null ? parseFloat(row.total_cost) : null,
      };
    });
  }

  /**
   * Feeds `AttributeFilterPopover.tsx`'s value lists, modeled
   * directly on `getRepositorySessionBranches()` above: same `teamId`/`startDate`/`endDate`
   * scope, same repo/date/owner filter fragments. Does not touch `getRepositorySessions()`'s
   * own result set — this reads `session_attribution.values` directly so the popover can
   * populate without first fetching the (possibly filtered) session list.
   */
  @Get(':repoId/session-attribution/values')
  async getSessionAttributionValues(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDateParam?: string,
    @Query('endDate') endDateParam?: string,
  ): Promise<Record<string, AttributeValueBucket[]>> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    let startDate: Date | undefined;
    let endDate: Date | undefined;
    if (startDateParam || endDateParam) {
      if (!startDateParam || !endDateParam) {
        throw new BadRequestException(
          'startDate and endDate must be provided together',
        );
      }
      startDate = new Date(startDateParam);
      endDate = new Date(endDateParam);
      if (isNaN(startDate.getTime())) {
        throw new BadRequestException(
          'startDate must be a valid ISO 8601 date',
        );
      }
      if (isNaN(endDate.getTime())) {
        throw new BadRequestException('endDate must be a valid ISO 8601 date');
      }
    }

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );

    const definitions = await this.sessionAttributionService.resolveDefinitions(
      user.id,
      repo.repoUrl,
      teamId,
    );
    if (definitions.attributes.length === 0) {
      return {};
    }
    const typeLookup = buildAttributeTypeLookup(definitions.attributes);

    const repoIdsValues = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      teamId,
    );
    const repoIdsValuesLiteral = `{${repoIdsValues.join(',')}}`;
    const repoValuesFilter = sql`lr.repo_id = ANY(${repoIdsValuesLiteral}::int[])`;

    // Team access mode — see `teamScopeUserFilterSql`. Not analytics-gated:
    // a plain member needs this route for their own sessions.
    const scopeValues = await this.repositoriesService.resolveTeamScope(
      user,
      teamId,
    );
    const ownerValuesFilter = teamScopeUserFilterSql(teamId, scopeValues, 'l');

    const dateRangeValuesFilter =
      startDate && endDate
        ? sql`AND l.start_time >= ${startDate} AND l.start_time <= ${endDate}`
        : sql``;

    type ValueRow = { session_row_id: string; key: string; value_json: string };
    const result = await this.db.execute(sql`
      SELECT
        s.id AS session_row_id,
        kv.key AS key,
        kv.value::text AS value_json
      FROM sessions s
      INNER JOIN session_attribution sa ON sa.session_id = s.id
      INNER JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      CROSS JOIN LATERAL jsonb_each(sa.values) AS kv(key, value)
      WHERE ${repoValuesFilter}
        AND l.first_prompt IS NOT NULL
        AND s.deleted = false
        AND EXISTS (
          SELECT 1 FROM logs cl
          WHERE cl.session_id = l.session_id AND cl.log_type = 'claude'
        )
        ${ownerValuesFilter}
        ${dateRangeValuesFilter}
    `);

    return buildAttributeValueBuckets(
      (result.rows as unknown as ValueRow[]).map((r) => ({
        sessionRowId: Number(r.session_row_id),
        key: r.key,
        valueJson: r.value_json,
      })),
      typeLookup,
      definitions.attributes,
    );
  }

  @Get(':repoId/contexts')
  async getRepositoryContexts(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoAccess(user, repoId, teamId);

    const rows = await this.db
      .selectDistinct({
        key: schema.contexts.contextKey,
        value: schema.contexts.contextValue,
      })
      .from(schema.contexts)
      .innerJoin(
        schema.logContexts,
        eq(schema.logContexts.contextId, schema.contexts.id),
      )
      .innerJoin(schema.logs, eq(schema.logs.id, schema.logContexts.logId))
      .innerJoin(
        schema.logRepositories,
        eq(schema.logRepositories.logId, schema.logs.id),
      )
      .where(
        and(
          eq(schema.logRepositories.repoId, repoId),
          eq(schema.logs.logType, 'artisyn'),
        ),
      )
      .orderBy(asc(schema.contexts.contextKey));

    return rows;
  }

  @Get(':repoId/sessions/:sessionId/contexts')
  async getSessionContexts(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('sessionId') sessionId: string,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIds = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      teamId,
    );
    const repoCondition =
      repoIds.length === 1
        ? eq(schema.logRepositories.repoId, repoIds[0])
        : inArray(schema.logRepositories.repoId, repoIds);

    // A route that names one session by id has no filtered form, so
    // an out-of-scope session 403s here instead of coming back as an empty list.
    const scope = await this.repositoriesService.resolveTeamScope(user, teamId);
    await this.assertSessionVisibleBySessionId(user, scope, teamId, sessionId);

    const ownerCondition =
      teamId !== undefined && scope.visibleUserIds !== null
        ? inArray(schema.logs.userId, scope.visibleUserIds)
        : undefined;

    const rows = await this.db
      .selectDistinct({
        key: schema.contexts.contextKey,
        value: schema.contexts.contextValue,
      })
      .from(schema.contexts)
      .innerJoin(
        schema.logContexts,
        eq(schema.logContexts.contextId, schema.contexts.id),
      )
      .innerJoin(schema.logs, eq(schema.logs.id, schema.logContexts.logId))
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.logs.sessionId))
      .innerJoin(
        schema.logRepositories,
        eq(schema.logRepositories.logId, schema.logs.id),
      )
      .where(
        and(
          eq(schema.sessions.sessionId, sessionId),
          repoCondition,
          eq(schema.logs.logType, 'artisyn'),
          ownerCondition,
        ),
      )
      .orderBy(asc(schema.contexts.contextKey));

    return rows;
  }

  /**
   * One session tree's change surface, the aggregate only.
   *
   * Split from the per-file listing below on purpose: this payload is
   * fetched on *every* session open (the Summary tile and the three CS detectors read it),
   * while the file rows are only needed once the Change surface tab is actually opened.
   *
   * An inaccessible or never-recomputed session returns a `computed: false` aggregate rather
   * than a 404 or a zeroed one — every client surface renders that as "no data", which is
   * both the honest answer for a session whose extractor never ran and a non-answer for a
   * session the caller may not see.
   */
  @Get(':repoId/sessions/:sessionId/change-surface')
  async getSessionChangeSurface(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('sessionId') sessionId: string,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<ChangeSurfaceAggregate> {
    const { repoIds, scope } = await this.resolveChangeSurfaceSessionScope(
      req,
      repoId,
      teamId,
      sessionId,
    );
    return this.changeSurfaceService.getSessionAggregate(
      repoIds,
      sessionId,
      scope,
    );
  }

  /**
   * The per-path rows behind the Change surface tab's file tree.
   *
   * Capped at {@link CHANGE_SURFACE_MAX_FILE_ROWS} with `total`/`truncated` reported next to
   * the rows, so the tab says "showing first 5,000 of N paths" instead
   * of silently cutting the tree. The aggregate route above is deliberately *never* capped —
   * no headline number and no `sum(leaf +) === root +` identity may depend on this limit.
   */
  @Get(':repoId/sessions/:sessionId/change-surface/files')
  async getSessionChangeSurfaceFiles(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('sessionId') sessionId: string,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<{
    files: ChangeSurfaceFileRow[];
    total: number;
    truncated: boolean;
  }> {
    const { repoIds, scope } = await this.resolveChangeSurfaceSessionScope(
      req,
      repoId,
      teamId,
      sessionId,
    );
    const files = await this.changeSurfaceService.getSessionFiles(
      repoIds,
      sessionId,
      scope,
    );

    return {
      files: files.slice(0, CHANGE_SURFACE_MAX_FILE_ROWS),
      total: files.length,
      truncated: files.length > CHANGE_SURFACE_MAX_FILE_ROWS,
    };
  }

  /**
   * The repo scope and owner narrowing both session change-surface routes resolve —
   * identical to `getSessionContexts()`'s: `assertRepoAccess` 403s a repository the caller
   * cannot reach, `resolveRepoIds` widens to the same repository as seen through the other
   * team rows, and a team view narrows to the user ids the caller's team access mode lets
   * them see (`null` in a `transparent` team — no predicate at all).
   *
   * `sessionId` is passed so the route can 403 a session outside that scope rather than
   * answer with an empty/`computed: false` payload.
   */
  private async resolveChangeSurfaceSessionScope(
    req: Request,
    repoId: number,
    teamId: number | undefined,
    sessionId: string,
  ): Promise<{ repoIds: number[]; scope: ChangeSurfaceSessionScope }> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIds = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      teamId,
    );
    const teamScope = await this.repositoriesService.resolveTeamScope(
      user,
      teamId,
    );
    await this.assertSessionVisibleBySessionId(
      user,
      teamScope,
      teamId,
      sessionId,
    );

    return {
      repoIds,
      scope: {
        visibleUserIds: teamId === undefined ? null : teamScope.visibleUserIds,
      },
    };
  }

  /**
   * {@link RepositoriesService.assertSessionVisible} keyed by the public `sessions.session_id`
   * string the per-session routes receive, rather than by the internal `sessions.id`.
   *
   * A session id that matches no row is left to the route's own answer (404, an empty
   * list, or a `computed: false` aggregate) — there is nothing to hide yet, and turning
   * "unknown session" into 403 would leak the existence boundary in the other direction.
   */
  private async assertSessionVisibleBySessionId(
    user: AuthUser,
    scope: TeamScope,
    teamId: number | undefined,
    sessionId: string,
  ): Promise<void> {
    // Personal view: `assertRepoAccess` is the whole gate — it admits only the
    // `repositories` row owner (no app-role bypass), so no further narrowing applies.
    if (teamId === undefined || scope.visibleUserIds === null) {
      return;
    }

    const [row] = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.sessionId, sessionId));

    if (!row) {
      return;
    }

    await this.repositoriesService.assertSessionVisible(user, scope, row.id);
  }

  @Post(':repoId/sessions/:sessionId/favorite')
  async setSessionFavorite(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('sessionId') sessionId: string,
    @Body() body: SetSessionFavoriteDto,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<{ isFavorite: boolean }> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoAccess(user, repoId, teamId);

    return this.repositoriesService.setSessionFavorite(
      user.id,
      repoId,
      sessionId,
      body.favorite,
    );
  }

  @Get(':repoId/summary')
  async getRepositorySummary(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );

    // Team view counts every team member's repository row of this URL — the same rows the
    // team's session list reads — so the header does not depend on whose row was opened.
    // Deliberately not access-mode scoped: these are whole-repository counts. Personal view
    // keeps counting `repoId` alone.
    const repoIds = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      teamId,
    );

    const [result] = await this.db
      .select({
        sessionCount: countDistinct(schema.sessions.sessionId),
        userCount: countDistinct(schema.logs.userId),
      })
      .from(schema.sessions)
      .innerJoin(schema.logs, eq(schema.logs.sessionId, schema.sessions.id))
      .innerJoin(
        schema.logRepositories,
        eq(schema.logRepositories.logId, schema.logs.id),
      )
      .where(
        and(
          inArray(schema.logRepositories.repoId, repoIds),
          eq(schema.logs.logType, 'artisyn'),
        ),
      );

    return { sessionCount: result.sessionCount, userCount: result.userCount };
  }

  @Get(':repoId/sessions/:sessionId/logs')
  async getSessionLogs(
    @Req() req: Request,
    @Res() res: Response,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('sessionId') sessionId: string,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIds = await this.repositoriesService.resolveRepoIds(
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
    const [sessionCheck] = await this.db
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
    const [sessionOwnerRow] = await this.db
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
        (await this.repositoriesService.isTeamOwner(user.id, teamId));

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
      const scope = await this.repositoriesService.resolveTeamScope(
        user,
        teamId,
      );

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

    // DD-12: the harness snapshot, keyed by the artisyn log owner (not the caller) —
    // same access checks as the rest of this route, computed only once they pass.
    const harnessSnapshot =
      sessionCheck.harnessSnapshotId && sessionOwnerRow?.userId
        ? await loadHarnessSnapshot(
            this.db,
            sessionOwnerRow.userId,
            sessionCheck.harnessSnapshotId,
          )
        : null;

    // Step 2: fetch the artisyn and claude log bodies for this session.
    // The artisyn log carries metadata events (skill-definitions, mcp-config, etc.)
    // that are absent from the raw claude log; prepend them so the client parser
    // has the full context in a single stream.
    const logs = await this.db
      .select({
        logType: schema.logs.logType,
        bodyText: sql<string>`${schema.logs.body}::text`,
      })
      .from(schema.logs)
      .where(
        and(
          eq(schema.logs.sessionId, sessionCheck.sessionRowId),
          inArray(schema.logs.logType, ['artisyn', 'claude']),
        ),
      );

    const artisynLog = logs.find((l) => l.logType === 'artisyn');
    const claudeLog = logs.find((l) => l.logType === 'claude');

    if (!claudeLog) throw new NotFoundException('Session logs not found');
    if (claudeLog.bodyText === null)
      throw new UnprocessableEntityException('Log body is null');

    // Merge artisyn events (metadata) before claude events without double-parsing.
    // Both bodies are JSON arrays: "[e1,e2,...]"; concatenate by stripping the
    // closing "]" from artisyn and the opening "[" from claude.
    let mainText = claudeLog.bodyText.trim();
    if (artisynLog?.bodyText) {
      const a = artisynLog.bodyText.trim();
      const c = mainText;
      if (a === '[]') {
        // nothing to prepend
      } else if (c === '[]') {
        mainText = a;
      } else {
        mainText = a.slice(0, -1) + ',' + c.slice(1);
      }
    }

    // Step 3: fetch sub-agent sessions (any nesting depth) — their logs and
    // session_stats for cost attribution. `parent_session_id` may now point at an
    // intermediate agent rather than always this root session, so we must walk the
    // full descendant tree instead of a one-level equality match.
    const descendantsMap = await getDescendantSessionIds(this.db, [
      sessionCheck.sessionRowId,
    ]);
    const descendantIds = descendantsMap.get(sessionCheck.sessionRowId) ?? [];

    const [subagentRows, subagentStatsRows, rootStatsRows] = await Promise.all([
      this.db
        .select({
          subSessionId: schema.sessions.sessionId,
          parentSessionId: schema.sessions.parentSessionId,
          workflowRunId: schema.sessions.workflowRunId,
          bodyText: sql<string | null>`${schema.logs.body}::text`,
        })
        .from(schema.sessions)
        .leftJoin(
          schema.logs,
          and(
            eq(schema.logs.sessionId, schema.sessions.id),
            eq(schema.logs.logType, 'claude-subagent'),
          ),
        )
        .where(inArray(schema.sessions.id, descendantIds))
        .orderBy(asc(schema.sessions.sessionId)),
      this.db
        .select({
          sessionId: schema.sessions.sessionId,
          model: schema.sessionStats.model,
          inputTokens: schema.sessionStats.inputTokens,
          outputTokens: schema.sessionStats.outputTokens,
          cacheReadTokens: schema.sessionStats.cacheReadTokens,
          cacheWriteTokens: schema.sessionStats.cacheWriteTokens,
          // Without these the client's Workflow-agent fallback fold
          // (log-parser.ts) can only fill the new TokenBreakdown fields with 0, which
          // would under-price every web search and every fast-mode token an agent spent.
          webSearchRequests: schema.sessionStats.webSearchRequests,
          inputTokensFast: schema.sessionStats.inputTokensFast,
          outputTokensFast: schema.sessionStats.outputTokensFast,
          // The productivity counters, so the client can compute a tree-scoped
          // code-impact figure from the same `session_stats` rows the server-side
          // rollup (`session-tree-metrics.sql.ts`) sums — the Info/Summary tabs and the
          // analytics pages therefore cannot disagree. Additive: no existing field
          // changes meaning.
          linesChanged: schema.sessionStats.linesChanged,
          filesEditedWritten: schema.sessionStats.filesEditedWritten,
          linesAdded: schema.sessionStats.linesAdded,
          linesRemoved: schema.sessionStats.linesRemoved,
          diffLinesCoveredCalls: schema.sessionStats.diffLinesCoveredCalls,
          diffLinesTotalCalls: schema.sessionStats.diffLinesTotalCalls,
        })
        .from(schema.sessions)
        .innerJoin(
          schema.sessionStats,
          eq(schema.sessionStats.sessionId, schema.sessions.id),
        )
        .where(
          and(
            inArray(schema.sessions.id, descendantIds),
            // Guard, same predicate as the server-side tree rollup: a descendant
            // whose `session_stats` row exists only because OTEL cost telemetry arrived
            // (no transcript ever uploaded) contributes nothing. Without it the client
            // would sum a node the server rollup skips, and the two figures would drift.
            sql`EXISTS (
              SELECT 1 FROM logs tl
              WHERE tl.session_id = ${schema.sessions.id}
                AND tl.log_type IN ('claude', 'claude-subagent')
            )`,
          ),
        ),
      // The root session's own productivity counters (`rootStats`), read from the
      // same `session_stats` row the server-side tree rollup sums for the root node,
      // with the same transcript guard as the descendant select above.
      this.db
        .select({
          linesChanged: schema.sessionStats.linesChanged,
          filesEditedWritten: schema.sessionStats.filesEditedWritten,
          linesAdded: schema.sessionStats.linesAdded,
          linesRemoved: schema.sessionStats.linesRemoved,
          diffLinesCoveredCalls: schema.sessionStats.diffLinesCoveredCalls,
          diffLinesTotalCalls: schema.sessionStats.diffLinesTotalCalls,
        })
        .from(schema.sessionStats)
        .where(
          and(
            eq(schema.sessionStats.sessionId, sessionCheck.sessionRowId),
            sql`EXISTS (
              SELECT 1 FROM logs tl
              WHERE tl.session_id = ${schema.sessionStats.sessionId}
                AND tl.log_type IN ('claude', 'claude-subagent')
            )`,
          ),
        )
        .limit(1),
    ]);

    const subagents = subagentRows
      .filter((r) => r.bodyText !== null)
      .map((r) => ({
        sessionId: r.subSessionId,
        parentSessionId: r.parentSessionId,
        logsText: r.bodyText!,
      }));

    // Extract workflow runs from the claude log events
    let workflows: ReturnType<typeof extractWorkflows> = [];
    try {
      const claudeEvents = JSON.parse(claudeLog.bodyText) as unknown[];
      workflows = extractWorkflows(claudeEvents);
    } catch {
      // malformed body — return empty workflows
    }

    // Resolve each WorkflowRun's full multi-level agent linkage:
    // a workflow's direct agents (sessions whose `workflow_run_id`
    // matches the run's `wfId`) plus their own regular Task-tool sub-agents at any
    // depth — but NOT a sub-agent's own nested `Workflow` tool call (out of scope).
    // Both maps are built only from `subagentRows`, which is already scoped to
    // `descendantIds`, so the BFS below is implicitly restricted to this session's
    // own descendant tree — no cross-session leakage possible.
    if (workflows.length > 0) {
      const wfDirectAgentsMap = new Map<string, string[]>();
      const childrenByParentMap = new Map<string, string[]>();
      for (const r of subagentRows) {
        // Guard against the workflow runtime's own `journal.jsonl` bookkeeping file —
        // historically uploaded (pre-hook-fix) with the literal, unprefixed sessionId
        // "journal" — being mistaken for a real spawned agent.
        if (!r.subSessionId.startsWith('agent-')) continue;
        if (r.workflowRunId) {
          const directList = wfDirectAgentsMap.get(r.workflowRunId);
          if (directList) directList.push(r.subSessionId);
          else wfDirectAgentsMap.set(r.workflowRunId, [r.subSessionId]);
        }
        if (r.parentSessionId) {
          const childList = childrenByParentMap.get(r.parentSessionId);
          if (childList) childList.push(r.subSessionId);
          else childrenByParentMap.set(r.parentSessionId, [r.subSessionId]);
        }
      }

      for (const wf of workflows) {
        if (!wf.wfId) continue; // running workflow — no linkage yet
        const directAgentIds = wfDirectAgentsMap.get(wf.wfId);
        if (!directAgentIds || directAgentIds.length === 0) continue;

        const visited = new Set<string>();
        const queue = [...directAgentIds];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (visited.has(current)) continue;
          visited.add(current);
          const children = childrenByParentMap.get(current);
          if (children) queue.push(...children);
        }
        wf.agentSessionIds = [...visited];
      }
    }

    // Latest submitted Turn-End Cost Advisor result for the session
    // detail Advisor tab (no separate session-detail cost/advisor
    // endpoint). `turn_end_advisor_runs` doubles as display persistence — the latest
    // `outcome='submitted'` row by `started_at` is what the pane shows;
    // `null` when the session has never had a successful evaluation.
    // Only runs recorded by the session owner count (open-source readiness):
    // the filter compares against the session owner, not the viewer, so
    // team visibility is unchanged, and a NULL `user_id` never matches.
    const advisorOwnerId = sessionOwnerRow?.userId;
    const [turnEndAdvisorRow] =
      advisorOwnerId === undefined
        ? []
        : await this.db
            .select({
              startedAt: schema.turnEndAdvisorRuns.startedAt,
              summaryGeneral: schema.turnEndAdvisorRuns.summaryGeneral,
              costFactors: schema.turnEndAdvisorRuns.costFactors,
              harnessAdvice: schema.turnEndAdvisorRuns.harnessAdvice,
              model: schema.turnEndAdvisorRuns.model,
              costUsd: schema.turnEndAdvisorRuns.costUsd,
              inputTokens: schema.turnEndAdvisorRuns.inputTokens,
              outputTokens: schema.turnEndAdvisorRuns.outputTokens,
              cacheReadTokens: schema.turnEndAdvisorRuns.cacheReadTokens,
              cacheWriteTokens: schema.turnEndAdvisorRuns.cacheWriteTokens,
            })
            .from(schema.turnEndAdvisorRuns)
            .where(
              and(
                eq(schema.turnEndAdvisorRuns.sessionId, sessionId),
                eq(schema.turnEndAdvisorRuns.userId, advisorOwnerId),
                eq(schema.turnEndAdvisorRuns.outcome, 'submitted'),
              ),
            )
            .orderBy(desc(schema.turnEndAdvisorRuns.startedAt))
            .limit(1);
    const turnEndAdvisor = turnEndAdvisorRow
      ? {
          generatedAt: turnEndAdvisorRow.startedAt.toISOString(),
          summaryGeneral: turnEndAdvisorRow.summaryGeneral,
          costFactors: turnEndAdvisorRow.costFactors ?? [],
          harnessAdvice: turnEndAdvisorRow.harnessAdvice ?? [],
          model: turnEndAdvisorRow.model,
          costUsd:
            turnEndAdvisorRow.costUsd === null
              ? null
              : Number(turnEndAdvisorRow.costUsd),
          inputTokens: turnEndAdvisorRow.inputTokens,
          outputTokens: turnEndAdvisorRow.outputTokens,
          cacheReadTokens: turnEndAdvisorRow.cacheReadTokens,
          cacheWriteTokens: turnEndAdvisorRow.cacheWriteTokens,
        }
      : null;

    // Everything the session detail state derivation (feature off
    // -> failed -> unevaluated -> stale -> evaluated, in that priority order) needs, computed
    // without any extra client-side fetch: the resolved definitions (so chips can render even
    // before any evaluation), the current orphan-stripped values plus
    // the watermark they were evaluated at, the latest known prompt watermark (used to detect
    // "stale" — evaluated but a newer turn has since happened), and the most recent run's
    // outcome/failure reason (used to detect "failed").
    const attributionDefinitions =
      await this.sessionAttributionService.resolveDefinitions(
        user.id,
        repo.repoUrl,
        teamId,
      );
    const [attributionRow] = await this.db
      .select({
        values: schema.sessionAttribution.values,
        promptWatermark: schema.sessionAttribution.promptWatermark,
        updatedAt: schema.sessionAttribution.updatedAt,
      })
      .from(schema.sessionAttribution)
      .where(
        eq(schema.sessionAttribution.sessionId, sessionCheck.sessionRowId),
      );
    const [currentWatermarkRow] = await this.db
      .select({
        promptWatermark: schema.sessionPromptWatermark.promptWatermark,
      })
      .from(schema.sessionPromptWatermark)
      .where(
        eq(schema.sessionPromptWatermark.sessionId, sessionCheck.sessionRowId),
      );
    const [lastAttributionRunRow] = await this.db
      .select({
        outcome: schema.sessionAttributionRuns.outcome,
        finishedAt: schema.sessionAttributionRuns.finishedAt,
        failureReason: schema.sessionAttributionRuns.failureReason,
      })
      .from(schema.sessionAttributionRuns)
      .where(
        eq(schema.sessionAttributionRuns.sessionId, sessionCheck.sessionRowId),
      )
      .orderBy(desc(schema.sessionAttributionRuns.startedAt))
      .limit(1);

    const attributionValues: Record<
      string,
      string | string[] | boolean | number | null
    > | null = attributionRow
      ? Object.fromEntries(
          Object.entries(attributionRow.values).filter(
            ([key, value]) =>
              !isOrphanedValue(key, value, attributionDefinitions.attributes),
          ),
        )
      : null;

    const sessionAttribution = {
      enabled: attributionDefinitions.enabled,
      attributes: attributionDefinitions.attributes,
      values: attributionValues,
      evaluatedWatermark: attributionRow?.promptWatermark ?? null,
      currentWatermark: currentWatermarkRow?.promptWatermark ?? null,
      lastRun: lastAttributionRunRow
        ? {
            outcome: lastAttributionRunRow.outcome,
            finishedAt: lastAttributionRunRow.finishedAt.toISOString(),
            failureReason: lastAttributionRunRow.failureReason ?? null,
          }
        : null,
    };

    // Build JSON response without double-parsing large blobs.
    // `parentSessionId` is the true immediate parent session/agent — a sub-agent
    // spawned in the background by another sub-agent (not the root) may never write a
    // completion event with its own agentId back into its parent's transcript once the parent
    // session ends, so this DB-authoritative value is the only reliable way for the client to
    // reconstruct the real nesting tree for cost rollup; it must not be derived from transcript
    // content (agent_progress / tool_use+toolUseResult), which is unreliable for grandchildren+.
    res.setHeader('Content-Type', 'application/json');
    const subagentJson = subagents
      .map(
        (s) =>
          `{"sessionId":${JSON.stringify(s.sessionId)},"parentSessionId":${JSON.stringify(s.parentSessionId)},"logs":${s.logsText}}`,
      )
      .join(',');
    // `rootStats` (the root session's own counters, `null` when it has no
    // `session_stats` row or the OTEL-only-row guard excludes it) plus the `subagentStats`
    // entries of all descendants equals the tree rollup computed server-side by
    // `session-tree-metrics.sql.ts` — both selects use the same rows and the same
    // transcript guard, so the client's tree-scoped code-impact figure cannot
    // drift from the analytics pages.
    const subagentStatsJson = JSON.stringify(
      Object.fromEntries(
        subagentStatsRows.map((r) => [
          r.sessionId,
          {
            model: r.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheWriteTokens: r.cacheWriteTokens,
            webSearchRequests: r.webSearchRequests,
            inputTokensFast: r.inputTokensFast,
            outputTokensFast: r.outputTokensFast,
            // Productivity counters (see the select above).
            linesChanged: r.linesChanged,
            filesEditedWritten: r.filesEditedWritten,
            linesAdded: r.linesAdded,
            linesRemoved: r.linesRemoved,
            diffLinesCoveredCalls: r.diffLinesCoveredCalls,
            diffLinesTotalCalls: r.diffLinesTotalCalls,
          },
        ]),
      ),
    );
    const rootStatsRow = rootStatsRows[0];
    const rootStatsJson = JSON.stringify(
      rootStatsRow
        ? {
            linesChanged: rootStatsRow.linesChanged,
            filesEditedWritten: rootStatsRow.filesEditedWritten,
            linesAdded: rootStatsRow.linesAdded,
            linesRemoved: rootStatsRow.linesRemoved,
            diffLinesCoveredCalls: rootStatsRow.diffLinesCoveredCalls,
            diffLinesTotalCalls: rootStatsRow.diffLinesTotalCalls,
          }
        : null,
    );
    res.end(
      `{"main":${mainText},"subagents":[${subagentJson}],"subagentStats":${subagentStatsJson},"rootStats":${rootStatsJson},"workflows":${JSON.stringify(workflows)},"turnEndAdvisor":${JSON.stringify(turnEndAdvisor)},"sessionAttribution":${JSON.stringify(sessionAttribution)},"harnessSnapshot":${JSON.stringify(harnessSnapshot ?? null)}}`,
    );
  }

  // Lists sessions in scope for the "Session Statistics Export" feature.
  // Gated by isTeamOwner in team view, or assertRepoAccess's personal-owner
  // check in personal view — deliberately more restrictive than the plain
  // getRepositorySessions listing, since the result set it returns bypasses the
  // per-team allowMemberSessionVisibility restriction.
  @Get(':repoId/sessions/export-scope')
  async getSessionsExportScope(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId', new ParseIntPipe({ optional: true })) userId?: number,
  ) {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
    if (!from) {
      throw new BadRequestException('from is required');
    }
    if (!to) {
      throw new BadRequestException('to is required');
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime())) {
      throw new BadRequestException('from must be a valid ISO 8601 date');
    }
    if (isNaN(toDate.getTime())) {
      throw new BadRequestException('to must be a valid ISO 8601 date');
    }

    const user = req.user as AuthUser;
    // Personal view: throws unless the caller owns repoId.
    // Team view: only verifies team membership — the stronger team-owner
    // check below is what actually gates this privileged, visibility-bypassing route.
    await this.repositoriesService.assertRepoAccess(user, repoId, teamId);

    if (
      teamId !== undefined &&
      !(await this.repositoriesService.isTeamOwner(user.id, teamId))
    ) {
      throw new ForbiddenException();
    }

    return this.repositoriesService.getSessionsForExport(repoId, teamId, {
      from: fromDate,
      to: toDate,
      userId,
    });
  }

  // Recomputes session_file_stats (scoped, via recomputeForRepo) and session_stats
  // (unscoped, via recomputeAllSessionStats) for every session in this repo.
  // Gated by isTeamOwner in team view, or assertRepoAccess's personal-owner
  // check in personal view — same authorization shape as the export-scope endpoint above.
  @Post(':repoId/recompute-all-sessions')
  async recomputeAllSessions(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    const user = req.user as AuthUser;
    // Personal view: throws unless the caller owns repoId.
    // Team view: only verifies team membership — the stronger team-owner
    // check below is what actually gates this privileged, repo-wide maintenance route.
    await this.repositoriesService.assertRepoAccess(user, repoId, teamId);

    if (
      teamId !== undefined &&
      !(await this.repositoriesService.isTeamOwner(user.id, teamId))
    ) {
      throw new ForbiddenException();
    }

    await this.repositoriesService.recomputeForRepo(
      repoId,
      teamId !== undefined ? { teamId } : { userId: user.id },
    );

    return this.repositoriesService.recomputeAllSessionStats(repoId);
  }

  @Get(':repoId/analytics/timeline')
  async getAnalyticsTimeline(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDateParam?: string,
    @Query('endDate') endDateParam?: string,
    @Query('groupBy') groupBy?: string,
    @Query('branches') branchesParam?: string,
    @Query('users') usersParam?: string,
    @Query('attr') attrParam?: string | string[],
  ): Promise<TimelineSession[]> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    if (!startDateParam) {
      throw new BadRequestException('startDate is required');
    }
    if (!endDateParam) {
      throw new BadRequestException('endDate is required');
    }

    let startDate = new Date(startDateParam);
    let endDate = new Date(endDateParam);

    if (isNaN(startDate.getTime())) {
      throw new BadRequestException('startDate must be a valid ISO 8601 date');
    }
    if (isNaN(endDate.getTime())) {
      throw new BadRequestException('endDate must be a valid ISO 8601 date');
    }

    // When same calendar day, normalize to cover the full day in UTC
    if (startDateParam === endDateParam) {
      startDate = new Date(
        Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      );
      endDate = new Date(
        Date.UTC(
          endDate.getUTCFullYear(),
          endDate.getUTCMonth(),
          endDate.getUTCDate(),
          23,
          59,
          59,
          0,
        ),
      );
    }

    // `groupBy=attr:<key>` accepted alongside the
    // fixed 'branch'/'user' values — the key itself is validated below, once this repo's
    // resolved attribute definitions are known.
    const groupByAttrKey = parseGroupByAttrKey(groupBy);
    if (
      groupBy !== undefined &&
      groupBy !== 'branch' &&
      groupBy !== 'user' &&
      groupByAttrKey === undefined
    ) {
      throw new BadRequestException(
        "groupBy must be 'branch', 'user', or 'attr:<key>'",
      );
    }

    const branches =
      branchesParam !== undefined && branchesParam !== ''
        ? branchesParam.split(',').map((b) => decodeURIComponent(b))
        : [];

    const users =
      usersParam !== undefined && usersParam !== ''
        ? usersParam.split(',').map((u) => decodeURIComponent(u))
        : [];

    if (groupBy === 'branch' && branches.length > 0) {
      throw new BadRequestException(
        'Cannot combine groupBy=branch with a branches filter',
      );
    }
    if (groupBy === 'user' && users.length > 0) {
      throw new BadRequestException(
        'Cannot combine groupBy=user with a users filter',
      );
    }

    const user = req.user as AuthUser;
    const repoTimeline = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIdsTimeline = await this.repositoriesService.resolveRepoIds(
      repoId,
      repoTimeline.repoUrl,
      teamId,
    );
    const repoTimelineCondition =
      repoIdsTimeline.length === 1
        ? eq(schema.repositories.id, repoIdsTimeline[0])
        : inArray(schema.repositories.id, repoIdsTimeline);

    // Repeatable `attr=<key>:<op>:<value>`
    // filters, validated against this repo's resolved attribute definitions — the same
    // definitions `groupByAttrKey`'s 400 check and the group-label fan-out
    // below both need.
    const attributeFilters = parseAttributeFilters(
      normalizeRepeatableParam(attrParam),
    );
    const resolvedDefinitions = await this.sessionAttributionService
      .resolveDefinitions(user.id, repoTimeline.repoUrl, teamId)
      .then((d) => d.attributes);
    if (attributeFilters.length > 0) {
      validateAttributeFilterTypes(
        attributeFilters,
        buildAttributeTypeLookup(resolvedDefinitions),
      );
    }
    assertKnownGroupByAttrKey(groupByAttrKey, resolvedDefinitions);
    assertNoGroupByAttrFilterConflict(groupByAttrKey, attributeFilters);

    const groupCol =
      groupBy === 'branch'
        ? sql<string | null>`COALESCE(${schema.logs.gitBranch}, 'no branch')`
        : groupBy === 'user'
          ? sql<string | null>`${schema.users.email}`
          : sql<string | null>`NULL`;
    // Only fetched when actually grouping by attribute — the fixed branch/user groupings
    // never touch `session_attribution`.
    const attrGroupCol =
      groupByAttrKey !== undefined
        ? sql<Record<
            string,
            string | string[] | boolean | number | null
          > | null>`(SELECT sa.values FROM session_attribution sa WHERE sa.session_id = ${schema.sessions.id})`
        : sql<Record<
            string,
            string | string[] | boolean | number | null
          > | null>`NULL`;

    const conditions = [
      eq(schema.logs.logType, 'artisyn'),
      isNotNull(schema.logs.startTime),
      isNotNull(schema.logs.endTime),
      isNotNull(schema.logs.firstPrompt),
      repoTimelineCondition,
      eq(schema.sessions.deleted, false),
      gte(schema.logs.startTime, startDate),
      lte(schema.logs.startTime, endDate),
    ];

    // Team access mode. The 403 is the same gate the four
    // `analytics/*` routes on `UsageAnalyticsController` and every `reports/*` route apply:
    // in a `restricted` team only the team owner and a `manager` may read analytics.
    const timelineScope = await this.repositoriesService.resolveTeamScope(
      user,
      teamId,
    );
    if (teamId !== undefined && !timelineScope.analyticsAllowed) {
      throw new ForbiddenException();
    }

    if (teamId === undefined) {
      conditions.push(eq(schema.logs.userId, user.id));
    } else if (timelineScope.visibleUserIds === null) {
      // `transparent` team — every current member, the exact predicate this route ran
      // before access modes existed.
      const memberSubquery = this.db
        .select({ userId: schema.teamMembers.userId })
        .from(schema.teamMembers)
        .where(eq(schema.teamMembers.teamId, teamId));
      conditions.push(inArray(schema.users.id, memberSubquery));
    } else {
      // `restricted` — the acknowledged members an owner/manager may read, or
      // just the caller's own id for anyone else.
      conditions.push(
        inArray(schema.logs.userId, timelineScope.visibleUserIds),
      );
    }

    if (branches.length > 0) {
      conditions.push(
        inArray(sql`COALESCE(${schema.logs.gitBranch}, 'no branch')`, branches),
      );
    }

    if (users.length > 0) {
      conditions.push(inArray(schema.users.email, users));
    }

    const attrCondition = attributeFilterSql(
      attributeFilters,
      sql`${schema.sessions.id}`,
    );
    if (attrCondition) conditions.push(attrCondition);

    const rows = await this.db
      .select({
        sessionId: schema.sessions.sessionId,
        sessionRowId: schema.sessions.id,
        startTime: schema.logs.startTime,
        endTime: schema.logs.endTime,
        firstPrompt: schema.logs.firstPrompt,
        gitBranch: schema.logs.gitBranch,
        userEmail: schema.users.email,
        // `maskFirstPrompt` compares ids, and the row otherwise
        // carries only the display e-mail.
        rowUserId: schema.logs.userId,
        group: groupCol,
        attrValues: attrGroupCol,
      })
      .from(schema.sessions)
      .innerJoin(schema.logs, eq(schema.logs.sessionId, schema.sessions.id))
      .innerJoin(
        schema.logRepositories,
        eq(schema.logRepositories.logId, schema.logs.id),
      )
      .innerJoin(
        schema.repositories,
        eq(schema.repositories.id, schema.logRepositories.repoId),
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.logs.userId))
      .where(and(...conditions))
      .orderBy(asc(schema.logs.startTime));

    // Compute work time and cost per session from claude log bodies
    const statsMap = new Map<
      number,
      {
        workTimeMs: number;
        totalCost: number | null;
        filesEditedWritten: number;
        linesChanged: number;
        filesEditedWrittenOwn: number;
        linesChangedOwn: number;
        imageCount: number;
        imageTotalBytes: number;
        mcpCallsTotal: number;
        mcpCallsByServer: Record<string, number>;
        fileStatsByCategory: Record<string, { files: number; bytes: number }>;
        logLineCount: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        webSearchRequests: number;
        inputTokensFast: number;
        outputTokensFast: number;
        descendantCacheReadTokens: number;
        descendantCacheWriteTokens: number;
        costUnavailableReason: 'unknown-model' | null;
        unpricedModels: string[];
      }
    >();

    if (rows.length > 0) {
      const sessionRowIds = rows.map((r) => r.sessionRowId);
      // Pass IDs as a single PostgreSQL array literal string ($1::bigint[]).
      const idsLiteral = `{${sessionRowIds.join(',')}}`;
      const idsArray = sql`${idsLiteral}::bigint[]`;

      type StatsRow = TreeCostSqlRow & {
        session_row_id: string;
        work_time_ms: string | null;
        // Tree-scoped (root + all descendants); the `*_own` pair is root-only.
        files_edited_written: string;
        lines_changed: string;
        files_edited_written_own: string;
        lines_changed_own: string;
        image_count: string;
        image_total_bytes: string;
        mcp_calls_total: string;
        mcp_calls_by_server: Record<string, number> | null;
        log_line_count: string;
        cache_read_tokens: string | null;
        cache_write_tokens: string | null;
        web_search_requests: string | null;
        input_tokens_fast: string | null;
        output_tokens_fast: string | null;
        descendant_cache_read_tokens: string | null;
        descendant_cache_write_tokens: string | null;
        model: string | null;
      };

      type FileStatsRow = {
        session_id: string;
        category_name: string;
        file_count: string;
        byte_count: string;
      };

      const statsResult = await this.db.execute(sql`
        WITH RECURSIVE ${descendantSessionsCte(idsArray)},
        -- The shared tree rollup of session_stats over root + every
        -- descendant. Joined below on root_id; see session-tree-metrics.sql.ts for the
        -- double-count trap (the rollup already contains the root).
        ${treeMetricsCte()},
        artisyn_events AS (
          SELECT
            al.session_id,
            (evt->>'event') AS event_type,
            (evt->>'timestamp')::timestamptz AS event_ts,
            LEAD((evt->>'timestamp')::timestamptz)
              OVER (PARTITION BY al.session_id ORDER BY (evt->>'timestamp')::timestamptz) AS next_ts
          FROM logs al
          CROSS JOIN LATERAL jsonb_array_elements(al.body) AS evt
          WHERE al.log_type = 'artisyn'
            AND al.session_id = ANY(${idsArray})
            AND (evt->>'event') IN ('prompt_start', 'prompt_stop')
            AND (evt->>'timestamp') IS NOT NULL
        ),
        work_time_cte AS (
          SELECT
            session_id,
            SUM(EXTRACT(EPOCH FROM (next_ts - event_ts)) * 1000) AS work_time_ms
          FROM artisyn_events
          WHERE event_type = 'prompt_start'
            AND next_ts IS NOT NULL
          GROUP BY session_id
        ),
        session_events AS (
          SELECT
            cl.session_id AS session_row_id,
            -- First assistant event's model, in log order — matches extractClaudeStats()'s
            -- "first non-null model wins" logic (claude-extractor.ts). MIN() would pick the
            -- alphabetically-smallest model string instead, which is wrong whenever a session
            -- used more than one model. This is only a fallback here (session_stats.model wins
            -- via COALESCE below when present), but keep it consistent with the primary path.
            (ARRAY_AGG(evt->'message'->>'model' ORDER BY ord) FILTER (
              WHERE (evt->>'type') = 'assistant' AND (evt->'message'->>'model') IS NOT NULL
            ))[1] AS model,
            SUM(CASE WHEN (evt->>'type') = 'assistant'
                     THEN COALESCE((evt->'message'->'usage'->>'input_tokens')::bigint, 0) ELSE 0 END) AS input_tokens,
            SUM(CASE WHEN (evt->>'type') = 'assistant'
                     THEN COALESCE((evt->'message'->'usage'->>'output_tokens')::bigint, 0) ELSE 0 END) AS output_tokens,
            SUM(CASE WHEN (evt->>'type') = 'assistant'
                     THEN COALESCE((evt->'message'->'usage'->>'cache_read_input_tokens')::bigint, 0) ELSE 0 END) AS cache_read_tokens,
            SUM(CASE WHEN (evt->>'type') = 'assistant'
                     THEN COALESCE((evt->'message'->'usage'->>'cache_creation_input_tokens')::bigint, 0) ELSE 0 END) AS cache_write_tokens,
            -- The TTL-split cache writes, web-search requests and fast-mode token
            -- subsets surfaced in the response, under the same type = 'assistant' guard the
            -- sums above use (this CTE aggregates every line type in one pass).
            ${jsonbUsageCostColumnsSql(
              (value) =>
                sql`CASE WHEN (evt->>'type') = 'assistant' THEN ${value} ELSE 0 END`,
            )}
          FROM logs cl
          CROSS JOIN LATERAL jsonb_array_elements(cl.body) WITH ORDINALITY AS t(evt, ord)
          WHERE cl.log_type = 'claude'
            AND cl.session_id = ANY(${idsArray})
          GROUP BY cl.session_id
        ),
        -- Stored sub-agent costs (session_costs, priced at the root's price date).
        -- The complete computed tree cost (own + sub-agents + utility calls).
        ${treeCostCtes(idsArray)},
        -- Cache tokens of all recursive descendants (depth > 0) per root.
        subagent_cache AS (
          SELECT
            ds.root_id AS session_row_id,
            COALESCE(SUM(ss.cache_read_tokens), 0) AS descendant_cache_read_tokens,
            COALESCE(SUM(ss.cache_write_tokens), 0) AS descendant_cache_write_tokens
          FROM descendant_sessions ds
          JOIN session_stats ss ON ss.session_id = ds.id
          WHERE ds.depth > 0
          GROUP BY ds.root_id
        ),
        tool_uses_raw AS (
          SELECT
            cl.session_id AS session_row_id,
            tu->>'name' AS tool_name,
            tu->'input'->>'new_string' AS edit_string,
            tu->'input'->>'content' AS write_content,
            -- MultiEdit carries an input.edits array instead of a
            -- single input.new_string, so it used to contribute 0 lines and 0 files here
            -- while session_stats counted it — the same transcript reported two different
            -- numbers depending on which path served it.
            -- (No backticks in this comment: it lives inside a sql template literal.)
            (SELECT COALESCE(SUM(COALESCE(array_length(string_to_array(e->>'new_string', E'\n'), 1), 0)), 0)
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(tu->'input'->'edits') = 'array'
                      THEN tu->'input'->'edits' ELSE '[]'::jsonb END) e) AS multiedit_lines
          FROM logs cl
          CROSS JOIN LATERAL jsonb_array_elements(cl.body) AS evt
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(evt->'message'->'content') = 'array'
                 THEN evt->'message'->'content'
                 ELSE '[]'::jsonb END
          ) AS tu
          WHERE cl.log_type = 'claude'
            AND cl.session_id = ANY(${idsArray})
            AND evt->>'type' = 'assistant'
            AND tu->>'type' = 'tool_use'
            AND tu->>'name' IN (${textList([...EDIT_WRITE_TOOL_NAMES])})
        ),
        file_stats_cte AS (
          SELECT
            tur.session_row_id,
            COUNT(CASE WHEN tur.tool_name IN (${textList([...EDIT_WRITE_TOOL_NAMES])}) THEN 1 END) AS files_edited_written,
            SUM(CASE WHEN tur.tool_name = 'Edit'
                     THEN COALESCE(array_length(string_to_array(tur.edit_string, E'\n'), 1), 0)
                     WHEN tur.tool_name = 'Write'
                     THEN COALESCE(array_length(string_to_array(tur.write_content, E'\n'), 1), 0)
                     WHEN tur.tool_name = 'MultiEdit'
                     THEN tur.multiedit_lines
                     ELSE 0 END) AS lines_changed
          FROM tool_uses_raw tur
          GROUP BY tur.session_row_id
        ),
        vision_stats_cte AS (
          SELECT
            cl.session_id AS session_row_id,
            COUNT(*) AS image_count,
            COALESCE(SUM(
              CASE WHEN img->'source'->>'data' IS NOT NULL
                   THEN length(img->'source'->>'data') * 3 / 4
                   ELSE 0 END
            ), 0) AS image_total_bytes
          FROM logs cl
          CROSS JOIN LATERAL jsonb_array_elements(cl.body) AS evt
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(evt->'message'->'content') = 'array'
                 THEN evt->'message'->'content'
                 ELSE '[]'::jsonb END
          ) AS tr
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(tr->'content') = 'array'
                 THEN tr->'content'
                 ELSE '[]'::jsonb END
          ) AS img
          WHERE cl.log_type = 'claude'
            AND cl.session_id = ANY(${idsArray})
            AND (evt->>'type') = 'user'
            AND (tr->>'type') = 'tool_result'
            AND (img->>'type') = 'image'
            AND (img->'source'->>'type') = 'base64'
          GROUP BY cl.session_id
        ),
        log_lines_cte AS (
          SELECT session_id, jsonb_array_length(body) AS log_line_count
          FROM logs
          WHERE log_type = 'claude'
            AND session_id = ANY(${idsArray})
        )
        SELECT
          se.session_row_id,
          COALESCE(ss.work_time_ms, wt.work_time_ms, 0) AS work_time_ms,
          -- The tree cost parts, resolved in TS by readTreeCost(), so this route, the
          -- session list, the reports and the delete-time audit row all apply one
          -- definition: complete computed cost, or null when any part is unpriced.
          -- (No backticks in this comment: it lives inside a sql template literal.)
          ${TREE_COST_COLUMNS_SQL},
          COALESCE(ss.model, se.model) AS model,
          -- Tree-scoped. The rollup already includes the root, so the root's
          -- own value is added back ONLY when the rollup did not count it (no session_stats
          -- row, or excluded by the OTEL-only-row guard) — otherwise this would double count. The
          -- raw-JSONB file_stats_cte stays the root's own fallback only.
          COALESCE(tm.files_edited_written, 0)
            + CASE WHEN COALESCE(tm.root_counted, false) THEN 0
                   ELSE COALESCE(ss.files_edited_written, fs.files_edited_written, 0) END
            AS files_edited_written,
          COALESCE(tm.lines_changed, 0)
            + CASE WHEN COALESCE(tm.root_counted, false) THEN 0
                   ELSE COALESCE(ss.lines_changed, fs.lines_changed, 0) END
            AS lines_changed,
          COALESCE(ss.files_edited_written, fs.files_edited_written, 0) AS files_edited_written_own,
          COALESCE(ss.lines_changed, fs.lines_changed, 0) AS lines_changed_own,
          COALESCE(ss.image_count, vs.image_count, 0) AS image_count,
          COALESCE(ss.image_total_bytes, vs.image_total_bytes, 0) AS image_total_bytes,
          COALESCE(ss.mcp_calls_total, 0) AS mcp_calls_total,
          COALESCE(ss.mcp_calls_by_server, '{}'::jsonb) AS mcp_calls_by_server,
          COALESCE(ll.log_line_count, 0) AS log_line_count,
          COALESCE(ss.cache_read_tokens, se.cache_read_tokens, 0) AS cache_read_tokens,
          COALESCE(ss.cache_write_tokens, se.cache_write_tokens, 0) AS cache_write_tokens,
          -- The same three figures the stored cost prices, surfaced for the
          -- client so the timeline's own cost math can reproduce the server's number.
          COALESCE(tk.web_search_requests, 0) AS web_search_requests,
          COALESCE(tk.input_tokens_fast, 0) AS input_tokens_fast,
          COALESCE(tk.output_tokens_fast, 0) AS output_tokens_fast,
          COALESCE(sca.descendant_cache_read_tokens, 0) AS descendant_cache_read_tokens,
          COALESCE(sca.descendant_cache_write_tokens, 0) AS descendant_cache_write_tokens
        FROM session_events se
        LEFT JOIN session_stats ss ON ss.session_id = se.session_row_id
        LEFT JOIN session_costs sc ON sc.session_id = se.session_row_id
        -- One alias carrying the session's token counts for the response. Preserves the
        -- original per-column preference: the extracted session_stats value wins, and the raw-JSONB session_events aggregate is
        -- the fallback for a session whose stats row has not been written yet.
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(ss.input_tokens, se.input_tokens)              AS input_tokens,
            COALESCE(ss.output_tokens, se.output_tokens)            AS output_tokens,
            COALESCE(ss.cache_read_tokens, se.cache_read_tokens)    AS cache_read_tokens,
            COALESCE(ss.cache_write_5m_tokens, se.cache_write_5m_tokens) AS cache_write_5m_tokens,
            COALESCE(ss.cache_write_1h_tokens, se.cache_write_1h_tokens) AS cache_write_1h_tokens,
            COALESCE(ss.web_search_requests, se.web_search_requests)     AS web_search_requests,
            COALESCE(ss.input_tokens_fast, se.input_tokens_fast)         AS input_tokens_fast,
            COALESCE(ss.output_tokens_fast, se.output_tokens_fast)       AS output_tokens_fast
        ) tk ON true
        LEFT JOIN ${sql.raw(SESSION_TREE_METRICS_CTE)} tm ON tm.root_id = se.session_row_id
        LEFT JOIN tree_costs tc ON tc.session_row_id = se.session_row_id
        LEFT JOIN subagent_cache sca ON sca.session_row_id = se.session_row_id
        LEFT JOIN work_time_cte wt ON wt.session_id = se.session_row_id
        LEFT JOIN file_stats_cte fs ON fs.session_row_id = se.session_row_id
        LEFT JOIN vision_stats_cte vs ON vs.session_row_id = se.session_row_id
        LEFT JOIN log_lines_cte ll ON ll.session_id = se.session_row_id
      `);

      for (const row of statsResult.rows as unknown as StatsRow[]) {
        const tree = readTreeCost(row, row.model);
        statsMap.set(Number(row.session_row_id), {
          workTimeMs:
            row.work_time_ms != null ? parseFloat(row.work_time_ms) : 0,
          totalCost: tree.total,
          unpricedModels: tree.unpricedModels,
          filesEditedWritten:
            row.files_edited_written != null
              ? parseInt(row.files_edited_written, 10)
              : 0,
          linesChanged:
            row.lines_changed != null ? parseInt(row.lines_changed, 10) : 0,
          filesEditedWrittenOwn:
            row.files_edited_written_own != null
              ? parseInt(row.files_edited_written_own, 10)
              : 0,
          linesChangedOwn:
            row.lines_changed_own != null
              ? parseInt(row.lines_changed_own, 10)
              : 0,
          imageCount:
            row.image_count != null ? parseInt(row.image_count, 10) : 0,
          imageTotalBytes:
            row.image_total_bytes != null
              ? parseInt(row.image_total_bytes, 10)
              : 0,
          mcpCallsTotal:
            row.mcp_calls_total != null ? parseInt(row.mcp_calls_total, 10) : 0,
          mcpCallsByServer: row.mcp_calls_by_server ?? {},
          fileStatsByCategory: {},
          logLineCount:
            row.log_line_count != null ? parseInt(row.log_line_count, 10) : 0,
          cacheReadTokens:
            row.cache_read_tokens != null
              ? parseInt(row.cache_read_tokens, 10)
              : 0,
          cacheWriteTokens:
            row.cache_write_tokens != null
              ? parseInt(row.cache_write_tokens, 10)
              : 0,
          webSearchRequests:
            row.web_search_requests != null
              ? parseInt(row.web_search_requests, 10)
              : 0,
          inputTokensFast:
            row.input_tokens_fast != null
              ? parseInt(row.input_tokens_fast, 10)
              : 0,
          outputTokensFast:
            row.output_tokens_fast != null
              ? parseInt(row.output_tokens_fast, 10)
              : 0,
          descendantCacheReadTokens:
            row.descendant_cache_read_tokens != null
              ? parseInt(row.descendant_cache_read_tokens, 10)
              : 0,
          descendantCacheWriteTokens:
            row.descendant_cache_write_tokens != null
              ? parseInt(row.descendant_cache_write_tokens, 10)
              : 0,
          // 'unknown-model' only when some model of the tree has no price — a
          // session with neither a stats row nor a model in its transcript has nothing to
          // price, so its reason stays null.
          costUnavailableReason: tree.costUnavailableReason,
        });
      }

      // Effective scope for session_file_stats: ingest and recompute write a team row set
      // for every team linking the URL (its team config, else the defaults) and a personal
      // row set per user (personal config, else the defaults). So team view reads the
      // team's rows and personal view the caller's own — never mixed.
      const fileScopeFilter =
        teamId !== undefined
          ? sql`sfs.team_id = ${teamId}`
          : sql`sfs.user_id = ${user.id}`;

      const fileStatsResult = await this.db.execute(sql`
        SELECT sfs.session_id, sfs.category_name, sfs.file_count, sfs.byte_count
        FROM session_file_stats sfs
        WHERE sfs.session_id = ANY(${idsArray})
          AND ${fileScopeFilter}
      `);

      for (const row of fileStatsResult.rows as unknown as FileStatsRow[]) {
        const sessionRowId = Number(row.session_id);
        const entry = statsMap.get(sessionRowId);
        if (entry) {
          entry.fileStatsByCategory[row.category_name] = {
            files: parseInt(row.file_count, 10),
            bytes: parseInt(row.byte_count, 10),
          };
        }
      }
    }

    const timelineSessionDbIds = rows.map((r) => r.sessionRowId);
    const timelineFavoriteIds =
      await this.repositoriesService.getFavoriteSessionIds(
        user.id,
        timelineSessionDbIds,
      );

    return rows.flatMap((r) => {
      const stats = statsMap.get(r.sessionRowId);
      // The SQL-computed branch/user
      // group is always a single bucket (`[r.group]`); for `groupBy=attr:<key>` the resolved
      // labels fan this session into one full row per label — orphaned/absent values never
      // form their own bucket, and a `string[]` value with N literal
      // values produces N identical rows differing only in `group`.
      const groups =
        groupByAttrKey !== undefined
          ? attributeGroupLabels(
              groupByAttrKey,
              r.attrValues,
              resolvedDefinitions,
            )
          : [r.group];
      return groups.map((group) => ({
        sessionId: r.sessionId,
        startTime: r.startTime!.toISOString(),
        endTime: r.endTime!.toISOString(),
        // Masked in the projection, never in the `WHERE`.
        firstPrompt: maskFirstPrompt(
          timelineScope,
          user.id,
          r.rowUserId,
          r.firstPrompt,
        ),
        gitBranch: r.gitBranch,
        userEmail: r.userEmail,
        group,
        workTimeMs: stats?.workTimeMs ?? 0,
        totalCost: stats?.totalCost ?? null,
        filesEditedWritten: stats?.filesEditedWritten ?? 0,
        linesChanged: stats?.linesChanged ?? 0,
        filesEditedWrittenOwn: stats?.filesEditedWrittenOwn ?? 0,
        linesChangedOwn: stats?.linesChangedOwn ?? 0,
        imageCount: stats?.imageCount ?? 0,
        imageTotalBytes: stats?.imageTotalBytes ?? 0,
        mcpCallsTotal: stats?.mcpCallsTotal ?? 0,
        mcpCallsByServer: stats?.mcpCallsByServer ?? {},
        fileStatsByCategory: stats?.fileStatsByCategory ?? {},
        logLineCount: stats?.logLineCount ?? 0,
        cacheReadTokens: stats?.cacheReadTokens ?? 0,
        cacheWriteTokens: stats?.cacheWriteTokens ?? 0,
        webSearchRequests: stats?.webSearchRequests ?? 0,
        inputTokensFast: stats?.inputTokensFast ?? 0,
        outputTokensFast: stats?.outputTokensFast ?? 0,
        descendantCacheReadTokens: stats?.descendantCacheReadTokens ?? 0,
        descendantCacheWriteTokens: stats?.descendantCacheWriteTokens ?? 0,
        costUnavailableReason: stats?.costUnavailableReason ?? null,
        unpricedModels: stats?.unpricedModels ?? [],
        isFavorite: timelineFavoriteIds.has(r.sessionRowId),
      }));
    });
  }

  /**
   * The change-surface analytics timeline.
   *
   * Every number here comes out of `ChangeSurfaceAggregateService.build()` — the very same
   * call, with the same arguments, that `reports/change-surface` makes (it just pins
   * `bucket: 'week'`). That is what makes "all surfaces agree" structural: the chart and the report cannot
   * disagree, because there is only one fold.
   *
   * Parameter parsing deliberately mirrors `getAnalyticsTimeline()` above — same required
   * dates, same single-day UTC widening, same `branch`/`user`/`attr:<key>` grouping rules and
   * the same "cannot combine `groupBy=branch` with a `branches` filter" guards — so the
   * analytics view can swap between its metrics without rewriting its query string. The one
   * addition is `bucket`, which overrides the range-derived default
   * (`CHANGE_SURFACE_BUCKET_THRESHOLDS`) and 400s on anything outside `hour|day|week`.
   */
  @Get(':repoId/analytics/change-surface')
  async getAnalyticsChangeSurface(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDateParam?: string,
    @Query('endDate') endDateParam?: string,
    @Query('groupBy') groupByParam?: string,
    @Query('branches') branchesParam?: string,
    @Query('users') usersParam?: string,
    @Query('attr') attrParam?: string | string[],
    @Query('bucket') bucketParam?: string,
  ): Promise<ChangeSurfaceTimeline> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
    if (!startDateParam) {
      throw new BadRequestException('startDate is required');
    }
    if (!endDateParam) {
      throw new BadRequestException('endDate is required');
    }

    let startDate = new Date(startDateParam);
    let endDate = new Date(endDateParam);
    if (isNaN(startDate.getTime())) {
      throw new BadRequestException('startDate must be a valid ISO 8601 date');
    }
    if (isNaN(endDate.getTime())) {
      throw new BadRequestException('endDate must be a valid ISO 8601 date');
    }

    // Same calendar day -> widen to the whole UTC day, exactly as `analytics/timeline` does;
    // without it a single-day range collapses to a zero-width window and returns nothing.
    if (startDateParam === endDateParam) {
      startDate = new Date(
        Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      );
      endDate = new Date(
        Date.UTC(
          endDate.getUTCFullYear(),
          endDate.getUTCMonth(),
          endDate.getUTCDate(),
          23,
          59,
          59,
          0,
        ),
      );
    }

    // `none` is spelled out here (unlike `analytics/timeline`, whose absent `groupBy` means
    // "no grouping") because the aggregate service takes it as an explicit value.
    const groupByAttrKey = parseGroupByAttrKey(groupByParam);
    const groupBy = (groupByParam ?? 'none') as ChangeSurfaceGroupBy;
    if (
      groupByAttrKey === undefined &&
      !CHANGE_SURFACE_GROUP_BY_VALUES.includes(groupBy)
    ) {
      throw new BadRequestException(
        `groupBy must be one of: ${CHANGE_SURFACE_GROUP_BY_VALUES.join(', ')}, or attr:<key>`,
      );
    }

    // An absent `bucket` means "derive it from the range"; an
    // unrecognised one is a 400 rather than a silent fallback, so a typo in a saved URL is
    // visible instead of quietly re-bucketing the chart.
    let explicitBucket: ChangeSurfaceTimelineBucket | undefined;
    if (bucketParam !== undefined && bucketParam !== '') {
      if (!isChangeSurfaceTimelineBucket(bucketParam)) {
        throw new BadRequestException(
          `bucket must be one of: ${CHANGE_SURFACE_TIMELINE_BUCKETS.join(', ')}`,
        );
      }
      explicitBucket = bucketParam;
    }

    const branches =
      branchesParam !== undefined && branchesParam !== ''
        ? branchesParam.split(',').map((b) => decodeURIComponent(b))
        : [];
    const users =
      usersParam !== undefined && usersParam !== ''
        ? usersParam.split(',').map((u) => decodeURIComponent(u))
        : [];

    if (groupBy === 'branch' && branches.length > 0) {
      throw new BadRequestException(
        'Cannot combine groupBy=branch with a branches filter',
      );
    }
    if (groupBy === 'user' && users.length > 0) {
      throw new BadRequestException(
        'Cannot combine groupBy=user with a users filter',
      );
    }

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIds = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      teamId,
    );
    // Team access mode — same 403 gate as
    // `analytics/timeline` above, and the same row filter through `AnalyticsScope.scope`.
    const changeSurfaceScope = await this.repositoriesService.resolveTeamScope(
      user,
      teamId,
    );
    if (teamId !== undefined && !changeSurfaceScope.analyticsAllowed) {
      throw new ForbiddenException();
    }

    const attributeFilters = parseAttributeFilters(
      normalizeRepeatableParam(attrParam),
    );
    const resolvedDefinitions = await this.sessionAttributionService
      .resolveDefinitions(user.id, repo.repoUrl, teamId)
      .then((d) => d.attributes);
    if (attributeFilters.length > 0) {
      validateAttributeFilterTypes(
        attributeFilters,
        buildAttributeTypeLookup(resolvedDefinitions),
      );
    }
    assertKnownGroupByAttrKey(groupByAttrKey, resolvedDefinitions);
    assertNoGroupByAttrFilterConflict(groupByAttrKey, attributeFilters);

    const bucket = resolveChangeSurfaceBucket(
      explicitBucket,
      startDate,
      endDate,
    );

    const result = await this.changeSurfaceAggregateService.build(repoIds, {
      teamId,
      requesterUserId: user.id,
      scope: changeSurfaceScope,
      startDate,
      endDate,
      branches,
      users,
      attributeFilters,
      groupBy,
      bucket,
      resolvedAttributeDefinitions: resolvedDefinitions,
    });

    // Only the series survives onto the wire: the chart plots buckets, and the per-group
    // *aggregate* the same call also computed belongs to the report, not here.
    return {
      bucket,
      buckets: result.buckets,
      groups:
        result.groups === null
          ? null
          : result.groups.map((group) => ({
              key: group.key,
              label: group.label,
              buckets: group.buckets,
            })),
    };
  }

  @Get(':repoId/analytics/work-time')
  async getAnalyticsWorkTime(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDateParam?: string,
    @Query('endDate') endDateParam?: string,
    @Query('groupBy') groupBy?: string,
    @Query('branches') branchesParam?: string,
    @Query('users') usersParam?: string,
    @Query('attr') attrParam?: string | string[],
  ): Promise<WorkTimeBucket[]> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }

    if (!startDateParam) {
      throw new BadRequestException('startDate is required');
    }
    if (!endDateParam) {
      throw new BadRequestException('endDate is required');
    }

    let startDate = new Date(startDateParam);
    let endDate = new Date(endDateParam);

    if (isNaN(startDate.getTime())) {
      throw new BadRequestException('startDate must be a valid ISO 8601 date');
    }
    if (isNaN(endDate.getTime())) {
      throw new BadRequestException('endDate must be a valid ISO 8601 date');
    }

    // When same calendar day, normalize to cover the full day in UTC
    if (startDateParam === endDateParam) {
      startDate = new Date(
        Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      );
      endDate = new Date(
        Date.UTC(
          endDate.getUTCFullYear(),
          endDate.getUTCMonth(),
          endDate.getUTCDate(),
          23,
          59,
          59,
          0,
        ),
      );
    }

    // `groupBy=attr:<key>` accepted alongside the
    // fixed 'branch'/'user' values — the key itself is validated below.
    const groupByAttrKey = parseGroupByAttrKey(groupBy);
    if (
      groupBy !== undefined &&
      groupBy !== 'branch' &&
      groupBy !== 'user' &&
      groupByAttrKey === undefined
    ) {
      throw new BadRequestException(
        "groupBy must be 'branch', 'user', or 'attr:<key>'",
      );
    }

    const branches =
      branchesParam !== undefined && branchesParam !== ''
        ? branchesParam.split(',').map((b) => decodeURIComponent(b))
        : [];

    const users =
      usersParam !== undefined && usersParam !== ''
        ? usersParam.split(',').map((u) => decodeURIComponent(u))
        : [];

    if (groupBy === 'branch' && branches.length > 0) {
      throw new BadRequestException(
        'Cannot combine groupBy=branch with a branches filter',
      );
    }
    if (groupBy === 'user' && users.length > 0) {
      throw new BadRequestException(
        'Cannot combine groupBy=user with a users filter',
      );
    }

    const user = req.user as AuthUser;
    const repoWorkTime = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIdsWorkTime = await this.repositoriesService.resolveRepoIds(
      repoId,
      repoWorkTime.repoUrl,
      teamId,
    );
    const repoIdsWorkTimeLiteral = `{${repoIdsWorkTime.join(',')}}`;
    const repoWorkTimeFilter = sql`lr.repo_id = ANY(${repoIdsWorkTimeLiteral}::int[])`;

    // Repeatable `attr=<key>:<op>:<value>`
    // filters, validated against this repo's resolved attribute definitions — the same
    // definitions `groupByAttrKey`'s 400 check and its declared-type lookup below both need.
    const attributeFilters = parseAttributeFilters(
      normalizeRepeatableParam(attrParam),
    );
    const resolvedDefinitions = await this.sessionAttributionService
      .resolveDefinitions(user.id, repoWorkTime.repoUrl, teamId)
      .then((d) => d.attributes);
    if (attributeFilters.length > 0) {
      validateAttributeFilterTypes(
        attributeFilters,
        buildAttributeTypeLookup(resolvedDefinitions),
      );
    }
    assertKnownGroupByAttrKey(groupByAttrKey, resolvedDefinitions);
    assertNoGroupByAttrFilterConflict(groupByAttrKey, attributeFilters);
    const attrCondition = attributeFilterSql(
      attributeFilters,
      sql`l.session_id`,
    );
    const attrFilter = attrCondition ?? sql`TRUE`;
    // Non-null whenever `groupByAttrKey` is (guaranteed by `assertKnownGroupByAttrKey` above).
    const groupByAttrType = groupByAttrKey
      ? resolvedDefinitions.find((d) => d.key === groupByAttrKey)?.type
      : undefined;

    // Team access mode — the same 403 gate the other two
    // analytics routes apply, and the same three-way row filter.
    const workTimeScope = await this.repositoriesService.resolveTeamScope(
      user,
      teamId,
    );
    if (teamId !== undefined && !workTimeScope.analyticsAllowed) {
      throw new ForbiddenException();
    }

    // Build parameterised fragments for optional filters so we reuse SQL safely. Unlike
    // the fragments on the other routes this one is a bare predicate (no leading `AND`),
    // because every CTE below splices it as its own `AND ${teamFilter}` term.
    const teamFilter =
      teamId === undefined
        ? sql`l.user_id = ${user.id}`
        : workTimeScope.visibleUserIds === null
          ? // `transparent` team — every current member, as before access modes existed.
            sql`l.user_id IN (SELECT user_id FROM team_members WHERE team_id = ${teamId})`
          : // `restricted` — the acknowledged members this caller may read.
            sql`l.user_id = ANY(${`{${workTimeScope.visibleUserIds.join(',')}}`}::int[])`;

    const branchFilter =
      branches.length > 0
        ? sql`COALESCE(l.git_branch, 'no branch') = ANY(${branches}::text[])`
        : sql`TRUE`;

    const userFilter =
      users.length > 0 ? sql`u.email = ANY(${users}::text[])` : sql`TRUE`;

    /**
     * The `groupBy=attr:<key>` bucket label(s), fanning a session into one `timeline_sessions`
     * row per resolved label — this query buckets by day/group entirely
     * in SQL (unlike `analytics/timeline`'s row-per-session shape, which fans out in TS via
     * `attributeGroupLabels()`), so there is no per-row TS pass left to hook a fan-out into.
     * `attrGroupKeysSql()` is the shared set-returning primitive: one row per
     * `jsonb_array_elements_text` element for a non-empty `string[]` value (the fan-out case),
     * exactly one row otherwise. Requires a `LEFT JOIN session_attribution attr_sa ON
     * attr_sa.session_id = l.session_id` in whatever CTE embeds it, joined via `attrJoin`
     * below, followed by `attrGroupJoin`'s `CROSS JOIN LATERAL` to actually produce the
     * (possibly multiple) `group_key` rows.
     */
    const attrJoin =
      groupByAttrKey !== undefined
        ? sql`LEFT JOIN session_attribution attr_sa ON attr_sa.session_id = l.session_id`
        : sql``;
    const attrGroupJoin =
      groupByAttrKey !== undefined
        ? sql`CROSS JOIN LATERAL (${attrGroupKeysSql(groupByAttrKey, groupByAttrType!)}) AS attr_group(group_key)`
        : sql``;

    // groups CTE produces one row per distinct group_key for the zero-fill cross join.
    // When no grouping is requested it emits a single NULL row so every hour still appears.
    const groupsCte =
      groupBy === 'branch'
        ? sql`
            SELECT DISTINCT COALESCE(l.git_branch, 'no branch') AS group_key
            FROM logs l
            INNER JOIN log_repositories lr ON lr.log_id = l.id
            INNER JOIN users u ON u.id = l.user_id
            WHERE l.log_type = 'artisyn'
              AND l.start_time IS NOT NULL
              AND l.end_time IS NOT NULL
              AND l.first_prompt IS NOT NULL
              AND ${repoWorkTimeFilter}
              AND l.start_time >= ${startDate}
              AND l.start_time <= ${endDate}
              AND ${teamFilter}
              AND ${branchFilter}
              AND ${userFilter}
              AND ${attrFilter}
          `
        : groupBy === 'user'
          ? sql`
            SELECT DISTINCT u.email AS group_key
            FROM logs l
            INNER JOIN log_repositories lr ON lr.log_id = l.id
            INNER JOIN users u ON u.id = l.user_id
            WHERE l.log_type = 'artisyn'
              AND l.start_time IS NOT NULL
              AND l.end_time IS NOT NULL
              AND l.first_prompt IS NOT NULL
              AND ${repoWorkTimeFilter}
              AND l.start_time >= ${startDate}
              AND l.start_time <= ${endDate}
              AND ${teamFilter}
              AND ${branchFilter}
              AND ${userFilter}
              AND ${attrFilter}
          `
          : groupByAttrKey !== undefined
            ? sql`
            SELECT DISTINCT attr_group.group_key
            FROM logs l
            INNER JOIN log_repositories lr ON lr.log_id = l.id
            INNER JOIN users u ON u.id = l.user_id
            ${attrJoin}
            ${attrGroupJoin}
            WHERE l.log_type = 'artisyn'
              AND l.start_time IS NOT NULL
              AND l.end_time IS NOT NULL
              AND l.first_prompt IS NOT NULL
              AND ${repoWorkTimeFilter}
              AND l.start_time >= ${startDate}
              AND l.start_time <= ${endDate}
              AND ${teamFilter}
              AND ${branchFilter}
              AND ${userFilter}
              AND ${attrFilter}
          `
            : sql`SELECT NULL::text AS group_key`;

    // Scalar `branch`/`user`/no-grouping stay a plain column
    // expression selected once per `logs` row; `attr:<key>` instead resolves to
    // `attr_group.group_key`, the `CROSS JOIN LATERAL` alias `attrGroupJoin` adds to
    // `timeline_sessions`'s FROM clause below — a `string[]` value with N literal values
    // produces N joined copies of that session's row here, each carrying a different
    // `group_key`, before the sweep-line merge groups by `(day, group_key)`.
    const sessionGroupExpr =
      groupBy === 'branch'
        ? sql`COALESCE(l.git_branch, 'no branch')`
        : groupBy === 'user'
          ? sql`u.email`
          : groupByAttrKey !== undefined
            ? sql`attr_group.group_key`
            : sql`NULL::text`;

    const result = await this.db.execute(sql`
      WITH
      days AS (
        SELECT generate_series(
          date_trunc('day', ${startDate}::timestamptz),
          date_trunc('day', ${endDate}::timestamptz),
          '1 day'::interval
        )::date AS day
      ),
      groups AS (
        ${groupsCte}
      ),
      timeline_sessions AS (
        SELECT
          l.id AS log_id,
          l.session_id,
          l.start_time,
          l.end_time,
          ${sessionGroupExpr} AS group_key
        FROM logs l
        INNER JOIN log_repositories lr ON lr.log_id = l.id
        INNER JOIN users u ON u.id = l.user_id
        ${attrJoin}
        ${attrGroupJoin}
        WHERE l.log_type = 'artisyn'
          AND l.start_time IS NOT NULL
          AND l.end_time IS NOT NULL
          AND l.first_prompt IS NOT NULL
          AND ${repoWorkTimeFilter}
          AND l.start_time >= ${startDate}
          AND l.start_time <= ${endDate}
          AND ${teamFilter}
          AND ${branchFilter}
          AND ${userFilter}
          AND ${attrFilter}
      ),
      artisyn_fallback AS (
        SELECT
          ae.log_id,
          SUM(EXTRACT(EPOCH FROM (ae.next_ts - ae.event_ts)) * 1000) AS work_time_ms
        FROM (
          SELECT
            l.id AS log_id,
            (evt->>'event') AS event_type,
            (evt->>'timestamp')::timestamptz AS event_ts,
            LEAD((evt->>'timestamp')::timestamptz)
              OVER (PARTITION BY l.id ORDER BY (evt->>'timestamp')::timestamptz) AS next_ts
          FROM logs l
          CROSS JOIN LATERAL jsonb_array_elements(l.body) AS evt
          WHERE l.log_type = 'artisyn'
            AND l.session_id IN (SELECT session_id FROM timeline_sessions)
            AND (evt->>'event') IN ('prompt_start', 'prompt_stop')
            AND (evt->>'timestamp') IS NOT NULL
        ) ae
        WHERE ae.event_type = 'prompt_start'
          AND ae.next_ts IS NOT NULL
        GROUP BY ae.log_id
      ),
      -- Each session's "work" interval is approximated as [start_time, start_time + work_time_ms],
      -- clamped to end_time. work_time_ms already excludes idle gaps within the session
      -- (see claude-extractor.ts computeWorkTime); this CTE only adds interval boundaries so
      -- overlapping sessions can be merged below instead of double-counted by a plain SUM.
      session_intervals AS (
        SELECT
          ts.group_key,
          ts.start_time AS start_ts,
          LEAST(
            ts.start_time
              + (COALESCE(ss.work_time_ms, af.work_time_ms, 0) * INTERVAL '1 millisecond'),
            ts.end_time
          ) AS end_ts
        FROM timeline_sessions ts
        LEFT JOIN session_stats ss ON ss.session_id = ts.session_id
        LEFT JOIN artisyn_fallback af ON af.log_id = ts.log_id
      ),
      -- Split each session interval at day boundaries so a session crossing midnight only
      -- contributes the portion that actually falls on each day.
      session_days AS (
        SELECT
          si.group_key,
          d::date AS day,
          GREATEST(si.start_ts, d) AS clipped_start,
          LEAST(si.end_ts, d + INTERVAL '1 day') AS clipped_end
        FROM session_intervals si
        CROSS JOIN LATERAL generate_series(
          date_trunc('day', si.start_ts),
          date_trunc('day', si.end_ts),
          INTERVAL '1 day'
        ) AS d
        WHERE si.end_ts > si.start_ts
          AND GREATEST(si.start_ts, d) < LEAST(si.end_ts, d + INTERVAL '1 day')
      ),
      -- Sweep-line merge of overlapping/concurrent session intervals within the same
      -- day/group, so total minutes reflects real elapsed (union) time, never double-counted.
      ordered AS (
        SELECT
          *,
          MAX(clipped_end) OVER (
            PARTITION BY day, group_key
            ORDER BY clipped_start
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ) AS prev_max_end
        FROM session_days
      ),
      islands AS (
        SELECT
          *,
          SUM(
            CASE WHEN prev_max_end IS NULL OR clipped_start > prev_max_end THEN 1 ELSE 0 END
          ) OVER (PARTITION BY day, group_key ORDER BY clipped_start) AS island_id
        FROM ordered
      ),
      merged AS (
        SELECT
          day,
          group_key,
          island_id,
          MIN(clipped_start) AS merged_start,
          MAX(clipped_end) AS merged_end
        FROM islands
        GROUP BY day, group_key, island_id
      ),
      day_totals AS (
        SELECT
          day,
          group_key,
          SUM(EXTRACT(EPOCH FROM (merged_end - merged_start))) / 60.0 AS work_minutes
        FROM merged
        GROUP BY day, group_key
      )
      SELECT
        d.day,
        g.group_key AS "group",
        COALESCE(dt.work_minutes, 0) AS "workTimeMinutes"
      FROM days d
      CROSS JOIN groups g
      LEFT JOIN day_totals dt
        ON dt.day = d.day
        AND (dt.group_key = g.group_key OR (dt.group_key IS NULL AND g.group_key IS NULL))
      ORDER BY d.day ASC
    `);

    type RawRow = {
      day: Date | string;
      group: string | null;
      workTimeMinutes: string;
    };
    return (result.rows as unknown as RawRow[]).map((row) => ({
      day:
        row.day instanceof Date
          ? row.day.toISOString()
          : new Date(row.day).toISOString(),
      group: row.group,
      workTimeMinutes: parseFloat(row.workTimeMinutes),
    }));
  }
}
