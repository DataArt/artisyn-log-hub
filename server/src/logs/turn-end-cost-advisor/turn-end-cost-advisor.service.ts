import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import {
  logs,
  sessions,
  turnEndAdvisorRuns,
  type FileCategory,
} from '../../database/schema/index';
import {
  pricingAsOfSql,
  sessionCostSql,
  sessionPriceDateSql,
} from '../cost.sql';
import { otelCostsCte, resolveSessionTotalCost } from '../otel-cost.sql';
import { descendantSessionsCte } from '../session-tree.sql';
import {
  num,
  numOrNull,
  sessionIdsArray,
} from '../analytics/scoped-sessions.sql';
import { RepositoriesService } from '../repositories.service';
import type { SessionOwnershipLookup } from '../session-attribution/session-attribution.service';

/**
 * Turn-End Cost Advisor server aggregate/config/persistence service.
 *
 * Everything the hook's advisor branch needs from the server lives here: the dual-scope
 * feature switch, the tree-wide usage aggregate fed into the
 * `claude -p` prompt (there is no $-threshold gate), and the
 * append-only run log that doubles as display persistence.
 * `resolveGate()` is the one entry point the combined `post-turn-analysis` endpoint calls
 * — every other method here is a building block for it, but each stays
 * independently callable/testable.
 */

/** No built-in default lives in `RepoConfigJson` (absent there means "gate never met") —
 * this is the one place `$0.1` is a literal, per the requirements' own answer ("DO not run
 * it for sessions < $0.1 (set in settings)"). */
export const DEFAULT_TURN_END_COST_ADVISOR_MIN_SESSION_COST_USD = 0.1;

export interface TurnEndCostAdvisorEffectiveConfig {
  enabled: boolean;
  minSessionCostUsd: number;
  /**
   * The scope `resolveEffectiveConfig()` resolved the config from — `null` for a
   * user-scoped row or the built-in default, a team id for a team-scoped row. Threaded
   * into `buildAggregate()` so its `session_file_stats` read can filter to the SAME scope
   * the config itself came from, reusing the identical rule
   * `repositories.controller.ts`'s own file-stats scope resolution applies (a user-scoped
   * row present -> `user_id`, else a team-scoped row present for this `teamId` ->
   * `team_id`, else -> `user_id`) without a second `repo_config` round trip.
   */
  teamId: number | null;
  /**
   * The effective `RepoConfigJson.fileCategories` for this scope, sourced from
   * the same `resolveEffectiveConfig()` call `teamId` above already comes from. Threaded
   * through to the hook via {@link TurnEndAdvisorGate} so it can classify files itself
   * when deriving a local aggregate — the hook has no other
   * way to learn the repo/team's configured categories.
   */
  fileCategories: FileCategory[];
}

export interface TurnEndAdvisorToolUsage {
  toolName: string;
  calls: number;
  failures: number;
}

export interface TurnEndAdvisorFileUsage {
  categoryName: string;
  fileCount: number;
  byteCount: number;
}

/**
 * Tree-wide usage snapshot fed into the advisor's `claude -p` prompt —
 * except `toolUsage`/`fileUsage`, which are descendants-only (see
 * their own field doc comments below).
 *
 * `turnCount` vs. `promptCount` — the requirements ask for both "turn count" and "user
 * prompts" without pinning down how they differ at tree scope, so this resolves it the way
 * every other tree-aware figure in this codebase already splits root-scope vs. tree-scope:
 * - `turnCount` is the INVOKING session's own `session_stats.turn_count` — real,
 *   human-facing turns, same root-only convention `workTimeMs` uses everywhere else in
 *   this codebase (`loadScopedRootSessions`, the executive summary's per-user rollup, the
 *   sessions list) — never tree-summed.
 * - `promptCount` is the NEW tree-wide figure this feature introduces: `SUM(turn_count)`
 *   over the whole descendant tree, i.e. total prompt/turn volume anywhere in the tree
 *   (root + every subagent/workflow), a proxy for "how much conversation activity produced
 *   this cost" that `turnCount` alone cannot show for an agent-heavy session.
 */
export interface TurnEndAdvisorAggregate {
  /**
   * Descendants-only (`ds.depth > 0`), NOT tree-wide: excludes the
   * root (invoking) session's own `session_tool_stats` row. The hook's `advisorBranch()`
   * merges in the root session's own always-fresh, locally-derived tool usage
   * (`mergeToolUsage()` in `post-turn-analysis-worker.js`) on top of this value to restore
   * tree-wide coverage without double-counting the root's own tool calls.
   */
  toolUsage: TurnEndAdvisorToolUsage[];
  /**
   * Descendants-only (`ds.depth > 0`), NOT tree-wide: excludes the
   * root (invoking) session's own `session_file_stats` row. The hook's `advisorBranch()`
   * merges in the root session's own always-fresh, locally-derived file usage
   * (`mergeFileUsage()` in `post-turn-analysis-worker.js`) on top of this value to restore
   * tree-wide coverage without double-counting the root's own files.
   */
  fileUsage: TurnEndAdvisorFileUsage[];
  promptCount: number;
  turnCount: number;
  workTimeMs: number;
  sessionCostUsd: number;
  model: string | null;
  contextWindow: number | null;
  /**
   * Whether the server actually had telemetry to build this
   * aggregate from: `rootInfo !== null` inside {@link buildAggregate}, i.e. whether a
   * `session_stats` row existed for the root session. `false` means every other field
   * above is a zero/empty/null placeholder, not a real (if small) tree — the hook uses
   * this one flag to decide whether to discard the aggregate and derive its own locally,
   * rather than inferring emptiness from a combination of sentinel values across the
   * other 7 heterogeneous fields.
   */
  hasTelemetry: boolean;
}

/** Response shape for the combined `GET /api/v2/post-turn-analysis/config`'s `advisor` half. */
export interface TurnEndAdvisorGate {
  enabled: boolean;
  thresholdMet: boolean;
  minSessionCostUsd: number;
  aggregate: TurnEndAdvisorAggregate | null;
  /**
   * The effective `RepoConfigJson.fileCategories` for this gate's resolved scope
   * (mirrors {@link TurnEndCostAdvisorEffectiveConfig.fileCategories}), so the hook can
   * classify files itself when `aggregate` is absent or `hasTelemetry` is `false`.
   */
  fileCategories: FileCategory[];
}

export type TurnEndAdvisorRunOutcome = 'submitted' | 'failed';

export interface RecordTurnEndAdvisorRunInput {
  sessionId: string;
  evalSessionId?: string | null;
  startedAt: Date;
  finishedAt: Date;
  outcome: TurnEndAdvisorRunOutcome;
  summaryGeneral?: string | null;
  costFactors?: string[] | null;
  harnessAdvice?: string[] | null;
  failureReason?: string | null;
  model?: string | null;
  costUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** What `getSessionLogs()` surfaces for the session-detail Advisor tab. */
export interface TurnEndAdvisorLatestResult {
  generatedAt: string;
  summaryGeneral: string | null;
  costFactors: string[];
  harnessAdvice: string[];
}

interface TreeCostSqlRow {
  computed_cost: string | number | null;
  otel_cost: string | number | null;
}

interface RootInfoSqlRow {
  turn_count: string | number | null;
  work_time_ms: string | number | null;
  model: string | null;
}

interface ToolUsageSqlRow {
  tool_name: string;
  calls: string | number | null;
  failures: string | number | null;
}

interface FileUsageSqlRow {
  category_name: string;
  file_count: string | number | null;
  byte_count: string | number | null;
}

@Injectable()
export class TurnEndCostAdvisorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly repositoriesService: RepositoriesService,
  ) {}

  /**
   * Dual-scope (team AND personal) feature switch, resolved through the
   * EXISTING user-then-team-then-default resolver, not a new team-only path (like
   * session attribution's team-only path). Absent `turnEndCostAdvisor` — no config row at
   * any scope, or a resolved row that never set it — means the feature is off, with the
   * built-in default `minSessionCostUsd` in force so the returned number is always usable
   * without a null check.
   */
  async resolveConfig(
    userId: number,
    repoUrl: string,
  ): Promise<TurnEndCostAdvisorEffectiveConfig> {
    const { config, teamId } =
      await this.repositoriesService.resolveEffectiveConfig(userId, repoUrl);
    const advisorConfig = config.turnEndCostAdvisor;

    if (!advisorConfig) {
      return {
        enabled: false,
        minSessionCostUsd: DEFAULT_TURN_END_COST_ADVISOR_MIN_SESSION_COST_USD,
        teamId: null,
        fileCategories: config.fileCategories,
      };
    }

    return {
      enabled: advisorConfig.enabled,
      minSessionCostUsd:
        advisorConfig.minSessionCostUsd ??
        DEFAULT_TURN_END_COST_ADVISOR_MIN_SESSION_COST_USD,
      teamId,
      fileCategories: config.fileCategories,
    };
  }

  /**
   * `POST /api/v2/turn-end-cost-advisor`'s ownership check,
   * mirroring `repositories.controller.ts`'s `getSessionLogs()` "Step 1b"
   * owner-only guard: the artisyn log's `userId` is the session's owner. A session
   * with no artisyn log at all (only staged in `upload_queue`, never upserted, or not
   * yet ingested at all) reads as `'unknown'` — the controller proceeds to
   * `recordRun` exactly as it does for `'ok'`, since a run can now be recorded
   * against a raw string `sessionId` the server has never seen before.
   */
  async checkSessionOwnership(
    sessionId: string,
    apiKeyUserId: number,
  ): Promise<'ok' | 'owner-mismatch' | 'unknown'> {
    const lookup = await this.resolveOwnedSessionRowId(sessionId, apiKeyUserId);
    if (lookup.status === 'not-ingested') return 'unknown';
    return lookup.status;
  }

  /**
   * Session ownership lookup shared by the POST ownership check and {@link resolveGate}:
   * the artisyn log's `userId` is the session's owner (same rule as
   * `SessionAttributionService.resolveOwnedSessionRowId`). `'not-ingested'` when the
   * session has no artisyn log yet; `'owner-mismatch'` when it belongs to another user;
   * `'ok'` carries the resolved `sessions.id`.
   */
  async resolveOwnedSessionRowId(
    sessionId: string,
    apiKeyUserId: number,
  ): Promise<SessionOwnershipLookup> {
    const [row] = await this.db
      .select({ sessionRowId: sessions.id, ownerUserId: logs.userId })
      .from(sessions)
      .innerJoin(
        logs,
        and(eq(logs.sessionId, sessions.id), eq(logs.logType, 'artisyn')),
      )
      .where(eq(sessions.sessionId, sessionId));

    if (!row) return { status: 'not-ingested', sessionRowId: null };
    if (row.ownerUserId !== apiKeyUserId) {
      return { status: 'owner-mismatch', sessionRowId: null };
    }
    return { status: 'ok', sessionRowId: row.sessionRowId };
  }

  /**
   * The tree-wide cost the $-threshold gate compares against, and the
   * same figure `buildAggregate()` reports back as `sessionCostUsd`. Mirrors the
   * `otelCostsCte` + per-session `model_pricing` LATERAL join pattern every other
   * tree-cost site in this codebase uses (`active-sessions.service.ts`,
   * `executive-summary.service.ts`) — computed cost is summed over EVERY session in the
   * tree (root + descendants, each priced at its own model), then merged with the root's
   * OTEL total via `resolveSessionTotalCost()` exactly as those sites do. A tree with no
   * `session_stats` rows yet (not-yet-ingested) sums to `0`, which is naturally below any
   * positive threshold.
   */
  private async loadTreeCostUsd(sessionRowId: number): Promise<number> {
    const idsArray = sessionIdsArray([sessionRowId]);

    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)},
      ${otelCostsCte(idsArray)}
      SELECT
        COALESCE(SUM(
          CASE WHEN p.model_id IS NOT NULL
            THEN ${sessionCostSql({ stats: sql`ss`, pricing: sql`p` })}
            ELSE 0.0 END
        ), 0.0) AS computed_cost,
        (SELECT otel_cost FROM otel_costs LIMIT 1) AS otel_cost
      FROM descendant_sessions ds
      JOIN session_stats ss ON ss.session_id = ds.id
        -- Excludes an OTEL-only session_stats row (no transcript ever uploaded for
        -- it) from the tree cost rollup — same guard every sibling tree-cost query uses.
        AND EXISTS (
          SELECT 1 FROM logs tl
          WHERE tl.session_id = ds.id AND tl.log_type IN ('claude', 'claude-subagent')
        )
      -- Every tree member is priced at its ROOT's price date.
      LEFT JOIN LATERAL (
        ${pricingAsOfSql(sql`ss.model`, sessionPriceDateSql(sql`ds.root_id`))}
      ) p ON true
    `);

    const row = result.rows[0] as unknown as TreeCostSqlRow | undefined;
    const computedCost = num(row?.computed_cost ?? null);
    const otelCost = numOrNull(row?.otel_cost ?? null);
    return resolveSessionTotalCost(otelCost, computedCost) ?? 0;
  }

  /** Root-only turn count / work time / model — same root-scope convention every other
   * consumer of these two `session_stats` columns already uses (see the `turnCount`/
   * `promptCount` doc comment on {@link TurnEndAdvisorAggregate}). */
  private async loadRootInfo(
    sessionRowId: number,
  ): Promise<RootInfoSqlRow | null> {
    const result = await this.db.execute(sql`
      SELECT turn_count, work_time_ms, model
      FROM session_stats
      WHERE session_id = ${sessionRowId}
    `);
    return (result.rows[0] as unknown as RootInfoSqlRow | undefined) ?? null;
  }

  /** Tree-wide `SUM(turn_count)` — total prompt/turn volume anywhere
   * in the tree, the `promptCount` half of the `turnCount`/`promptCount` split. */
  private async loadTreePromptCount(sessionRowId: number): Promise<number> {
    const idsArray = sessionIdsArray([sessionRowId]);
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)}
      SELECT COALESCE(SUM(ss.turn_count), 0) AS prompt_count
      FROM descendant_sessions ds
      JOIN session_stats ss ON ss.session_id = ds.id
    `);
    const row = result.rows[0] as unknown as
      | { prompt_count: string | number | null }
      | undefined;
    return num(row?.prompt_count ?? null);
  }

  /**
   * Descendants-only tool usage (`ds.depth > 0`), combined across
   * every subagent/workflow session under the root but excluding the root session's own
   * `session_tool_stats` row, mirroring `tool-analytics.service.ts`'s own
   * `session_tool_stats` rollup but without its main/sub-agent split — the advisor prompt
   * wants one combined ranking, not a side-by-side breakdown. Tree-wide coverage is
   * restored on the hook side, which merges in the root session's own always-fresh local
   * tool usage (`mergeToolUsage()` in `post-turn-analysis-worker.js`) — narrowing this
   * query avoids double-counting the root's own calls once that merge happens.
   */
  private async loadToolUsage(
    sessionRowId: number,
  ): Promise<TurnEndAdvisorToolUsage[]> {
    const idsArray = sessionIdsArray([sessionRowId]);
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)}
      SELECT
        sts.tool_name AS tool_name,
        SUM(sts.calls) AS calls,
        SUM(sts.failures) AS failures
      FROM descendant_sessions ds
      JOIN session_tool_stats sts ON sts.session_id = ds.id AND ds.depth > 0
      GROUP BY sts.tool_name
      ORDER BY calls DESC, tool_name ASC
    `);
    return (result.rows as unknown as ToolUsageSqlRow[]).map((r) => ({
      toolName: r.tool_name,
      calls: num(r.calls),
      failures: num(r.failures),
    }));
  }

  /**
   * Descendants-only file usage (`ds.depth > 0`, excluding the root
   * session's own `session_file_stats` row), filtered to the SAME `session_file_stats`
   * scope `resolveConfig()`'s effective config came from (see the `teamId` doc comment on
   * {@link TurnEndCostAdvisorEffectiveConfig}): a team-scoped effective config reads
   * `team_id`-scoped rows, everything else (a user-scoped row, or the built-in default)
   * reads `user_id`-scoped rows — the same outcome
   * `repositories.controller.ts`'s own file-stats scope resolution produces. Tree-wide
   * coverage is restored on the hook side, which merges in the root session's own
   * always-fresh local file usage (`mergeFileUsage()` in `post-turn-analysis-worker.js`) —
   * narrowing this query avoids double-counting the root's own files once that merge
   * happens.
   */
  private async loadFileUsage(
    sessionRowId: number,
    scope: { userId: number; teamId: number | null },
  ): Promise<TurnEndAdvisorFileUsage[]> {
    const idsArray = sessionIdsArray([sessionRowId]);
    const scopeFilter =
      scope.teamId !== null
        ? sql`sfs.team_id = ${scope.teamId}`
        : sql`sfs.user_id = ${scope.userId}`;

    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)}
      SELECT
        sfs.category_name AS category_name,
        SUM(sfs.file_count) AS file_count,
        SUM(sfs.byte_count) AS byte_count
      FROM descendant_sessions ds
      JOIN session_file_stats sfs ON sfs.session_id = ds.id AND ds.depth > 0 AND ${scopeFilter}
      GROUP BY sfs.category_name
      ORDER BY file_count DESC, category_name ASC
    `);
    return (result.rows as unknown as FileUsageSqlRow[]).map((r) => ({
      categoryName: r.category_name,
      fileCount: num(r.file_count),
      byteCount: num(r.byte_count),
    }));
  }

  /**
   * `contextWindow` is the only piece of the aggregate NOT computed
   * from the descendant tree: a straight `model_pricing.context_length` lookup for the
   * invoking (root) session's own model, using the same dated-suffix-stripping
   * normalisation (`REGEXP_REPLACE(..., '-[0-9]{8}$', '')`) every cost query in this
   * codebase applies. `null` model or no matching pricing row both yield `null`, never `0`
   * — a real 0-token context window does not exist and must stay distinguishable from
   * "unknown".
   *
   * The row is the one in force on the root session's price date
   * ({@link sessionPriceDateSql}), the same row every cost site prices that session at.
   */
  private async loadContextWindow(
    sessionRowId: number,
    model: string | null,
  ): Promise<number | null> {
    if (model === null || model === '') return null;

    // Not `pricingAsOfSql`: that helper selects only the cost rates, and this lookup needs
    // `context_length`. Same date, same predicate, same model normalisation.
    const result = await this.db.execute(sql`
      SELECT context_length
      FROM model_pricing
      WHERE effective_from <= ${sessionPriceDateSql(sql`${sessionRowId}`)}
        AND model_id = REGEXP_REPLACE(${model}, '-[0-9]{8}$', '')
      ORDER BY model_id, effective_from DESC
      LIMIT 1
    `);
    const row = result.rows[0] as unknown as
      | { context_length: number | string | null }
      | undefined;
    return row?.context_length != null ? Number(row.context_length) : null;
  }

  /**
   * The tree-wide usage snapshot fed into the advisor's `claude -p`
   * prompt. Callers (i.e. {@link resolveGate}) are expected to only call this once
   * `resolveOwnedSessionRowId()` has already confirmed the session is known and owned (there is
   * no $-threshold gate this call waits on) — this method itself does no
   * threshold check, it just reports what the tree looks like.
   */
  async buildAggregate(
    sessionRowId: number,
    scope: { userId: number; teamId: number | null },
  ): Promise<TurnEndAdvisorAggregate> {
    const [rootInfo, toolUsage, fileUsage, promptCount, sessionCostUsd] =
      await Promise.all([
        this.loadRootInfo(sessionRowId),
        this.loadToolUsage(sessionRowId),
        this.loadFileUsage(sessionRowId, scope),
        this.loadTreePromptCount(sessionRowId),
        this.loadTreeCostUsd(sessionRowId),
      ]);

    const model = rootInfo?.model ?? null;
    const contextWindow = await this.loadContextWindow(sessionRowId, model);

    return {
      toolUsage,
      fileUsage,
      promptCount,
      turnCount: num(rootInfo?.turn_count ?? null),
      workTimeMs: num(rootInfo?.work_time_ms ?? null),
      sessionCostUsd,
      model,
      contextWindow,
      hasTelemetry: rootInfo !== null,
    };
  }

  /**
   * The one entry point the combined `post-turn-analysis` endpoint
   * calls: resolves the config and (whenever `enabled` and the session is known) an
   * always-built aggregate, packaging both into the exact `TurnEndAdvisorGate` shape the
   * API contract defines. There is no `$`-cost gate — `thresholdMet` is
   * now purely "enabled + session ingested", never a below-threshold `false` — so
   * `aggregate` stays `null` only when the feature is off or the session has never been
   * ingested at all; `hasTelemetry` on the aggregate itself is what
   * tells the hook whether that aggregate is real or an empty placeholder.
   */
  async resolveGate(
    userId: number,
    repoUrl: string,
    sessionId: string,
  ): Promise<TurnEndAdvisorGate> {
    const config = await this.resolveConfig(userId, repoUrl);
    if (!config.enabled) {
      return {
        enabled: false,
        thresholdMet: false,
        minSessionCostUsd: config.minSessionCostUsd,
        aggregate: null,
        fileCategories: config.fileCategories,
      };
    }

    // Open-source readiness: a session owned by another user is
    // answered exactly like a not-yet-ingested one — no aggregate is computed, so one
    // API key can never read another user's session usage.
    const ownership = await this.resolveOwnedSessionRowId(sessionId, userId);
    const sessionRowId =
      ownership.status === 'ok' ? ownership.sessionRowId : null;
    if (sessionRowId === null) {
      // A not-yet-ingested (or foreign) session has nothing to build an aggregate from.
      return {
        enabled: true,
        thresholdMet: false,
        minSessionCostUsd: config.minSessionCostUsd,
        aggregate: null,
        fileCategories: config.fileCategories,
      };
    }

    const aggregate = await this.buildAggregate(sessionRowId, {
      userId,
      teamId: config.teamId,
    });

    return {
      enabled: true,
      thresholdMet: true,
      minSessionCostUsd: config.minSessionCostUsd,
      aggregate,
      fileCategories: config.fileCategories,
    };
  }

  /**
   * Append-only insert, one row per actual evaluation attempt
   * (`outcome ∈ {'submitted','failed'}`; a below-threshold or feature-off turn never calls
   * this at all). No locking, no "latest run" bookkeeping beyond the row itself — overlapping
   * runs on rapid consecutive turns are permitted by design, and {@link getLatestResult}
   * is what resolves "the newest submitted result" by `started_at` at read time.
   */
  async recordRun(
    input: RecordTurnEndAdvisorRunInput,
    userId: number,
  ): Promise<void> {
    await this.db.insert(turnEndAdvisorRuns).values({
      sessionId: input.sessionId,
      // The API-key user who recorded the run; reads only count
      // rows whose userId equals the session owner.
      userId,
      evalSessionId: input.evalSessionId ?? null,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: input.outcome,
      summaryGeneral: input.summaryGeneral ?? null,
      costFactors: input.costFactors ?? null,
      harnessAdvice: input.harnessAdvice ?? null,
      failureReason: input.failureReason ?? null,
      model: input.model ?? null,
      costUsd: input.costUsd != null ? input.costUsd.toFixed(6) : null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
    });
  }

  /**
   * `turn_end_advisor_runs` doubles as display persistence: the
   * latest `outcome='submitted'` row for this session, by `started_at` descending. `null`
   * when the session has never had a successful evaluation (including "never evaluated at
   * all" and "every attempt so far failed").
   */
  async getLatestResult(
    sessionId: string,
  ): Promise<TurnEndAdvisorLatestResult | null> {
    const [row] = await this.db
      .select({
        startedAt: turnEndAdvisorRuns.startedAt,
        summaryGeneral: turnEndAdvisorRuns.summaryGeneral,
        costFactors: turnEndAdvisorRuns.costFactors,
        harnessAdvice: turnEndAdvisorRuns.harnessAdvice,
      })
      .from(turnEndAdvisorRuns)
      .where(
        and(
          eq(turnEndAdvisorRuns.sessionId, sessionId),
          // Only runs recorded by the session owner (the artisyn
          // log's user); a NULL user_id or a session with no owner never matches.
          eq(
            turnEndAdvisorRuns.userId,
            sql<number>`(
              SELECT ol.user_id FROM logs ol
              INNER JOIN sessions os ON os.id = ol.session_id
              WHERE os.session_id = ${sessionId} AND ol.log_type = 'artisyn'
              LIMIT 1
            )`,
          ),
          eq(turnEndAdvisorRuns.outcome, 'submitted'),
        ),
      )
      .orderBy(desc(turnEndAdvisorRuns.startedAt))
      .limit(1);

    if (!row) return null;

    return {
      generatedAt: row.startedAt.toISOString(),
      summaryGeneral: row.summaryGeneral,
      costFactors: row.costFactors ?? [],
      harnessAdvice: row.harnessAdvice ?? [],
    };
  }
}
