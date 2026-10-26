import type { RepositorySession } from '../../../../models/repositories';
import type { ModelPricingMap } from '../../../../models/pricing';
import type { WorkflowRun } from '../../../../models/workflows';
import type { ParsedSession } from './types';
import {
  cacheReadRatio,
  computeCost,
  formatCost,
  FAST_MODE_MULTIPLIER,
} from '../../../lib/format';
import type { WorkflowStats } from './SessionInfoWorkflowsSection';
import { isEditWriteTool } from './edit-tools';
import type { TreeCodeImpact } from './tree-code-impact';

export interface ImageSourceCount {
  toolName: string;
  count: number;
}

export interface TokensCostDerived {
  /**
   * `Task`-tool activations found in **this transcript's** turns. Deliberately narrow: it is the
   * evidence gate for attributing a cost gap to sub-agents, so a workflow-spawned agent (which
   * this transcript never activates directly) must not inflate it. For "how many sub-agents does
   * this session tree have", use {@link TokensCostDerived.subAgentsTree}.
   */
  subAgents: number;
  /**
   * Sub-agents in the whole session **tree** — every recursive descendant, however it was
   * spawned. Taken from `codeImpact.descendants` (the `/logs` `subagentStats` map the server
   * keys by descendant), falling back to {@link TokensCostDerived.subAgents} when no
   * `codeImpact` is supplied or its map is empty, so this can never report *fewer* agents than
   * the transcript itself proves.
   *
   * Exists because {@link TokensCostDerived.subAgents} sees only `Task` activations: a
   * workflow-driven session showed `0 agents` directly beside the tree-scoped
   * `… in 11 sub-agents` line. Every *display* of a sub-agent count reads this field; the
   * cost-evidence gate still reads the narrow one.
   */
  subAgentsTree: number;
  /**
   * `Edit`/`Write`/`MultiEdit` **calls** — tree-scoped (root + every descendant sub-agent)
   * whenever a `codeImpact` argument is supplied to {@link computeSessionInfoDerived}, and
   * root-transcript-only when it is not. A count of calls, not of distinct files.
   */
  filesEditedWritten: number;
  /**
   * Cached share of the *input* side: `cacheRead / (input + cacheRead)`.
   * A different metric from {@link TokensCostDerived.cacheReadRatio} — kept as is.
   */
  cacheHitRate: number;
  /**
   * Cache read ratio: `cacheRead / (cacheRead + cacheWrite)`, `null` when the
   * session produced no cache traffic at all (rendered as `n/a`, never `0%`).
   */
  cacheReadRatio: number | null;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheWrite5mCost: number | null;
  cacheWrite1hCost: number | null;
  priceIn: number | null;
  priceOut: number | null;
  priceCacheR: number | null;
  /**
   * The 5m cache-write rate, kept under the old name for the aggregate "Cache write" row.
   * @deprecated Use {@link TokensCostDerived.priceCacheW5m} /
   * {@link TokensCostDerived.priceCacheW1h}; the two TTLs no longer share one rate.
   */
  priceCacheW: number | null;
  priceCacheW5m: number | null;
  priceCacheW1h: number | null;
  /** USD per web-search **request** (not per million) — `null` when the model is unpriced. */
  priceWebSearch: number | null;
  inputCost: number | null;
  outputCost: number | null;
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  /** `webSearchRequests × priceWebSearch` — a per-request charge, never divided by 1e6. */
  webSearchCost: number | null;
  /**
   * Cost of the fast-mode **subset** of the input tokens, priced at the fast rate
   * (`priceIn × FAST_MODE_MULTIPLIER`). `inputFast` is contained in `input`, so this is a
   * disclosure row, not an additive one: the Input row above it already charges these tokens
   * at the standard rate, and {@link TokensCostDerived.totalCost} adds only the surcharge.
   */
  inputFastCost: number | null;
  /** As {@link TokensCostDerived.inputFastCost}, for the output side. */
  outputFastCost: number | null;
  totalCost: number | null;
  costPerLine: number | null;
  rulesDisplay: string;
  skillsBytes: number;
  skillsTokens: number;
  rulesBytes: number;
  rulesTokens: number;
  imageCost: number | null;
  imageSources: ImageSourceCount[];
}

export interface SessionInfoDerived {
  wallClockMs: number | null;
  workflowSubagentTokens: number;
  workflowStats: WorkflowStats | null;
  derived: TokensCostDerived | null;
  subAgentCost: number | null;
  workflowEstimatedCost: number | null;
  /**
   * Whether the "Workflow agents" row is shown in the Tokens & Cost table — false when
   * `subAgentCost` (the exact DB-total-minus-main figure) already covers at least half of the
   * rough `workflowEstimatedCost`, since showing both would double-count the same agents.
   */
  showWorkflowCostRow: boolean;
  /**
   * "Calculated approx. total" — the sum of every cost row the Tokens & Cost table actually
   * shows above it: main-session cost, plus Sub-agents when present, plus Workflow agents when
   * shown. Not just `derived.totalCost` (main-session tokens only) — that undercounts by the
   * full sub-agent/workflow spend whenever any ran, which previously made this row look wildly
   * lower than the session cost shown next to it even though the two were never meant to match.
   */
  totalCostWithSubagents: number | null;
  productivityLines: string | null;
  productivityCost: string | null;
  skillsDisplay: string | null;
  claudeMdFiles: string | null;
}

/**
 * Session Info tab — computes every derived (non-raw) value shown on the tab
 * from a session, its parsed logs, and the current model pricing map. Pure
 * function, safe to call outside React (e.g. from the session export runner)
 * as well as from `SessionInfoTab.tsx`'s memos.
 * Extracted from `SessionInfoTab.tsx`.
 *
 * `codeImpact` is optional on purpose: when supplied (the Info tab, the Summary tab and
 * the session export all pass it), every lines/files figure below is **tree-scoped** — root plus
 * every descendant sub-agent — which is what makes this tab agree with the analytics timeline
 * and the Executive Summary. When omitted, the function keeps its root-only behaviour,
 * so a caller that has no `SessionUsage` walk at hand still gets a coherent (if narrower)
 * result rather than zeros.
 */
export function computeSessionInfoDerived(
  session: RepositorySession,
  parsedLogs: ParsedSession | null,
  pricing: ModelPricingMap | undefined,
  codeImpact?: TreeCodeImpact | null,
): SessionInfoDerived {
  const wallClockMsRaw =
    new Date(session.endTime).getTime() - new Date(session.startTime).getTime();
  const wallClockMs = Number.isFinite(wallClockMsRaw) ? wallClockMsRaw : null;

  let workflowSubagentTokens = 0;
  if (parsedLogs) {
    for (const turn of parsedLogs.turns) {
      if (!turn.workflows) continue;
      for (const wf of turn.workflows) {
        workflowSubagentTokens += wf.subagentTokens ?? 0;
      }
    }
  }

  const workflowStats = computeWorkflowStats(parsedLogs);

  const derived = computeTokensCostDerived(
    session,
    parsedLogs,
    pricing,
    codeImpact,
  );

  // Exact sub-agent cost, computed server-side from the sub-agent sessions' own priced logs
  // (D2.3). Never derived as telemetry minus main: that gap also holds utility calls and
  // pricing differences, which are not sub-agent spend. The server sends 0 for a session with
  // no sub-agents, so no separate evidence gate is needed.
  const serverSubagentCost = session.costBreakdown.subagentCost;
  const subAgentCost = serverSubagentCost > 0 ? serverSubagentCost : null;

  // Rough cost estimate for workflow agents: use main-session's average cost-per-token as proxy.
  // Uses derived.totalCost (not session.totalCost) to avoid circularity after workflow agents
  // are uploaded and their cost folds into session.totalCost.
  let workflowEstimatedCost: number | null = null;
  if (workflowSubagentTokens) {
    const mainCost = derived?.totalCost ?? null;
    const mainTokens = parsedLogs?.summary.totalTokens ?? 0;
    if (mainCost && mainTokens) {
      workflowEstimatedCost = (workflowSubagentTokens / mainTokens) * mainCost;
    }
  }

  // See `SessionInfoDerived.showWorkflowCostRow` — skip the rough workflow estimate when the
  // exact sub-agent rollup already accounts for most of it.
  const showWorkflowCostRow =
    workflowSubagentTokens > 0 &&
    !(
      subAgentCost != null &&
      workflowEstimatedCost != null &&
      subAgentCost >= workflowEstimatedCost * 0.5
    );

  const totalCostWithSubagents =
    derived?.totalCost == null
      ? null
      : derived.totalCost +
        (subAgentCost ?? 0) +
        (showWorkflowCostRow ? (workflowEstimatedCost ?? 0) : 0);

  let productivityLines: string | null = null;
  if (parsedLogs) {
    const { totalWorkTimeMs } = parsedLogs.summary;
    // The numerator is tree-scoped while `totalWorkTimeMs` already is (children run
    // inside the root's span), so both sides of this ratio share one scope.
    const linesChanged =
      codeImpact?.linesTree ?? parsedLogs.summary.linesChanged;
    if (totalWorkTimeMs !== 0) {
      productivityLines =
        Math.round(
          linesChanged / (totalWorkTimeMs / 3_600_000),
        ).toLocaleString() + ' lines/hr';
    }
  }

  let productivityCost: string | null = null;
  if (parsedLogs && session.totalCost != null) {
    const { totalWorkTimeMs } = parsedLogs.summary;
    if (totalWorkTimeMs !== 0) {
      productivityCost =
        formatCost(session.totalCost / (totalWorkTimeMs / 3_600_000)) + ' /hr';
    }
  }

  let skillsDisplay: string | null = null;
  if (parsedLogs) {
    const skills = parsedLogs.summary.skillsUsed;
    skillsDisplay = skills.length > 0 ? skills.join(', ') : '—';
  }

  let claudeMdFiles: string | null = null;
  if (parsedLogs?.summary.claudeMd) {
    const paths = parsedLogs.summary.claudeMd.files.map((f) => f.path);
    claudeMdFiles = paths.length > 0 ? paths.join('\n') : null;
  }

  return {
    wallClockMs,
    workflowSubagentTokens,
    workflowStats,
    derived,
    subAgentCost,
    workflowEstimatedCost,
    showWorkflowCostRow,
    totalCostWithSubagents,
    productivityLines,
    productivityCost,
    skillsDisplay,
    claudeMdFiles,
  };
}

function computeWorkflowStats(
  parsedLogs: ParsedSession | null,
): WorkflowStats | null {
  if (!parsedLogs) return null;
  const workflows: WorkflowRun[] = [];
  for (const turn of parsedLogs.turns) {
    if (turn.workflows) workflows.push(...turn.workflows);
  }
  if (workflows.length === 0) return null;

  // Once agentSessionIds is resolved it's the
  // authoritative agent count, falling back to the self-reported agentCount
  // for a running/legacy/unresolvable workflow.
  const totalAgents = workflows.reduce(
    (s, wf) =>
      s +
      (wf.agentSessionIds.length > 0
        ? wf.agentSessionIds.length
        : (wf.agentCount ?? 0)),
    0,
  );
  const totalToolUses = workflows.reduce((s, wf) => s + (wf.toolUses ?? 0), 0);
  const completed = workflows.filter((wf) => wf.status === 'completed').length;
  const failed = workflows.filter((wf) => wf.status === 'failed').length;
  const running = workflows.filter((wf) => wf.status === 'running').length;

  return {
    workflows,
    totalAgents,
    totalToolUses,
    completed,
    failed,
    running,
  };
}

function computeTokensCostDerived(
  session: RepositorySession,
  parsedLogs: ParsedSession | null,
  pricing: ModelPricingMap | undefined,
  codeImpact?: TreeCodeImpact | null,
): TokensCostDerived | null {
  if (!parsedLogs) return null;

  const { summary, turns } = parsedLogs;
  const subAgents = turns.reduce((n, t) => n + t.agentActivations.length, 0);
  // `Math.max` rather than a plain preference: `codeImpact.descendants` is `0` in walk mode
  // (no `subagentStats` — still loading, or a session whose descendants were never ingested),
  // and falling back to `0` there would *lose* agents this transcript demonstrably activated.
  const subAgentsTree = Math.max(codeImpact?.descendants ?? 0, subAgents);
  // `MultiEdit` belongs in this gate: `claude-extractor.ts` has always counted it,
  // so leaving it out made a MultiEdit-heavy session report fewer files here than
  // `session_stats` did for the very same transcript. The list is now shared
  // (`edit-tools.ts`) so the two sides cannot drift again.
  const filesEditedWrittenOwn = turns
    .flatMap((t) => t.files)
    .filter((f) => isEditWriteTool(f.tool)).length;
  const filesEditedWritten = codeImpact?.filesTree ?? filesEditedWrittenOwn;

  const seenRules = new Set<string>();
  let skillsBytes = 0;
  let skillsTokens = 0;
  let rulesBytes = 0;
  let rulesTokens = 0;
  for (const turn of turns) {
    for (const s of turn.skills) {
      skillsBytes += s.bytes ?? 0;
      skillsTokens += s.estTokens ?? 0;
    }
    for (const r of turn.rulesInjected) {
      seenRules.add(r.name);
      rulesBytes += r.bytes ?? 0;
      rulesTokens += r.estTokens ?? 0;
    }
  }
  const rulesDisplay = seenRules.size > 0 ? [...seenRules].join(', ') : '—';

  const {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
    inputFast,
    outputFast,
    webSearchRequests,
  } = summary.tokenBreakdown;
  const denominator = input + cacheRead;
  const cacheHitRate = denominator > 0 ? cacheRead / denominator : 0;
  // Session-level source of truth is the client-parsed breakdown.
  const ratio = cacheReadRatio(cacheRead, cacheWrite);

  const model = summary.model;
  let priceIn: number | null = null;
  let priceOut: number | null = null;
  let priceCacheR: number | null = null;
  let priceCacheW: number | null = null;
  let priceCacheW5m: number | null = null;
  let priceCacheW1h: number | null = null;
  let priceWebSearch: number | null = null;
  let inputCost: number | null = null;
  let outputCost: number | null = null;
  let cacheReadCost: number | null = null;
  let cacheWriteCost: number | null = null;
  let cacheWrite5mCost: number | null = null;
  let cacheWrite1hCost: number | null = null;
  let webSearchCost: number | null = null;
  let inputFastCost: number | null = null;
  let outputFastCost: number | null = null;
  let totalCost: number | null = null;

  if (pricing && model) {
    const entry = pricing[model];
    if (entry) {
      priceIn = entry.priceIn;
      priceOut = entry.priceOut;
      priceCacheR = entry.priceCacheR;
      priceCacheW5m = entry.priceCacheW5m;
      priceCacheW1h = entry.priceCacheW1h;
      priceCacheW = entry.priceCacheW5m;
      priceWebSearch = entry.priceWebSearch;
      inputCost = (input / 1_000_000) * entry.priceIn;
      outputCost = (output / 1_000_000) * entry.priceOut;
      cacheReadCost = (cacheRead / 1_000_000) * entry.priceCacheR;
      // Each TTL bucket is priced at its own rate, and the aggregate cache-write
      // figure is their sum — never `cacheWrite * <one rate>`, which under-reported every
      // session that used 1h caching.
      cacheWrite5mCost = (cacheWrite5m / 1_000_000) * entry.priceCacheW5m;
      cacheWrite1hCost = (cacheWrite1h / 1_000_000) * entry.priceCacheW1h;
      cacheWriteCost = cacheWrite5mCost + cacheWrite1hCost;
      // Per-request charge, never per million tokens.
      webSearchCost = webSearchRequests * entry.priceWebSearch;
      // Disclosure figures for the two conditional fast-mode rows: the fast subset priced
      // at the fast rate. `totalCost` below does NOT add these — `computeCost` charges the
      // grand totals at the standard rate plus a `(M - 1)` surcharge on the fast subset,
      // which is the same money without double-billing the fast tokens.
      inputFastCost =
        (inputFast / 1_000_000) * entry.priceIn * FAST_MODE_MULTIPLIER;
      outputFastCost =
        (outputFast / 1_000_000) * entry.priceOut * FAST_MODE_MULTIPLIER;
      // Single source of truth for the session total — the same
      // function the turn tooltip and the call tree use, so the surfaces cannot disagree.
      totalCost = computeCost(summary.tokenBreakdown, entry);
    }
  }

  // `session.totalCost` covers the whole tree (main + every sub-agent), so its
  // denominator must too; the root-only line count used to inflate this figure on any
  // delegating session.
  const costPerLineDenominator = codeImpact?.linesTree ?? summary.linesChanged;
  const costPerLine =
    session.totalCost != null && costPerLineDenominator > 0
      ? session.totalCost / costPerLineDenominator
      : null;

  const imageCost =
    priceIn != null && summary.imageStats.estInputTokens > 0
      ? (summary.imageStats.estInputTokens / 1_000_000) * priceIn
      : null;

  // Distinct source tools and their image counts
  const imageSourceMap = new Map<string, number>();
  for (const turn of turns) {
    for (const img of turn.images) {
      imageSourceMap.set(
        img.toolName,
        (imageSourceMap.get(img.toolName) ?? 0) + 1,
      );
    }
  }
  const imageSources = Array.from(imageSourceMap.entries()).map(
    ([toolName, count]) => ({ toolName, count }),
  );

  return {
    subAgents,
    subAgentsTree,
    filesEditedWritten,
    cacheHitRate,
    cacheReadRatio: ratio,
    cacheWrite5mTokens: cacheWrite5m,
    cacheWrite1hTokens: cacheWrite1h,
    cacheWrite5mCost,
    cacheWrite1hCost,
    priceIn,
    priceOut,
    priceCacheR,
    priceCacheW,
    priceCacheW5m,
    priceCacheW1h,
    priceWebSearch,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    webSearchCost,
    inputFastCost,
    outputFastCost,
    totalCost,
    costPerLine,
    rulesDisplay,
    skillsBytes,
    skillsTokens,
    rulesBytes,
    rulesTokens,
    imageCost,
    imageSources,
  };
}

export interface McpServerBreakdown {
  server: string;
  total: number;
  tools: Array<[tool: string, count: number]>;
}

/**
 * Groups flat `mcp__server__tool` call counts by server, sorted by descending
 * total calls, each server's tools sorted by descending call count.
 * Extracted from `SessionInfoMcpSection.tsx`.
 */
export function groupMcpCallsByServer(
  mcpCalls: Record<string, number> | undefined,
): McpServerBreakdown[] {
  if (!mcpCalls || Object.keys(mcpCalls).length === 0) return [];

  const serverMap = new Map<string, Map<string, number>>();
  for (const [toolName, count] of Object.entries(mcpCalls)) {
    const parts = toolName.split('__');
    const server = parts.length >= 3 ? parts[1] : '__unknown__';
    const tool = parts.length >= 3 ? parts.slice(2).join('__') : toolName;
    if (!serverMap.has(server)) serverMap.set(server, new Map());
    serverMap.get(server)!.set(tool, count);
  }

  return Array.from(serverMap.entries())
    .map(([server, tools]) => ({
      server,
      total: Array.from(tools.values()).reduce((s, c) => s + c, 0),
      tools: Array.from(tools.entries()).sort((a, b) => b[1] - a[1]),
    }))
    .sort((a, b) => b.total - a.total);
}
