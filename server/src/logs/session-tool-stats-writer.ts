import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { sessionToolStats } from '../database/schema/index';
import type { ToolStatRow } from './tool-stats';

/** Matches `session_tool_stats.tool_name VARCHAR(128)`. */
const MAX_TOOL_NAME_LENGTH = 128;

/**
 * Replaces a session's `session_tool_stats` rows.
 *
 * Delete-then-insert rather than an upsert, mirroring how the file-stats path rebuilds its
 * rows: the set of tools a session used can *shrink* when a log is re-extracted (a longer
 * body replacing a shorter one, or a recompute after an extractor fix), and an upsert would
 * leave stale rows for tools that no longer appear. Both callers already run inside the
 * upload/recompute transaction, so the gap between the delete and the insert is never
 * visible to a reader.
 */
export async function upsertSessionToolStatsRows(
  db: DrizzleDb,
  sessionRowId: number,
  rows: ToolStatRow[],
): Promise<void> {
  await db
    .delete(sessionToolStats)
    .where(eq(sessionToolStats.sessionId, sessionRowId));

  if (rows.length === 0) return;

  // One multi-row INSERT, not one per tool: a session routinely uses 15+ tools, and a
  // statement per row cost ~10ms of round trips on the `logs:upsert` perf scenario.
  await db.insert(sessionToolStats).values(
    mergeByStoredToolName(rows).map((row) => ({
      sessionId: sessionRowId,
      toolName: row.toolName,
      calls: row.calls,
      failures: row.failures,
      unresolved: row.unresolved,
      durationCoveredCalls: row.durationCoveredCalls,
      durationMsTotal: row.durationMsTotal,
      durationMsMax: row.durationMsMax,
      durationMsHistogram: row.durationMsHistogram,
      durationBySource: row.durationBySource,
      parallelBatchCalls: row.parallelBatchCalls,
    })),
  );
}

/**
 * Truncates tool names to the stored width and merges any that collide.
 *
 * Two distinct MCP tool names can share their first 128 characters. Truncating without
 * merging would then violate `session_tool_stats_session_tool_unique` and fail the whole
 * upload, so the colliding rows are summed instead.
 */
function mergeByStoredToolName(rows: ToolStatRow[]): ToolStatRow[] {
  const merged = new Map<string, ToolStatRow>();

  for (const row of rows) {
    const toolName = row.toolName.slice(0, MAX_TOOL_NAME_LENGTH);
    const existing = merged.get(toolName);
    if (existing === undefined) {
      merged.set(toolName, { ...row, toolName });
      continue;
    }

    existing.calls += row.calls;
    existing.failures += row.failures;
    existing.unresolved += row.unresolved;
    existing.durationCoveredCalls += row.durationCoveredCalls;
    existing.durationMsTotal += row.durationMsTotal;
    existing.durationMsMax = Math.max(
      existing.durationMsMax,
      row.durationMsMax,
    );
    existing.parallelBatchCalls += row.parallelBatchCalls;
    existing.durationMsHistogram = existing.durationMsHistogram.map(
      (count, index) => count + (row.durationMsHistogram[index] ?? 0),
    );
    existing.durationBySource = { ...existing.durationBySource };
    for (const [source, count] of Object.entries(row.durationBySource)) {
      existing.durationBySource[source as keyof typeof row.durationBySource] =
        (existing.durationBySource[
          source as keyof typeof row.durationBySource
        ] ?? 0) + count;
    }
  }

  return [...merged.values()];
}
