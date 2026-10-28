/**
 * Tools/MCP monitoring — writer of `repositories.tool_wrap_status` (impl-plan DD-20).
 *
 * Called by the tree rebuild (DD-8) for every repository row linked to the tree root's
 * `artisyn` log, when the tree has a `tool-calls` log. The stored value is the hook's last
 * `tool_wrap_status` report — the newest `reportedAt` wins, so an older tree rebuilt later never
 * overwrites a newer report — plus, per tool, the latest wrapper record start (`lastWrapperAt`,
 * max over every rebuild that ever saw the tool).
 */
import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  repositories,
  type ToolWrapStatusJson,
} from '../../database/schema/index';
import type { WrapperCallRecord, WrapperStatusLine } from './tool-calls-log';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored value usable as the merge base, else null. */
function readStored(value: unknown): ToolWrapStatusJson | null {
  return isRecord(value) && typeof value['reportedAt'] === 'string'
    ? (value as unknown as ToolWrapStatusJson)
    : null;
}

function laterOf(a: string | null | undefined, b: string): string {
  return typeof a === 'string' && a >= b ? a : b;
}

/**
 * The merged status (rules above), or null when there is nothing to store: no report so far and
 * none in this tree. Pure.
 */
export function mergeToolWrapStatus(
  existing: ToolWrapStatusJson | null,
  parsedStatus: WrapperStatusLine | null,
  calls: readonly WrapperCallRecord[],
): ToolWrapStatusJson | null {
  let base: Omit<ToolWrapStatusJson, 'tools'> | null = null;
  if (
    parsedStatus !== null &&
    (existing === null || parsedStatus.at >= existing.reportedAt)
  ) {
    base = {
      hookVersion: parsedStatus.hookVersion,
      os: parsedStatus.os,
      preflight: {
        ok: parsedStatus.preflight.ok,
        reason: parsedStatus.preflight.reason,
        shells: { ...parsedStatus.preflight.shells },
      },
      breaker: {
        global: parsedStatus.breaker.global,
        tools: [...parsedStatus.breaker.tools],
      },
      reportedAt: parsedStatus.at,
    };
  } else if (existing !== null) {
    base = {
      hookVersion: existing.hookVersion,
      os: existing.os,
      preflight: existing.preflight,
      breaker: existing.breaker,
      reportedAt: existing.reportedAt,
    };
  }
  if (base === null) return null;

  const tools: ToolWrapStatusJson['tools'] = {};
  if (existing !== null && isRecord(existing.tools)) {
    for (const [name, entry] of Object.entries(existing.tools)) {
      const at = isRecord(entry) ? entry['lastWrapperAt'] : null;
      tools[name] = { lastWrapperAt: typeof at === 'string' ? at : null };
    }
  }
  for (const call of calls) {
    tools[call.tool] = {
      lastWrapperAt: laterOf(tools[call.tool]?.lastWrapperAt, call.startedAt),
    };
  }
  return { ...base, tools };
}

/**
 * Merges this tree's wrapper status and records into `repositories.tool_wrap_status` of the row
 * `repoRowId` (rules above). Locks the row for the read-merge-write.
 */
export async function writeToolWrapStatus(
  tx: DrizzleDb,
  repoRowId: number,
  parsedStatus: WrapperStatusLine | null,
  calls: readonly WrapperCallRecord[],
): Promise<void> {
  const result = await tx.execute(
    sql`SELECT tool_wrap_status FROM repositories WHERE id = ${repoRowId} FOR UPDATE`,
  );
  const row = result.rows[0] as { tool_wrap_status: unknown } | undefined;
  if (row === undefined) return;
  const existing = readStored(row.tool_wrap_status);
  const merged = mergeToolWrapStatus(existing, parsedStatus, calls);
  if (merged === null) return;
  await tx
    .update(repositories)
    .set({ toolWrapStatus: merged })
    .where(eq(repositories.id, repoRowId));
}
