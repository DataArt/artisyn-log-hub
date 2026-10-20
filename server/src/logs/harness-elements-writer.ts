import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { harnessElements } from '../database/schema/index';
import { BUILTIN_TOOL_NAMES } from './builtin-tools';

/** Matches `harness_elements.name VARCHAR(255)` / `mcp_server VARCHAR(128)`. */
const MAX_NAME_LENGTH = 255;
const MAX_MCP_SERVER_LENGTH = 128;

export interface HarnessElementInput {
  kind: 'skill' | 'rule' | 'mcp' | 'tool';
  name: string;
  /** Non-null only for `tool`-kind rows sourced from an MCP server. */
  mcpServer?: string | null;
  /** Meaningful only for `kind='mcp'`. */
  mcpConnected?: boolean | null;
  /** Meaningful only for `tool`-kind rows sourced from an MCP server. */
  schemaSizeTokens?: number | null;
  /** Meaningful only for `kind='skill'`: `'project' | 'plugin' | null`. */
  source?: string | null;
}

/**
 * Upserts one repo's self-reported harness element inventory.
 *
 * - Built-in `tool`-kind rows (`builtin-tools.ts`) are seeded once per repo, read-only, with
 *   `first_seen`/`last_seen` both `NULL` — `onConflictDoNothing` makes repeated calls a no-op
 *   after the first.
 * - Self-reported elements (`skill`/`rule`/`mcp`/MCP-sourced `tool` rows) are upserted in one
 *   multi-row `INSERT ... ON CONFLICT (repo_id, kind, name) DO UPDATE`, mirroring
 *   `session-tool-stats-writer.ts`'s batching rationale: a single upload can report dozens of
 *   elements, and a statement per row would multiply round-trip cost. `first_seen` is set only
 *   on insert (never in the `DO UPDATE SET` clause, so an existing row's `first_seen` survives
 *   every re-report); `last_seen` is bumped forward-only via `GREATEST`.
 */
export async function upsertHarnessElements(
  tx: DrizzleDb,
  repoId: number,
  elements: HarnessElementInput[],
  reportedAt: Date = new Date(),
): Promise<void> {
  await tx
    .insert(harnessElements)
    .values(
      BUILTIN_TOOL_NAMES.map((name) => ({
        repoId,
        kind: 'tool' as const,
        name,
      })),
    )
    .onConflictDoNothing({
      target: [
        harnessElements.repoId,
        harnessElements.kind,
        harnessElements.name,
      ],
    });

  if (elements.length === 0) return;

  await tx
    .insert(harnessElements)
    .values(
      mergeByStoredIdentity(elements).map((el) => ({
        repoId,
        kind: el.kind,
        name: el.name,
        mcpServer: el.mcpServer ?? null,
        mcpConnected: el.mcpConnected ?? null,
        schemaSizeTokens: el.schemaSizeTokens ?? null,
        source: el.source ?? null,
        firstSeen: reportedAt,
        lastSeen: reportedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [
        harnessElements.repoId,
        harnessElements.kind,
        harnessElements.name,
      ],
      set: {
        mcpServer: sql`excluded.mcp_server`,
        mcpConnected: sql`excluded.mcp_connected`,
        schemaSizeTokens: sql`excluded.schema_size_tokens`,
        source: sql`excluded.source`,
        lastSeen: sql`GREATEST(excluded.last_seen, ${harnessElements.lastSeen})`,
      },
    });
}

/**
 * Truncates names/`mcpServer` to the stored column widths and merges any that collide after
 * truncation, mirroring `session-tool-stats-writer.ts`'s `mergeByStoredToolName` — otherwise a
 * collision after truncation would violate the `(repo_id, kind, name)` unique index and fail
 * the whole batch. Later entries win (matches "last self-report wins").
 */
function mergeByStoredIdentity(
  elements: HarnessElementInput[],
): HarnessElementInput[] {
  const merged = new Map<string, HarnessElementInput>();
  for (const el of elements) {
    const name = el.name.slice(0, MAX_NAME_LENGTH);
    const mcpServer = el.mcpServer
      ? el.mcpServer.slice(0, MAX_MCP_SERVER_LENGTH)
      : el.mcpServer;
    const key = `${el.kind}\0${name}`;
    merged.set(key, { ...el, name, mcpServer });
  }
  return [...merged.values()];
}
