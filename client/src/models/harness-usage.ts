/**
 * Harness Elements Usage report (`GET :repoId/reports/harness-usage`).
 * Mirrors `server/src/logs/reports/harness-usage.service.ts`'s response shape.
 */

export type HarnessElementKind = 'skill' | 'rule' | 'mcp' | 'tool';

export interface HarnessUsageRow {
  kind: HarnessElementKind;
  name: string;
  /** Non-null only for `tool`-kind rows sourced from an MCP server. */
  mcpServer: string | null;
  /** `kind='mcp'` only; `null` = never reported (old hook / no data yet). */
  mcpConnected: boolean | null;
  uses: number;
  inputTokens: number;
  outputTokens: number;
  /** 0..100, within-kind, within-slice. */
  countPct: number;
  tokenPct: number;
  /**
   * `null` = not applicable (skill/rule/built-in-tool/MCP-server row). Whether a `-`
   * should render instead of a number is `schemaSizeReported`, not this field's nullness.
   */
  schemaSizeTokens: number | null;
  /** `false` => render `-`, never `0`/`null`. */
  schemaSizeReported: boolean;
  /** ISO timestamp, `null` for built-in tools and for usage-only rows absent from inventory. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** `lastSeen` older than the repo's latest self-report. */
  removed: boolean;
  /**
   * `kind='skill'` only: `'project' | 'user' | 'plugin' | null` (older hook, or not a skill
   * row). `'user'` was added alongside the harness-snapshot source rework.
   */
  source: 'project' | 'user' | 'plugin' | null;
}

export interface HarnessUsageGroup {
  group: string;
  rows: HarnessUsageRow[];
}

export interface HarnessUsageReportData {
  /** `repositories.harness_inventory_reported_at IS NOT NULL`, OR'd across every repo in scope. */
  inventoryReported: boolean;
  elementCount: number;
  neverUsedCount: number;
  totalUses: number;
  /** Root sessions in scope (date/branch/user filters). */
  sessionCount: number;
  /** Repo-wide; empty when grouped. */
  rows: HarnessUsageRow[];
  /** Present iff `groupBy !== 'none'`. */
  groups?: HarnessUsageGroup[];
}
