/**
 * Change surface — the report.
 *
 * This service assembles only; it computes no metric of its own. Every number it returns
 * comes out of `ChangeSurfaceAggregateService.build()` — the same call, with the same
 * arguments, that the analytics chart makes — which is what makes the report and the chart
 * incapable of disagreeing. The report simply asks for
 * `bucket: 'week'` and reads both its tables and its "Concentration per week" chart off that
 * one result.
 *
 * What it does add is the two things only a report has: exact medians over the sessions that
 * actually changed something, and the `%`-of-codebase indicators divided
 * by the `repo_code_inventory` snapshot that was current *at the end of the report's own
 * period*.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import type { SessionAttributionAttributeDef } from '../../database/schema/index';
import type { AnalyticsScope } from '../analytics/scoped-sessions.sql';
import {
  ChangeSurfaceAggregateService,
  type ChangeSurfaceGroupBy,
} from '../change-surface/change-surface-aggregate.service';
import type {
  ChangeSurfaceAggregate,
  ChangeSurfaceInventory,
  ChangeSurfaceMedians,
  ChangeSurfaceReportData,
} from '../change-surface/change-surface.types';
import { findInventoryAtOrBefore } from '../change-surface/repo-code-inventory';

/** `resolveUsageScope()`'s shape plus `groupBy` — the bucket is fixed at `week` here. */
export interface ChangeSurfaceReportOptions extends AnalyticsScope {
  groupBy: ChangeSurfaceGroupBy;
  resolvedAttributeDefinitions?: SessionAttributionAttributeDef[];
}

@Injectable()
export class ChangeSurfaceReportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly aggregateService: ChangeSurfaceAggregateService,
  ) {}

  async build(
    repoIds: number[],
    opts: ChangeSurfaceReportOptions,
  ): Promise<ChangeSurfaceReportData> {
    const [aggregate, inventories] = await Promise.all([
      this.aggregateService.build(repoIds, { ...opts, bucket: 'week' }),
      findInventoryAtOrBefore(this.db, repoIds, opts.endDate),
    ]);

    const inventory = newestInventory([...inventories.values()]);

    return {
      repo: aggregate.repo,
      sessionsWithChanges: aggregate.sessionsWithChanges,
      noChangeSessions: aggregate.noChangeSessions,
      perSessionMedian: medianOf(aggregate.perSessionAggregates),
      inventory,
      shareOfTrackedFiles: shareOfFiles(aggregate.repo, inventory),
      shareOfTrackedLines: shareOfLines(aggregate.repo, inventory),
      groups:
        aggregate.groups === null
          ? null
          : aggregate.groups.map((group) => ({
              key: group.key,
              label: group.label,
              sessions: group.sessions,
              aggregate: group.aggregate,
              shareOfTrackedFiles: shareOfFiles(group.aggregate, inventory),
            })),
      buckets: aggregate.buckets.map((bucket) => ({
        bucketStart: bucket.bucketStart,
        sessions: bucket.sessions,
        concentration: bucket.concentration,
      })),
      truncated: aggregate.truncated,
    };
  }
}

/**
 * The newest snapshot across the repo ids in scope.
 *
 * `resolveRepoIds()` returns the *same* repository as seen through several team rows, so
 * these snapshots all describe one codebase and the freshest one is the right denominator —
 * summing them would multiply the codebase by the number of links.
 */
function newestInventory(
  snapshots: readonly ChangeSurfaceInventory[],
): ChangeSurfaceInventory | null {
  let newest: ChangeSurfaceInventory | null = null;
  for (const snapshot of snapshots) {
    if (newest === null || snapshot.capturedAt > newest.capturedAt) {
      newest = snapshot;
    }
  }
  return newest;
}

/**
 * `null` — never `0` — when there is no snapshot to divide by: the report renders
 * "n/a · denominator unavailable", because "we don't know how big the repo is" and "you
 * touched none of it" are opposite statements.
 */
function shareOfFiles(
  aggregate: ChangeSurfaceAggregate,
  inventory: ChangeSurfaceInventory | null,
): number | null {
  if (inventory === null || inventory.trackedFiles <= 0) return null;
  return aggregate.changedFiles / inventory.trackedFiles;
}

/** `lines_added` only — the line family's numerator. */
function shareOfLines(
  aggregate: ChangeSurfaceAggregate,
  inventory: ChangeSurfaceInventory | null,
): number | null {
  if (inventory === null || inventory.trackedLines <= 0) return null;
  return aggregate.linesAdded / inventory.trackedLines;
}

/**
 * Exact medians over the change-having sessions.
 *
 * Exact, not interpolated: the report holds every session's own aggregate, so the `≈`
 * convention that governs bucket-derived repository medians elsewhere does not apply here.
 * Zero-change sessions are excluded by the caller (they never enter
 * `perSessionAggregates`) and surface separately as `noChangeSessions`, so they cannot drag
 * a team's typical spread towards a `0` nobody worked on.
 */
function medianOf(
  aggregates: readonly ChangeSurfaceAggregate[],
): ChangeSurfaceMedians | null {
  if (aggregates.length === 0) return null;

  return {
    changedFiles: lowerMedian(aggregates.map((a) => a.changedFiles)) ?? 0,
    foldersTouched: lowerMedian(aggregates.map((a) => a.foldersTouched)) ?? 0,
    // Every change-having session has a concentration by construction, so this is only
    // `null` in the impossible empty case the guard above already excluded.
    concentration: lowerMedian(
      aggregates
        .map((a) => a.concentration)
        .filter((value): value is number => value !== null),
    ),
    filesPerFolder:
      lowerMedian(
        aggregates
          .map((a) => a.filesPerFolder)
          .filter((value): value is number => value !== null),
      ) ?? 0,
    topLevelModules:
      lowerMedian(aggregates.map((a) => a.topLevelModules.length)) ?? 0,
    folderEntropyNorm:
      lowerMedian(
        aggregates
          .map((a) => a.folderEntropyNorm)
          .filter((value): value is number => value !== null),
      ) ?? 0,
    singleFileFolderShare:
      lowerMedian(
        aggregates.map((a) =>
          a.foldersTouched === 0 ? 0 : a.singleFileFolders / a.foldersTouched,
        ),
      ) ?? 0,
  };
}

/**
 * The lower median: for an even count the smaller of the two middle values, never their
 * average. Averaging would invent a value no session had — the same reason the report's
 * other per-session figures are exact.
 */
function lowerMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}
