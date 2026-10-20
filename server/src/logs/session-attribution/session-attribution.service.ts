import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import {
  logs,
  sessionAttribution,
  sessionAttributionRuns,
  sessionPromptWatermark,
  sessions,
  type SessionAttributionAttributeDef,
} from '../../database/schema/index';
import { RepositoriesService } from '../repositories.service';

/**
 * AI Session Attribution server config/definitions resolution,
 * watermark bookkeeping and append-only run persistence.
 *
 * Everything the hook's attribution branch and the combined `post-turn-analysis` config
 * endpoint need from the server lives here: the team-only attribute definitions,
 * the `evaluationRequired` gate, the monotonic
 * prompt-watermark side effect the config GET performs, and the conditional upsert that
 * decides whether a submitted evaluation actually wins.
 * `resolveGate()` is the one entry point the combined `post-turn-analysis` endpoint calls
 * — every other method here is a building block for it, but each
 * stays independently callable/testable.
 */

/**
 * The static built-in attribute set, returned whenever a repo
 * resolves to a team (so the feature is available) but that team has never saved its own
 * `sessionAttribution.attributes` override. Never duplicated hook-side — the hook always
 * learns its attribute set from the combined config GET.
 */
export const DEFAULT_ATTRIBUTES: SessionAttributionAttributeDef[] = [
  {
    key: 'jira_ticket',
    label: 'Jira Ticket',
    type: 'string',
    prompt: 'the ticket key the session works on, e.g. ABC-123, null if none',
  },
  {
    key: 'adlc_stages',
    label: 'Workflow Stages',
    type: 'string[]',
    prompt:
      'which stages of the development lifecycle the session covered — requirements, ' +
      'design, plan, implement, test, review, docs, devops',
  },
  {
    key: 'has_correction',
    label: 'Has Correction',
    type: 'boolean',
    prompt: "whether a user prompt corrects the agent's direction",
  },
];

export interface SessionAttributionDefinitions {
  enabled: boolean;
  attributes: SessionAttributionAttributeDef[];
  teamId: number | null;
}

/** Response shape for the combined `GET /api/v2/post-turn-analysis/config`'s `attribution` half. */
export interface SessionAttributionGate {
  enabled: boolean;
  attributes: SessionAttributionAttributeDef[];
  evaluatedWatermark: number | null;
  evaluationRequired: boolean;
}

export type SessionAttributionRunOutcome =
  | 'applied'
  | 'ignored_stale'
  | 'failed';

/**
 * `POST /api/v2/session-attribution`'s ownership-check result — mirrors the advisor's
 * `SessionOwnershipLookup` (`turn-end-cost-advisor.service.ts`) exactly: `'not-ingested'`
 * when the transcript session has no `sessions` row yet (the controller answers `2xx
 * {applied:false}`, no row written); `'owner-mismatch'` when the session exists but
 * belongs to a different API-key user (`404`); `'ok'` carries the resolved `sessions.id`.
 */
export type SessionOwnershipStatus = 'not-ingested' | 'owner-mismatch' | 'ok';

export interface SessionOwnershipLookup {
  status: SessionOwnershipStatus;
  sessionRowId: number | null;
}

export interface RecordSessionAttributionRunInput {
  sessionRowId: number;
  promptWatermark: number;
  evalSessionId?: string | null;
  invokingSessionId?: string | null;
  startedAt: Date;
  finishedAt: Date;
  outcome: SessionAttributionRunOutcome;
  /** Set only on `outcome: 'failed'` (migration 0057) — surfaced by `getRepositorySessions()`'s `lastRun`. */
  failureReason?: string | null;
  model?: string | null;
  costUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

@Injectable()
export class SessionAttributionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly repositoriesService: RepositoriesService,
  ) {}

  /**
   * Team-only attribute definitions. A repo resolving to no team
   * (`teamId: null`) never sees the built-in defaults — the feature is simply unavailable.
   * A repo that belongs to a team but hasn't saved its own override gets
   * {@link DEFAULT_ATTRIBUTES}, enabled by default (the feature works out of the box for
   * any team repo unless the team explicitly turns it off). A team that HAS saved a config
   * row uses exactly what it saved, `enabled` included.
   *
   * `viewTeamId` is the team of a team-view request; without it the caller's lowest-id team
   * linking `repoUrl` is used.
   */
  async resolveDefinitions(
    userId: number,
    repoUrl: string,
    viewTeamId?: number,
  ): Promise<SessionAttributionDefinitions> {
    const { config, teamId } =
      await this.repositoriesService.resolveTeamOnlyConfig(
        userId,
        repoUrl,
        viewTeamId,
      );

    if (teamId === null) {
      return { enabled: false, attributes: [], teamId: null };
    }

    if (!config) {
      return { enabled: true, attributes: DEFAULT_ATTRIBUTES, teamId };
    }

    return { enabled: config.enabled, attributes: config.attributes, teamId };
  }

  /**
   * `POST /api/v2/session-attribution`'s ownership check,
   * mirroring the advisor's `resolveOwnedSessionRowId` exactly: the artisyn log's `userId` is
   * the session's owner.
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
   * Watermark input — the last successfully-applied evaluation's
   * `prompt_watermark` for this session, or `null` when the session has never had one
   * applied.
   */
  private async loadEvaluatedWatermark(
    sessionRowId: number,
  ): Promise<number | null> {
    const [row] = await this.db
      .select({ promptWatermark: sessionAttribution.promptWatermark })
      .from(sessionAttribution)
      .where(eq(sessionAttribution.sessionId, sessionRowId));
    return row ? row.promptWatermark : null;
  }

  /**
   * The combined config GET's side effect (API changes): upserts `promptWatermark` into
   * `session_prompt_watermark` monotonically (`GREATEST`) — never regresses even if an
   * out-of-order request reports a smaller watermark than one already recorded.
   */
  private async upsertPromptWatermark(
    sessionRowId: number,
    promptWatermark: number,
  ): Promise<void> {
    await this.db
      .insert(sessionPromptWatermark)
      .values({ sessionId: sessionRowId, promptWatermark })
      .onConflictDoUpdate({
        target: sessionPromptWatermark.sessionId,
        set: {
          promptWatermark: sql`GREATEST(${sessionPromptWatermark.promptWatermark}, excluded.prompt_watermark)`,
          updatedAt: sql`now()`,
        },
      });
  }

  /**
   * The one entry point the combined `post-turn-analysis` endpoint
   * calls: resolves the definitions, performs the watermark side effect (when the session
   * row exists), and computes `evaluationRequired` per the formula
   * (`enabled && promptWatermark > (evaluatedWatermark ?? -1)`).
   *
   * An unknown `sessionId` (not-yet-ingested) skips the watermark side effect entirely
   * (nothing to attach it to) and answers `evaluatedWatermark: null,
   * evaluationRequired: enabled` — API changes' documented non-error path.
   */
  async resolveGate(
    userId: number,
    repoUrl: string,
    sessionId: string,
    promptWatermark: number,
  ): Promise<SessionAttributionGate> {
    const definitions = await this.resolveDefinitions(userId, repoUrl);

    // Open-source readiness: a session owned by another user is
    // answered exactly like a not-ingested one — no watermark write, no stored state read.
    const ownership = await this.resolveOwnedSessionRowId(sessionId, userId);
    const sessionRowId =
      ownership.status === 'ok' ? ownership.sessionRowId : null;
    if (sessionRowId === null) {
      return {
        enabled: definitions.enabled,
        attributes: definitions.attributes,
        evaluatedWatermark: null,
        evaluationRequired: definitions.enabled,
      };
    }

    await this.upsertPromptWatermark(sessionRowId, promptWatermark);
    const evaluatedWatermark = await this.loadEvaluatedWatermark(sessionRowId);
    const evaluationRequired =
      definitions.enabled && promptWatermark > (evaluatedWatermark ?? -1);

    return {
      enabled: definitions.enabled,
      attributes: definitions.attributes,
      evaluatedWatermark,
      evaluationRequired,
    };
  }

  /**
   * The single conditional-upsert statement: a fresh row always
   * inserts; a conflicting row only updates `WHERE excluded.prompt_watermark >
   * session_attribution.prompt_watermark`, so a stale (out-of-order or duplicate) result
   * loses to whatever newer watermark already won. `.returning()` comes back empty exactly
   * when the `setWhere` condition blocked the update — that IS the caller's "did this
   * apply" signal, no separate read-before-write needed.
   */
  async upsertValues(
    sessionRowId: number,
    promptWatermark: number,
    values: Record<string, string | string[] | boolean | number | null>,
  ): Promise<boolean> {
    const applied = await this.db
      .insert(sessionAttribution)
      .values({ sessionId: sessionRowId, promptWatermark, values })
      .onConflictDoUpdate({
        target: sessionAttribution.sessionId,
        set: {
          promptWatermark: sql`excluded.prompt_watermark`,
          values: sql`excluded.values`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`excluded.prompt_watermark > ${sessionAttribution.promptWatermark}`,
      })
      .returning({ sessionId: sessionAttribution.sessionId });

    return applied.length > 0;
  }

  /**
   * Append-only insert, one row per actual evaluation attempt — mirrors the advisor's
   * `recordRun()`. `invokingSessionId` is stored as a plain string, unresolved
   * — it exists purely for the Attribution Spend Executive Summary section's
   * join-back, never as a second ownership/FK check here.
   */
  async recordRun(input: RecordSessionAttributionRunInput): Promise<void> {
    await this.db.insert(sessionAttributionRuns).values({
      sessionId: input.sessionRowId,
      promptWatermark: input.promptWatermark,
      evalSessionId: input.evalSessionId ?? null,
      invokingSessionId: input.invokingSessionId ?? null,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: input.outcome,
      failureReason: input.failureReason ?? null,
      model: input.model ?? null,
      costUsd: input.costUsd != null ? input.costUsd.toFixed(6) : null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
    });
  }
}
