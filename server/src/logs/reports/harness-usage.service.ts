import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import type { SessionAttributionAttributeDef } from '../../database/schema/index';
import {
  loadScopedRootSessions,
  num,
  sessionIdsArray,
  type AnalyticsScope,
  type ScopedRootSession,
} from '../analytics/scoped-sessions.sql';
import {
  attributeGroupLabels,
  parseGroupByAttrKey,
} from '../attribute-filter.sql';
import { descendantSessionsCte } from '../session-tree.sql';

/** Harness Elements Usage report (mirrors `cache-read-ratio.service.ts`'s shape). */

export type HarnessElementKind = 'skill' | 'rule' | 'mcp' | 'tool';

/**
 * Optional per-group breakdown, same three fixed values `cache-read-ratio` supports, widened
 * to also accept `attr:<key>`.
 */
export type HarnessUsageGroupBy = 'none' | 'branch' | 'user' | `attr:${string}`;

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
   * `null` = not applicable (skill/rule/built-in-tool/MCP-server row). Whether a `-` should
   * be rendered instead of a number is `schemaSizeReported`, not this field's nullness.
   */
  schemaSizeTokens: number | null;
  /** `false` => render `-`, never `0`/`null`. */
  schemaSizeReported: boolean;
  /** ISO timestamp, `null` for built-in tools and for usage-only rows absent from inventory. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** `lastSeen` older than the repo's latest self-report. */
  removed: boolean;
  /** `kind='skill'` only: `'project' | 'plugin' | null` (older hook, or not a skill row). */
  source: 'project' | 'plugin' | null;
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
  /** Root sessions in scope (date/branch/user filters) — replaces a "total tokens" tile that
   * double-counted the same context injection across every turn. */
  sessionCount: number;
  /** Repo-wide; empty when grouped. */
  rows: HarnessUsageRow[];
  /** Present iff `groupBy !== 'none'`. */
  groups?: HarnessUsageGroup[];
}

export interface HarnessUsageOptions extends AnalyticsScope {
  groupBy: HarnessUsageGroupBy;
  /** Needed only when `groupBy` is the `attr:<key>` form (orphaned values fold into "Not determined"). */
  resolvedAttributeDefinitions?: SessionAttributionAttributeDef[];
}

/** One deduplicated `harness_elements` row, merged across every repo id in scope. */
export interface HarnessInventoryElement {
  kind: HarnessElementKind;
  /** Bare name — a `tool`-kind MCP row never carries the `mcp__<server>__` prefix here. */
  name: string;
  mcpServer: string | null;
  mcpConnected: boolean | null;
  schemaSizeTokens: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** `kind='skill'` only: `'project' | 'plugin' | null`. */
  source: 'project' | 'plugin' | null;
}

/**
 * One root session's whole subtree's usage of one element (from
 * `session_harness_usage`, summed like `session_tool_stats` is in `tool-analytics.service.ts`),
 * tagged with the root session's own branch/user for grouping — same shape
 * `CacheRatioSessionRow` uses for the same reason.
 */
export interface HarnessUsageFactRow {
  /** The root session this fact rolled up under — only used for `groupBy=attr:<key>`. */
  sessionRowId: number;
  branch: string | null;
  userEmail: string;
  kind: 'skill' | 'rule' | 'tool';
  /** Bare name — see {@link HarnessInventoryElement.name}. */
  name: string;
  mcpServer: string | null;
  uses: number;
  inputTokens: number;
  outputTokens: number;
}

// --- Raw SQL row shapes -----------------------------------------------------------------

interface InventorySqlRow {
  kind: HarnessElementKind;
  name: string;
  mcp_server: string | null;
  mcp_connected: boolean | null;
  schema_size_tokens: string | number | null;
  first_seen: string | Date | null;
  last_seen: string | Date | null;
  source: string | null;
}

interface RepoStateSqlRow {
  inventory_reported: boolean | null;
  reported_at: string | Date | null;
}

interface UsageFactSqlRow {
  session_row_id: string | number;
  kind: 'skill' | 'rule' | 'tool';
  name: string;
  mcp_server: string | null;
  uses: string | number | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
}

function toIsoOrNull(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/**
 * Strips a `mcp__<server>__` prefix, when present, from a tool name. Reconciles the two
 * naming conventions actually stored today: `session_harness_usage.name` keeps the full
 * `tool_use.name` (`mcp__<server>__<tool>`, per `mcpServerOfTool`'s convention in
 * `tool-stats.ts`), while `harness_elements`' MCP-sourced `tool` rows are written from the
 * hook's raw `tools/list` probe result (`logs.service.ts` Step 5d), which is the bare tool
 * name the MCP server itself returned. Normalizing both sides to the bare name here is what
 * lets {@link mergeInventory} join them on `(kind, mcpServer, name)` without a separate
 * lookup table.
 */
export function bareMcpToolName(
  name: string,
  mcpServer: string | null,
): string {
  if (mcpServer === null) return name;
  const prefix = `mcp__${mcpServer}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function usageKey(
  kind: HarnessElementKind,
  name: string,
  mcpServer: string | null,
): string {
  return `${kind}\0${mcpServer ?? ''}\0${name}`;
}

// --- Pure helpers (exported for unit tests) ----------------------------------------------

interface KindTotal {
  uses: number;
  tokens: number;
}

/** Per-kind totals over the given row set (the per-kind percentage denominator). */
export function aggregateByKind(
  rows: readonly HarnessUsageRow[],
): Map<HarnessElementKind, KindTotal> {
  const totals = new Map<HarnessElementKind, KindTotal>();
  for (const row of rows) {
    const existing = totals.get(row.kind) ?? { uses: 0, tokens: 0 };
    existing.uses += row.uses;
    existing.tokens += row.inputTokens + row.outputTokens;
    totals.set(row.kind, existing);
  }
  return totals;
}

/**
 * Fills `countPct`/`tokenPct`: each row's share of its **own kind's**
 * total within `rows` (repo-wide or one group's slice — the caller decides the scope by what
 * it passes in). A kind whose slice total is 0 renders 0% for every row of that kind, not
 * `-` — `-` is reserved for the schema-size field only.
 */
export function computePercentages(
  rows: readonly HarnessUsageRow[],
): HarnessUsageRow[] {
  const totals = aggregateByKind(rows);
  return rows.map((row) => {
    const total = totals.get(row.kind) ?? { uses: 0, tokens: 0 };
    const tokens = row.inputTokens + row.outputTokens;
    return {
      ...row,
      countPct: total.uses > 0 ? (row.uses / total.uses) * 100 : 0,
      tokenPct: total.tokens > 0 ? (tokens / total.tokens) * 100 : 0,
    };
  });
}

/**
 * Merges the repo's full element inventory with a set of usage facts (already scoped to
 * repo-wide or to one group) into the flat row list a report/group renders.
 * `countPct`/`tokenPct` come back as 0 — call {@link computePercentages} on
 * the result before returning it to a caller.
 *
 * - Every inventory element gets a row, even with zero usage in this slice
 *   (`harness_elements` supplies the zero-usage rows).
 * - A usage fact whose `(kind, mcpServer, name)` has no inventory row still gets a row
 *   (an old hook's usage-only MCP tool call, or any other element this
 *   repo used but never self-reported) — with no first/last-seen and `removed: false`.
 * - `mcp`-kind rows never come from usage facts (`session_harness_usage` has no `mcp` kind);
 *   their `uses`/tokens are the sum of their `tool`-kind children sharing their `mcpServer`
 *   name, computed here rather than stored.
 */
export function mergeInventory(
  inventory: readonly HarnessInventoryElement[],
  facts: readonly HarnessUsageFactRow[],
  inventoryReportedAt: Date | null,
): HarnessUsageRow[] {
  const usageByKey = new Map<
    string,
    { uses: number; inputTokens: number; outputTokens: number }
  >();
  const factByKey = new Map<string, HarnessUsageFactRow>();
  for (const fact of facts) {
    const key = usageKey(fact.kind, fact.name, fact.mcpServer);
    const existing = usageByKey.get(key);
    if (existing === undefined) {
      usageByKey.set(key, {
        uses: fact.uses,
        inputTokens: fact.inputTokens,
        outputTokens: fact.outputTokens,
      });
      factByKey.set(key, fact);
    } else {
      existing.uses += fact.uses;
      existing.inputTokens += fact.inputTokens;
      existing.outputTokens += fact.outputTokens;
    }
  }

  const rows = new Map<string, HarnessUsageRow>();

  for (const el of inventory) {
    const key = usageKey(el.kind, el.name, el.mcpServer);
    const usage = el.kind === 'mcp' ? undefined : usageByKey.get(key);
    const removed =
      el.lastSeen !== null &&
      inventoryReportedAt !== null &&
      new Date(el.lastSeen).getTime() < inventoryReportedAt.getTime();

    rows.set(key, {
      kind: el.kind,
      name: el.name,
      mcpServer: el.mcpServer,
      mcpConnected: el.kind === 'mcp' ? el.mcpConnected : null,
      uses: usage?.uses ?? 0,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      countPct: 0,
      tokenPct: 0,
      schemaSizeTokens: el.schemaSizeTokens,
      schemaSizeReported: el.schemaSizeTokens !== null,
      firstSeen: el.firstSeen,
      lastSeen: el.lastSeen,
      removed,
      source: el.source,
    });
  }

  for (const [key, usage] of usageByKey) {
    if (rows.has(key)) continue;
    const fact = factByKey.get(key);
    if (fact === undefined) continue; // unreachable — every key in usageByKey has a fact
    rows.set(key, {
      kind: fact.kind,
      name: fact.name,
      mcpServer: fact.mcpServer,
      mcpConnected: null,
      uses: usage.uses,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      countPct: 0,
      tokenPct: 0,
      schemaSizeTokens: null,
      schemaSizeReported: false,
      firstSeen: null,
      lastSeen: null,
      removed: false,
      source: null,
    });
  }

  // MCP-kind rollup — after every `tool`-kind row (inventory- and
  // usage-only alike) has landed in `rows`, so a disconnected/old-hook server with only
  // usage-derived children still rolls up correctly.
  for (const row of rows.values()) {
    if (row.kind !== 'mcp') continue;
    let uses = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const child of rows.values()) {
      if (child.kind === 'tool' && child.mcpServer === row.name) {
        uses += child.uses;
        inputTokens += child.inputTokens;
        outputTokens += child.outputTokens;
      }
    }
    row.uses = uses;
    row.inputTokens = inputTokens;
    row.outputTokens = outputTokens;
  }

  return [...rows.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
}

/**
 * Per-group tables (`cache-read-ratio`'s `buildGroups` precedent). Every
 * branch/user that has at least one root session in scope gets a group — even one with zero
 * harness usage in the whole range — so its table still renders the full zero-usage
 * inventory, per the grouped-view requirement. Groups are ordered by total (non-`mcp`) uses
 * descending, branch/user name as the stable tie-break.
 */
export function buildGroups(
  inventory: readonly HarnessInventoryElement[],
  facts: readonly HarnessUsageFactRow[],
  roots: readonly Pick<
    ScopedRootSession,
    'sessionRowId' | 'branch' | 'userEmail'
  >[],
  groupBy: HarnessUsageGroupBy,
  inventoryReportedAt: Date | null,
  resolvedDefinitions: SessionAttributionAttributeDef[] = [],
  attributionValuesBySessionRowId: ReadonlyMap<
    number,
    Record<string, string | string[] | boolean | number | null>
  > = new Map(),
): HarnessUsageGroup[] {
  if (groupBy === 'none') return [];

  const groupByAttrKey = parseGroupByAttrKey(groupBy);

  // Fan-out: a `string[]`-typed attribute's N values fan one root/fact
  // into every one of its N groups, not one joined group.
  const groupKeys = (entry: {
    sessionRowId: number;
    branch: string | null;
    userEmail: string;
  }): string[] => {
    if (groupByAttrKey !== undefined) {
      return attributeGroupLabels(
        groupByAttrKey,
        attributionValuesBySessionRowId.get(entry.sessionRowId) ?? null,
        resolvedDefinitions,
      );
    }
    return [
      groupBy === 'branch' ? (entry.branch ?? 'no branch') : entry.userEmail,
    ];
  };

  const byGroup = new Map<string, HarnessUsageFactRow[]>();
  for (const root of roots) {
    for (const key of groupKeys(root)) {
      if (!byGroup.has(key)) byGroup.set(key, []);
    }
  }
  for (const fact of facts) {
    for (const key of groupKeys(fact)) {
      const existing = byGroup.get(key);
      if (existing) existing.push(fact);
      else byGroup.set(key, [fact]);
    }
  }

  return [...byGroup.entries()]
    .map(([group, groupFacts]) => ({
      group,
      rows: computePercentages(
        mergeInventory(inventory, groupFacts, inventoryReportedAt),
      ),
    }))
    .sort((a, b) => {
      const usesOf = (g: HarnessUsageGroup): number =>
        g.rows.reduce((sum, r) => sum + (r.kind === 'mcp' ? 0 : r.uses), 0);
      return usesOf(b) - usesOf(a) || a.group.localeCompare(b.group);
    });
}

@Injectable()
export class HarnessUsageService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async build(
    repoIds: number[],
    opts: HarnessUsageOptions,
  ): Promise<HarnessUsageReportData> {
    const [inventory, repoState, roots] = await Promise.all([
      this.loadInventory(repoIds),
      this.loadRepoState(repoIds),
      loadScopedRootSessions(this.db, repoIds, opts),
    ]);

    const facts = roots.length > 0 ? await this.loadUsageFacts(roots) : [];

    const repoWideRows = computePercentages(
      mergeInventory(inventory, facts, repoState.reportedAt),
    );

    const nonMcpRows = repoWideRows.filter((r) => r.kind !== 'mcp');

    // Only fetched when actually grouping by an attribute — the fixed
    // branch/user groupings never touch `session_attribution`.
    const groupByAttrKey = parseGroupByAttrKey(opts.groupBy);
    const attributionValuesBySessionRowId =
      groupByAttrKey !== undefined && roots.length > 0
        ? await this.loadAttributionValues(roots)
        : new Map<
            number,
            Record<string, string | string[] | boolean | number | null>
          >();

    return {
      inventoryReported: repoState.inventoryReported,
      elementCount: repoWideRows.length,
      neverUsedCount: repoWideRows.filter((r) => r.uses === 0).length,
      totalUses: nonMcpRows.reduce((sum, r) => sum + r.uses, 0),
      sessionCount: roots.length,
      rows: opts.groupBy === 'none' ? repoWideRows : [],
      ...(opts.groupBy !== 'none'
        ? {
            groups: buildGroups(
              inventory,
              facts,
              roots,
              opts.groupBy,
              repoState.reportedAt,
              opts.resolvedAttributeDefinitions ?? [],
              attributionValuesBySessionRowId,
            ),
          }
        : {}),
    };
  }

  /**
   * `session_attribution.values` for every root in scope, keyed by `sessionRowId` — the one
   * extra lookup `groupBy=attr:<key>` needs beyond the branch/user groupings, which
   * `roots`/`facts` already carry.
   */
  private async loadAttributionValues(
    roots: ScopedRootSession[],
  ): Promise<
    Map<number, Record<string, string | string[] | boolean | number | null>>
  > {
    const idsLiteral = `{${roots.map((r) => r.sessionRowId).join(',')}}`;
    const result = await this.db.execute(sql`
      SELECT session_id AS session_row_id, values
      FROM session_attribution
      WHERE session_id = ANY(${idsLiteral}::bigint[])
    `);
    const map = new Map<
      number,
      Record<string, string | string[] | boolean | number | null>
    >();
    for (const row of result.rows as unknown as {
      session_row_id: string | number;
      values: Record<string, string | string[] | boolean | number | null>;
    }[]) {
      map.set(Number(row.session_row_id), row.values);
    }
    return map;
  }

  /** The repo(s)' full element inventory, deduplicated across every id in scope. */
  private async loadInventory(
    repoIds: number[],
  ): Promise<HarnessInventoryElement[]> {
    if (repoIds.length === 0) return [];
    const repoIdsLiteral = `{${repoIds.join(',')}}`;

    // Team-linked repos each hold their own `harness_elements` copy of the same underlying
    // repository's inventory. `ranked` picks the freshest report's `mcp_server`/
    // `mcp_connected`/`schema_size_tokens` (last self-report wins, same convention as
    // `hook_version`); `bounds` widens `first_seen`/`last_seen` across every repo id so an
    // element first/last reported under a teammate's repo row is not lost.
    const result = await this.db.execute(sql`
      WITH scoped AS (
        SELECT kind, name, mcp_server, mcp_connected, schema_size_tokens, first_seen, last_seen, source
        FROM harness_elements
        WHERE repo_id = ANY(${repoIdsLiteral}::int[])
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY kind, name ORDER BY last_seen DESC NULLS LAST
          ) AS rn
        FROM scoped
      ),
      bounds AS (
        SELECT kind, name, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
        FROM scoped
        GROUP BY kind, name
      )
      SELECT r.kind, r.name, r.mcp_server, r.mcp_connected, r.schema_size_tokens,
             b.first_seen, b.last_seen, r.source
      FROM ranked r
      JOIN bounds b ON b.kind = r.kind AND b.name = r.name
      WHERE r.rn = 1
    `);

    return (result.rows as unknown as InventorySqlRow[]).map((r) => ({
      kind: r.kind,
      name: bareMcpToolName(r.name, r.mcp_server),
      mcpServer: r.mcp_server,
      mcpConnected: r.mcp_connected,
      schemaSizeTokens:
        r.schema_size_tokens === null ? null : num(r.schema_size_tokens),
      firstSeen: toIsoOrNull(r.first_seen),
      lastSeen: toIsoOrNull(r.last_seen),
      source: r.source === 'project' || r.source === 'plugin' ? r.source : null,
    }));
  }

  /**
   * `inventoryReported`: `harness_inventory_reported_at IS NOT NULL` for ANY repo in scope
   * (an owner viewing several linked repos — OR across them, matching how other hook-state
   * columns are read today). `reportedAt`: the latest such timestamp across all of them,
   * which is what the `removed` rule compares each element's `last_seen`
   * against.
   */
  private async loadRepoState(repoIds: number[]): Promise<{
    inventoryReported: boolean;
    reportedAt: Date | null;
  }> {
    if (repoIds.length === 0) {
      return { inventoryReported: false, reportedAt: null };
    }
    const repoIdsLiteral = `{${repoIds.join(',')}}`;
    const result = await this.db.execute(sql`
      SELECT
        BOOL_OR(harness_inventory_reported_at IS NOT NULL) AS inventory_reported,
        MAX(harness_inventory_reported_at)                  AS reported_at
      FROM repositories
      WHERE id = ANY(${repoIdsLiteral}::int[])
    `);
    const [row] = result.rows as unknown as RepoStateSqlRow[];
    return {
      inventoryReported: row?.inventory_reported === true,
      reportedAt:
        row?.reported_at != null
          ? row.reported_at instanceof Date
            ? row.reported_at
            : new Date(row.reported_at)
          : null,
    };
  }

  /**
   * Phase B — for each Phase-A root session, `session_harness_usage` summed over its whole
   * recursive descendant tree (same shape `tool-analytics.service.ts` uses for
   * `session_tool_stats`), one row per `(root, kind, name, mcpServer)`. Tagging each summed
   * row with its root's own branch/user (rather than each descendant's) is what lets
   * {@link buildGroups} group a sub-agent's tool usage under its root session's branch/user.
   */
  private async loadUsageFacts(
    roots: ScopedRootSession[],
  ): Promise<HarnessUsageFactRow[]> {
    const idsArray = sessionIdsArray(roots.map((r) => r.sessionRowId));

    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)}
      SELECT
        ds.root_id                AS session_row_id,
        shu.kind                  AS kind,
        shu.name                  AS name,
        shu.mcp_server            AS mcp_server,
        SUM(shu.uses)             AS uses,
        SUM(shu.input_tokens)     AS input_tokens,
        SUM(shu.output_tokens)    AS output_tokens
      FROM descendant_sessions ds
      JOIN session_harness_usage shu ON shu.session_id = ds.id
      GROUP BY ds.root_id, shu.kind, shu.name, shu.mcp_server
    `);

    const rootById = new Map<number, ScopedRootSession>();
    for (const root of roots) rootById.set(root.sessionRowId, root);

    const facts: HarnessUsageFactRow[] = [];
    for (const r of result.rows as unknown as UsageFactSqlRow[]) {
      const root = rootById.get(Number(r.session_row_id));
      if (root === undefined) continue; // unreachable — every root_id came from `roots`
      facts.push({
        sessionRowId: root.sessionRowId,
        branch: root.branch,
        userEmail: root.userEmail,
        kind: r.kind,
        name: bareMcpToolName(r.name, r.mcp_server),
        mcpServer: r.mcp_server,
        uses: num(r.uses),
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
      });
    }
    return facts;
  }
}
