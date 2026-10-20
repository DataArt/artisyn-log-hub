import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { sessionHarnessUsage } from '../database/schema/index';

/** Matches `session_harness_usage.name VARCHAR(255)` / `mcp_server VARCHAR(128)`. */
const MAX_NAME_LENGTH = 255;
const MAX_MCP_SERVER_LENGTH = 128;

export interface SessionHarnessUsageRow {
  kind: 'tool' | 'skill' | 'rule';
  name: string;
  /** Non-null only for `kind: 'tool'` rows sourced from an MCP server. */
  mcpServer?: string | null;
  uses: number;
  inputTokens: number;
  outputTokens: number;
  /** Meaningful only for `kind: 'tool'`; `null`/absent for skill/rule. */
  isInitial?: boolean | null;
}

/**
 * Truncates `name`/`mcpServer` to their stored column widths and merges any rows that
 * collide after truncation, mirroring `session-tool-stats-writer.ts`'s
 * `mergeByStoredToolName` — otherwise a collision would violate the
 * `(session_id, kind, name)` unique index and fail the whole batch.
 */
function mergeByStoredIdentity(
  rows: SessionHarnessUsageRow[],
): SessionHarnessUsageRow[] {
  const merged = new Map<string, SessionHarnessUsageRow>();
  for (const row of rows) {
    const name = row.name.slice(0, MAX_NAME_LENGTH);
    const mcpServer =
      row.mcpServer != null
        ? row.mcpServer.slice(0, MAX_MCP_SERVER_LENGTH)
        : (row.mcpServer ?? null);
    const key = `${row.kind}\0${name}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...row, name, mcpServer });
      continue;
    }
    existing.uses += row.uses;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
  }
  return [...merged.values()];
}

/**
 * Replaces ALL of a session's `session_harness_usage` rows (`tool`/`skill`/`rule` kinds
 * alike) — delete-then-insert per session, mirroring `session-tool-stats-writer.ts`:
 * the set of tools/skills/rules a session's transcript shows evidence
 * of can *shrink* when its `claude` log is re-extracted, and an upsert would leave stale
 * rows behind for ones that no longer appear.
 *
 * `skill`/`rule`-kind rows come from real transcript trigger events now
 * (`extractHarnessSkillAndRuleUsage` — superseding the original rule,
 * which wrote them from the artisyn self-report instead), computed in the same
 * `claude`/`claude-subagent` branch as `tool`-kind rows, so a single per-session delete
 * covering every kind is correct — there is no other writer for this table anymore.
 */
export async function upsertSessionHarnessUsageRows(
  tx: DrizzleDb,
  sessionRowId: number,
  rows: SessionHarnessUsageRow[],
): Promise<void> {
  await tx
    .delete(sessionHarnessUsage)
    .where(eq(sessionHarnessUsage.sessionId, sessionRowId));

  if (rows.length === 0) return;

  // One multi-row INSERT, not one per row — same round-trip-cost reasoning as
  // `session-tool-stats-writer.ts`.
  await tx.insert(sessionHarnessUsage).values(
    mergeByStoredIdentity(rows).map((row) => ({
      sessionId: sessionRowId,
      kind: row.kind,
      name: row.name,
      mcpServer: row.mcpServer ?? null,
      uses: row.uses,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      isInitial: row.isInitial ?? null,
    })),
  );
}
