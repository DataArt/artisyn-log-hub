import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import type {
  SessionAttributionAttributeDef,
  SessionAttributionAttributeType,
} from '../../database/schema/index';
import {
  scopedUserFilterSql,
  textList,
} from '../analytics/scoped-sessions.sql';
import {
  attributeFilterSql,
  isOrphanedValue,
  type ParsedAttributeFilter,
} from '../attribute-filter.sql';
import { loadTreeCostRows, readTreeCost } from '../session-tree-cost.sql';
import type { TeamScope } from '../team-scope';

/**
 * Attribution Breakdown report.
 *
 * Copies `cache-read-ratio.service.ts`'s two-phase shape rather than inventing a new report
 * architecture: Phase A is a cheap scan of every eligible session plus its whole
 * `session_attribution.values` object; Phase B is the complete computed tree cost
 * (`loadTreeCostRows`, own + sub-agents + utility calls; null when any part is unpriced)
 * keyed on Phase A's `session_row_id`s, the same cost every other surface shows. Every
 * per-attribute section is then built in TS from the merged per-session rows, using the
 * fixed per-type layout.
 */

/** Ranked-table cutoff — the 16th+ distinct value collapses into "Other". */
export const ATTRIBUTION_BREAKDOWN_TOP_N = 15;

export interface AttributionBreakdownRow {
  /** The stringified attribute value, or one of the fixed labels `'Other'` / `'Not determined'` / `'Unattributed'`. */
  value: string;
  sessionCount: number;
  /**
   * Against the report's total in-scope session count (never this one attribute's own
   * total) — so a `string[]` section's rows can legitimately sum above 1 (the
   * fan-out caveat, surfaced via {@link AttributionBreakdownSection.fanOut}).
   */
  share: number;
  costUsd: number;
}

export interface AttributionBreakdownSection {
  key: string;
  label: string;
  type: SessionAttributionAttributeType;
  /** `true` only for `string[]` — one session can land in several rows at once. */
  fanOut: boolean;
  rows: AttributionBreakdownRow[];
}

export interface AttributionBreakdownReportData {
  totalSessionCount: number;
  totalCostUsd: number;
  /**
   * Sessions in scope carrying at least one orphaned attribute value
   * (`isOrphanedValue()`) — a report-level disclosure count, computed independently of the
   * per-section rows (an orphaned value already folds into that key's own "Not determined"
   * row; this count is "how many sessions were affected by that fold at all").
   */
  orphanedSessionCount: number;
  sections: AttributionBreakdownSection[];
}

export interface AttributionBreakdownOptions {
  teamId?: number;
  requesterUserId: number;
  /** The caller's resolved team access-mode scope — see `AnalyticsScope.scope`. */
  scope: TeamScope;
  startDate: Date;
  endDate: Date;
  branches: string[];
  users: string[];
  /** Applied to Phase A. */
  attributeFilters: ParsedAttributeFilter[];
  resolvedAttributeDefinitions: SessionAttributionAttributeDef[];
}

type AttributionValues = Record<
  string,
  string | string[] | boolean | number | null
>;

/** One merged (Phase A + Phase B) session row — the single input every section builder reads. */
interface AttributionSessionRow {
  costUsd: number;
  attributionValues: AttributionValues | null;
}

// --- Raw SQL row shapes -----------------------------------------------------------------

interface PhaseARow {
  session_row_id: string | number;
  attribution_values: AttributionValues | null;
}

// --- Pure helpers (exported for unit tests) ----------------------------------------------

/**
 * Report-level orphan disclosure: a session counts once here as soon
 * as ANY key in its stored `values` object is orphaned against `resolvedDefinitions` —
 * independent of, and never double-applied on top of, the per-section "Not determined" fold
 * each key's own row already performs.
 */
export function computeOrphanedSessionCount(
  rows: AttributionSessionRow[],
  resolvedDefinitions: SessionAttributionAttributeDef[],
): number {
  let count = 0;
  for (const row of rows) {
    if (row.attributionValues === null) continue;
    const hasOrphan = Object.entries(row.attributionValues).some(
      ([key, value]) => isOrphanedValue(key, value, resolvedDefinitions),
    );
    if (hasOrphan) count += 1;
  }
  return count;
}

/**
 * `boolean` layout: exactly 4 fixed rows, no ranking — `true`, `false`,
 * "Not determined" (row exists but this key is `null`/absent/orphaned) and "Unattributed"
 * (no `session_attribution` row at all for the session).
 */
function buildBooleanSection(
  def: SessionAttributionAttributeDef,
  rows: AttributionSessionRow[],
  resolvedDefinitions: SessionAttributionAttributeDef[],
  totalSessionCount: number,
): AttributionBreakdownSection {
  let trueCount = 0;
  let trueCost = 0;
  let falseCount = 0;
  let falseCost = 0;
  let notDeterminedCount = 0;
  let notDeterminedCost = 0;
  let unattributedCount = 0;
  let unattributedCost = 0;

  for (const row of rows) {
    if (row.attributionValues === null) {
      unattributedCount += 1;
      unattributedCost += row.costUsd;
      continue;
    }

    const raw = row.attributionValues[def.key];
    if (
      raw === undefined ||
      raw === null ||
      isOrphanedValue(def.key, raw, resolvedDefinitions)
    ) {
      notDeterminedCount += 1;
      notDeterminedCost += row.costUsd;
      continue;
    }

    if (raw === true) {
      trueCount += 1;
      trueCost += row.costUsd;
    } else {
      falseCount += 1;
      falseCost += row.costUsd;
    }
  }

  const share = (count: number): number =>
    totalSessionCount > 0 ? count / totalSessionCount : 0;

  return {
    key: def.key,
    label: def.label,
    type: def.type,
    fanOut: false,
    rows: [
      {
        value: 'true',
        sessionCount: trueCount,
        share: share(trueCount),
        costUsd: trueCost,
      },
      {
        value: 'false',
        sessionCount: falseCount,
        share: share(falseCount),
        costUsd: falseCost,
      },
      {
        value: 'Not determined',
        sessionCount: notDeterminedCount,
        share: share(notDeterminedCount),
        costUsd: notDeterminedCost,
      },
      {
        value: 'Unattributed',
        sessionCount: unattributedCount,
        share: share(unattributedCount),
        costUsd: unattributedCost,
      },
    ],
  };
}

/**
 * `string`/`number`/`string[]` layout: ranked table, top 15 by session
 * count, tail collapsed into one "Other" row (summed sessions/share/cost). `string[]` fans
 * out — each session's deduplicated array elements each contribute to their own value's
 * bucket, so the section's rows can legitimately sum above the report's total session count
 * (`fanOut: true` discloses this). "Not determined"/"Unattributed" are always their own rows,
 * appended after "Other", never folded into it.
 */
function buildRankedSection(
  def: SessionAttributionAttributeDef,
  rows: AttributionSessionRow[],
  resolvedDefinitions: SessionAttributionAttributeDef[],
  totalSessionCount: number,
): AttributionBreakdownSection {
  const valueCounts = new Map<string, { count: number; cost: number }>();
  let notDeterminedCount = 0;
  let notDeterminedCost = 0;
  let unattributedCount = 0;
  let unattributedCost = 0;

  for (const row of rows) {
    if (row.attributionValues === null) {
      unattributedCount += 1;
      unattributedCost += row.costUsd;
      continue;
    }

    const raw = row.attributionValues[def.key];
    if (
      raw === undefined ||
      raw === null ||
      isOrphanedValue(def.key, raw, resolvedDefinitions)
    ) {
      notDeterminedCount += 1;
      notDeterminedCost += row.costUsd;
      continue;
    }

    const values =
      def.type === 'string[]' && Array.isArray(raw)
        ? Array.from(new Set(raw.map((v) => String(v))))
        : [String(raw)];

    if (values.length === 0) {
      // An explicitly-empty `string[]` value carries no element to bucket — treated the
      // same as "not determined", matching `isnull`'s own empty-array rule.
      notDeterminedCount += 1;
      notDeterminedCost += row.costUsd;
      continue;
    }

    for (const value of values) {
      const entry = valueCounts.get(value) ?? { count: 0, cost: 0 };
      entry.count += 1;
      entry.cost += row.costUsd;
      valueCounts.set(value, entry);
    }
  }

  const share = (count: number): number =>
    totalSessionCount > 0 ? count / totalSessionCount : 0;

  const ranked = Array.from(valueCounts.entries())
    .map(([value, { count, cost }]) => ({
      value,
      sessionCount: count,
      share: share(count),
      costUsd: cost,
    }))
    // Ties break on the value itself: Phase A's scan has no ORDER BY, so without this a
    // tie's order (and which tied value falls past the top-N cutoff) depends on row order.
    // A plain code-unit compare, not localeCompare, so the order does not depend on the ICU locale.
    .sort(
      (a, b) =>
        b.sessionCount - a.sessionCount ||
        (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    );

  const top = ranked.slice(0, ATTRIBUTION_BREAKDOWN_TOP_N);
  const tail = ranked.slice(ATTRIBUTION_BREAKDOWN_TOP_N);

  const rowsOut: AttributionBreakdownRow[] = [...top];
  if (tail.length > 0) {
    const otherCount = tail.reduce((sum, r) => sum + r.sessionCount, 0);
    const otherCost = tail.reduce((sum, r) => sum + r.costUsd, 0);
    rowsOut.push({
      value: 'Other',
      sessionCount: otherCount,
      share: share(otherCount),
      costUsd: otherCost,
    });
  }
  rowsOut.push({
    value: 'Not determined',
    sessionCount: notDeterminedCount,
    share: share(notDeterminedCount),
    costUsd: notDeterminedCost,
  });
  rowsOut.push({
    value: 'Unattributed',
    sessionCount: unattributedCount,
    share: share(unattributedCount),
    costUsd: unattributedCost,
  });

  return {
    key: def.key,
    label: def.label,
    type: def.type,
    fanOut: def.type === 'string[]',
    rows: rowsOut,
  };
}

/** Dispatches to the fixed per-type layout. */
export function buildAttributionSection(
  def: SessionAttributionAttributeDef,
  rows: AttributionSessionRow[],
  resolvedDefinitions: SessionAttributionAttributeDef[],
  totalSessionCount: number,
): AttributionBreakdownSection {
  return def.type === 'boolean'
    ? buildBooleanSection(def, rows, resolvedDefinitions, totalSessionCount)
    : buildRankedSection(def, rows, resolvedDefinitions, totalSessionCount);
}

@Injectable()
export class AttributionBreakdownService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async build(
    repoIds: number[],
    opts: AttributionBreakdownOptions,
  ): Promise<AttributionBreakdownReportData> {
    const rows = await this.loadSessionRows(repoIds, opts);

    const totalSessionCount = rows.length;
    const totalCostUsd = rows.reduce((sum, r) => sum + r.costUsd, 0);
    const orphanedSessionCount = computeOrphanedSessionCount(
      rows,
      opts.resolvedAttributeDefinitions,
    );

    const sections = opts.resolvedAttributeDefinitions.map((def) =>
      buildAttributionSection(
        def,
        rows,
        opts.resolvedAttributeDefinitions,
        totalSessionCount,
      ),
    );

    return { totalSessionCount, totalCostUsd, orphanedSessionCount, sections };
  }

  /**
   * Phase A (cheap scan) then Phase B (cost rollup), the two-phase shape.
   * Two round trips regardless of how many sessions the range holds.
   */
  private async loadSessionRows(
    repoIds: number[],
    opts: AttributionBreakdownOptions,
  ): Promise<AttributionSessionRow[]> {
    const repoIdsLiteral = `{${repoIds.join(',')}}`;
    // Team access mode — the ids this caller may read; nothing at all in a
    // `transparent` team. See `scopedUserFilterSql`.
    const ownerFilter = scopedUserFilterSql(opts.scope, 'l');
    const branchFilter =
      opts.branches.length > 0
        ? sql`AND COALESCE(l.git_branch, 'no branch') IN (${textList(opts.branches)})`
        : sql``;
    const userFilter =
      opts.users.length > 0
        ? sql`AND u.email IN (${textList(opts.users)})`
        : sql``;
    const attrCondition = attributeFilterSql(opts.attributeFilters, sql`s.id`);
    const attrFilter = attrCondition ? sql`AND ${attrCondition}` : sql``;

    // Phase A — eligible sessions with their whole
    // `session_attribution.values` object — a session with no
    // attribution row still gets its own Phase A row, with `attribution_values: null`
    // (the "Unattributed" bucket).
    const result = await this.db.execute(sql`
      SELECT
        s.id                                AS session_row_id,
        sa.values                           AS attribution_values
      FROM sessions s
      INNER JOIN logs l ON l.session_id = s.id
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      INNER JOIN users u ON u.id = l.user_id
      LEFT JOIN session_attribution sa ON sa.session_id = s.id
      WHERE lr.repo_id = ANY(${repoIdsLiteral}::int[])
        AND l.log_type = 'artisyn'
        AND l.first_prompt IS NOT NULL
        AND s.deleted = false
        AND EXISTS (
          SELECT 1 FROM logs cl
          WHERE cl.session_id = l.session_id AND cl.log_type = 'claude'
        )
        AND l.start_time >= ${opts.startDate}
        AND l.start_time <= ${opts.endDate}
        ${ownerFilter}
        ${branchFilter}
        ${userFilter}
        ${attrFilter}
    `);

    const phaseARows = result.rows as unknown as PhaseARow[];
    if (phaseARows.length === 0) return [];

    // Phase B — the complete computed tree cost (own + sub-agents + utility calls,
    // session-tree-cost.sql.ts), keyed on Phase A's session_row_ids. An unpriced session
    // (null cost) adds nothing to any bucket.
    const treeCosts = await loadTreeCostRows(
      this.db,
      phaseARows.map((r) => Number(r.session_row_id)),
    );

    return phaseARows.map((r) => ({
      costUsd: readTreeCost(treeCosts.get(Number(r.session_row_id))).total ?? 0,
      attributionValues: r.attribution_values ?? null,
    }));
  }
}
