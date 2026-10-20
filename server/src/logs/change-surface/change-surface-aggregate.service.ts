/**
 * Change surface — the multi-session aggregation shared by the report and the chart.
 *
 * There is exactly **one** entry point, {@link ChangeSurfaceAggregateService.build}, and both
 * surfaces call it: the analytics chart with the range-derived bucket, the report with
 * `bucket: 'week'`. That is what makes report and chart never disagreeing structural
 * rather than a promise, even though the two render through different chart libraries.
 *
 * Grouping and bucketing **compose**: the loader tags every row with its root session's group
 * key and its `date_trunc` bucket in one pass, and the folds below run
 * `computeChangeSurface()` once per group, once per bucket and once per (group, bucket) — each
 * over its own subset. Every level is therefore a genuine union recomputation, never a rollup
 * of the level beneath it, because a union of unions is not a sum: two buckets that touched
 * the same file hold one file between them, not two.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import type { SessionAttributionAttributeDef } from '../../database/schema/index';
import {
  loadScopedRootSessions,
  type AnalyticsScope,
  type ScopedRootSession,
} from '../analytics/scoped-sessions.sql';
import {
  attributeGroupLabels,
  parseGroupByAttrKey,
} from '../attribute-filter.sql';
import { computeChangeSurface } from './change-surface-metrics';
import {
  CHANGE_SURFACE_BUCKET_THRESHOLDS,
  type ChangeSurfaceAggregate,
  type ChangeSurfaceBucket,
  type ChangeSurfaceBucketSize,
  type ChangeSurfaceTimelineBucket,
} from './change-surface.types';
import {
  loadScopeComputedFlags,
  loadScopedChangedPaths,
  type ScopedChangedPathFact,
} from './changed-paths.sql';

/** Same four-value shape `HarnessUsageGroupBy` uses, for the same four groupings. */
export type ChangeSurfaceGroupBy =
  | 'none'
  | 'branch'
  | 'user'
  | `attr:${string}`;

/**
 * `opts` is exactly what `resolveUsageScope()` returns (`reports.controller.ts`) plus the two
 * keys this feature adds — `groupBy` and `bucket` — mirroring `HarnessUsageOptions`. The date
 * range, branch/user lists and parsed attribute filters are consequently all **required**
 * (`AnalyticsScope` declares them so); the controller has already defaulted them.
 */
export interface ChangeSurfaceAggregateOptions extends AnalyticsScope {
  groupBy: ChangeSurfaceGroupBy;
  /** `'none'` folds the scope once and returns no series at all. */
  bucket: ChangeSurfaceBucketSize;
  /** Needed only for the `attr:<key>` grouping, exactly as in `harness-usage`. */
  resolvedAttributeDefinitions?: SessionAttributionAttributeDef[];
}

/** One group of the scope — a branch, a user or one attribute value. */
export interface ChangeSurfaceAggregateGroup {
  key: string;
  label: string;
  /** Root sessions in scope for this group, including those that changed nothing. */
  sessions: number;
  aggregate: ChangeSurfaceAggregate;
  /** Per-group series; empty when `bucket === 'none'`. */
  buckets: ChangeSurfaceBucket[];
}

export interface ChangeSurfaceAggregateResult {
  repo: ChangeSurfaceAggregate;
  /** Root sessions with at least one **in-repo** changed path. */
  sessionsWithChanges: number;
  /** Root sessions in scope that changed nothing in-repo — reported, never averaged in. */
  noChangeSessions: number;
  /** One per change-having session; the report's medians fold over these. */
  perSessionAggregates: ChangeSurfaceAggregate[];
  /** `null` when `groupBy === 'none'`. */
  groups: ChangeSurfaceAggregateGroup[] | null;
  /** Repo-wide series; empty when `bucket === 'none'`. */
  buckets: ChangeSurfaceBucket[];
  /**
   * `true` when the scope hit `CHANGE_SURFACE_MAX_SCOPE_ROWS` and the union below is a
   * prefix of the period rather than all of it. Never on the wire as
   * silence: the surfaces say "period too large — narrow the date range".
   */
  truncated: boolean;
}

/**
 * Range span -> bucket size, per {@link CHANGE_SURFACE_BUCKET_THRESHOLDS}: the first row whose
 * `maxSpanDays` the span does not exceed wins. An explicit, already-validated `bucket` from
 * the query string overrides it.
 */
export function resolveChangeSurfaceBucket(
  explicit: ChangeSurfaceTimelineBucket | undefined,
  startDate: Date,
  endDate: Date,
): ChangeSurfaceTimelineBucket {
  if (explicit !== undefined) return explicit;

  const spanDays =
    (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
  for (const threshold of CHANGE_SURFACE_BUCKET_THRESHOLDS) {
    if (spanDays <= threshold.maxSpanDays) return threshold.bucket;
  }
  // Unreachable — the table's last row is `Infinity` — but a total function beats a
  // non-null assertion if that table is ever edited.
  return 'week';
}

@Injectable()
export class ChangeSurfaceAggregateService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async build(
    repoIds: number[],
    opts: ChangeSurfaceAggregateOptions,
  ): Promise<ChangeSurfaceAggregateResult> {
    const roots = await loadScopedRootSessions(this.db, repoIds, opts);
    const grouped = opts.groupBy !== 'none';
    if (roots.length === 0) return emptyResult(grouped);

    const rootIds = roots.map((root) => root.sessionRowId);
    const groupKeyByRootId = grouped
      ? await this.resolveGroupKeys(roots, opts)
      : null;

    const [computedFlags, scoped] = await Promise.all([
      loadScopeComputedFlags(this.db, rootIds),
      loadScopedChangedPaths(this.db, {
        rootSessionIds: rootIds,
        groupKeyByRootId,
        bucket: opts.bucket,
      }),
    ]);

    const facts = scoped.facts;
    const anyComputed = (ids: Iterable<number>): boolean => {
      for (const id of ids) if (computedFlags.get(id) === true) return true;
      return false;
    };

    const repo = computeChangeSurface(facts, {
      computed: anyComputed(rootIds),
    });

    // Per session — the report's median population. A root with no in-repo path is not a
    // `0`-concentration session, it is a session the medians must not see at all.
    const perSessionAggregates: ChangeSurfaceAggregate[] = [];
    for (const [rootId, rootFacts] of groupBy(facts, (f) => f.rootSessionId)) {
      const aggregate = computeChangeSurface(rootFacts, {
        computed: computedFlags.get(rootId) === true,
      });
      if (aggregate.changedFiles > 0) perSessionAggregates.push(aggregate);
    }

    return {
      repo,
      sessionsWithChanges: perSessionAggregates.length,
      noChangeSessions: roots.length - perSessionAggregates.length,
      perSessionAggregates,
      groups:
        groupKeyByRootId === null
          ? null
          : this.buildGroups(roots, facts, groupKeyByRootId, computedFlags),
      buckets: buildBuckets(facts),
      truncated: scoped.truncated,
    };
  }

  /**
   * One group per distinct key, seeded from the **root sessions** rather than from the facts
   * so a branch whose sessions changed nothing still renders its (zero) row — the same rule
   * `harness-usage`'s `buildGroups()` applies, and the reason `sessions` counts roots in
   * scope, not roots that happened to touch a file.
   */
  private buildGroups(
    roots: readonly ScopedRootSession[],
    facts: readonly ScopedChangedPathFact[],
    groupKeyByRootId: ReadonlyMap<number, string[]>,
    computedFlags: ReadonlyMap<number, boolean>,
  ): ChangeSurfaceAggregateGroup[] {
    const rootIdsByGroup = new Map<string, number[]>();
    for (const root of roots) {
      // A `string[]`-typed attribute fans one root into every one of its resolved values'
      // groups — the root is seeded into each, not just the first.
      const keys = groupKeyByRootId.get(root.sessionRowId) ?? [UNGROUPED];
      for (const key of keys) {
        const existing = rootIdsByGroup.get(key);
        if (existing) existing.push(root.sessionRowId);
        else rootIdsByGroup.set(key, [root.sessionRowId]);
      }
    }

    const factsByGroup = groupBy(
      facts,
      // `fact.groupKey` already carries the fanned value from `changed-paths.sql.ts`'s
      // flattened `VALUES` join — this fallback never fires while
      // grouping is active, so `[0]` is only there to keep the type honest.
      (fact) =>
        fact.groupKey ??
        groupKeyByRootId.get(fact.rootSessionId)?.[0] ??
        UNGROUPED,
    );

    return [...rootIdsByGroup.entries()]
      .map(([key, groupRootIds]) => {
        const groupFacts = factsByGroup.get(key) ?? [];
        return {
          key,
          // Branch/user/attribute keys are already the display text (`attributeGroupLabels()`
          // resolves `Unattributed`/`Not determined` for the attribute form), so there is no
          // second lookup to keep in sync here.
          label: key,
          sessions: groupRootIds.length,
          aggregate: computeChangeSurface(groupFacts, {
            computed: groupRootIds.some((id) => computedFlags.get(id) === true),
          }),
          buckets: buildBuckets(groupFacts),
        };
      })
      .sort(
        (a, b) =>
          b.aggregate.changedFiles - a.aggregate.changedFiles ||
          a.key.localeCompare(b.key),
      );
  }

  /**
   * The per-**root** group tag every descendant inherits.
   *
   * Tagging by the root's branch/user (not by each descendant's own) is what attributes a
   * sub-agent's edits to the session that spawned it — the same attribution
   * `reports/harness-usage.service.ts`'s `loadUsageFacts()`/`buildGroups()` pair performs,
   * and the only one that makes a grouped total comparable with the ungrouped one.
   */
  private async resolveGroupKeys(
    roots: readonly ScopedRootSession[],
    opts: ChangeSurfaceAggregateOptions,
  ): Promise<Map<number, string[]>> {
    const attrKey = parseGroupByAttrKey(opts.groupBy);
    const attributionValues =
      attrKey !== undefined
        ? await this.loadAttributionValues(roots)
        : new Map<number, AttributionValues>();

    const keys = new Map<number, string[]>();
    for (const root of roots) {
      if (attrKey !== undefined) {
        // Fan-out: a `string[]`-typed attribute's N values become N
        // labels here, one per resolved value, rather than one joined bucket.
        keys.set(
          root.sessionRowId,
          attributeGroupLabels(
            attrKey,
            attributionValues.get(root.sessionRowId) ?? null,
            opts.resolvedAttributeDefinitions ?? [],
          ),
        );
        continue;
      }
      keys.set(root.sessionRowId, [
        opts.groupBy === 'branch'
          ? (root.branch ?? 'no branch')
          : root.userEmail,
      ]);
    }
    return keys;
  }

  /**
   * `session_attribution.values` for the roots in scope — the one extra lookup the
   * `attr:<key>` grouping needs, fetched only for that grouping (a copy of
   * `HarnessUsageService.loadAttributionValues()`, which is private to that service).
   */
  private async loadAttributionValues(
    roots: readonly ScopedRootSession[],
  ): Promise<Map<number, AttributionValues>> {
    const idsLiteral = `{${roots.map((root) => root.sessionRowId).join(',')}}`;
    const result = await this.db.execute(sql`
      SELECT session_id AS session_row_id, values
      FROM session_attribution
      WHERE session_id = ANY(${idsLiteral}::bigint[])
    `);

    const map = new Map<number, AttributionValues>();
    for (const row of result.rows as unknown as {
      session_row_id: string | number;
      values: AttributionValues;
    }[]) {
      map.set(Number(row.session_row_id), row.values);
    }
    return map;
  }
}

type AttributionValues = Record<
  string,
  string | string[] | boolean | number | null
>;

/** Key for a root session that somehow carries no group tag — never expected, never thrown. */
const UNGROUPED = 'no group';

/** Stable `Map`-of-arrays fold; insertion order is the caller's row order. */
function groupBy<T, K>(
  items: readonly T[],
  keyOf: (item: T) => K,
): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = map.get(key);
    if (existing) existing.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/**
 * One point per `date_trunc` boundary, ascending.
 *
 * Buckets are derived from the fact rows, so a bucket exists only where something was
 * changed — `sessions` therefore counts the *change-having* roots in it, and `sessionIds`
 * carries their transcript ids for the chart's bar -> `SessionModal` click-through. A bucket
 * whose rows were all outside the repo keeps a `null` concentration and renders as `n/a`,
 * never as a `0` bar.
 */
function buildBuckets(
  facts: readonly ScopedChangedPathFact[],
): ChangeSurfaceBucket[] {
  const byBucket = new Map<string, ScopedChangedPathFact[]>();
  for (const fact of facts) {
    const bucketStart = fact.bucketStart;
    if (bucketStart === null) continue;
    const existing = byBucket.get(bucketStart);
    if (existing) existing.push(fact);
    else byBucket.set(bucketStart, [fact]);
  }

  return [...byBucket.entries()]
    .map(([bucketStart, bucketFacts]) => {
      const aggregate = computeChangeSurface(bucketFacts);
      const sessionIds = [
        ...new Set(bucketFacts.map((fact) => fact.rootSessionKey)),
      ].sort();
      return {
        bucketStart,
        sessions: sessionIds.length,
        sessionIds,
        concentration: aggregate.concentration,
        changedFiles: aggregate.changedFiles,
        foldersTouched: aggregate.foldersTouched,
        topLevelModules: aggregate.topLevelModules.length,
        linesAdded: aggregate.linesAdded,
        linesRemoved: aggregate.linesRemoved,
      };
    })
    .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
}

/** No sessions in scope at all: not computed, no groups' worth of rows, no series. */
function emptyResult(grouped: boolean): ChangeSurfaceAggregateResult {
  return {
    repo: computeChangeSurface([], { computed: false }),
    sessionsWithChanges: 0,
    noChangeSessions: 0,
    perSessionAggregates: [],
    groups: grouped ? [] : null,
    buckets: [],
    truncated: false,
  };
}
