/**
 * Pure derive for the Summary tab's executive band, extended details and per-prompt
 * cost table. React-free so it is unit-testable directly (`environment: 'node'`) and callable
 * from anywhere else that needs the same figures.
 *
 * See `docs/tasks/done/2026-08-12-session-summary-tab/impl-plan.md` for the exact rules this file implements — every formula below is pinned there,
 * not invented locally.
 */
import type { ModelPricingMap } from '../../../../../models/pricing';
import type {
  ChangeBand,
  ChangeSurfaceAggregate,
} from '../../../../../models/repositories';
import type { ParsedSession, PromptTurn } from '../types';
import type { SessionInfoDerived } from '../session-info-derive';
import type { TreeCodeImpact } from '../tree-code-impact';
import {
  computeTurnDirectAgentCost,
  computeWorkflowCostPerToken,
  getPromptText,
  stripSystemBlocks,
} from '../log-parser';
import { isSystemOnlyTurn } from '../PromptTurnList';
import { computeCost, truncate } from '../../../../lib/format';
import { PROMPT_COST_TEXT_MAX_CHARS } from './constants';

export interface PromptCostRow {
  /** `turn.index` — the 1-based global anchor index. */
  turnIndex: number;
  /** `stripSystemBlocks(getPromptText(turn))`, whitespace-collapsed, truncated. */
  promptText: string;
  /** `false` for a system-only turn (`promptText === ''`) — such a row is not clickable. */
  hasPrompt: boolean;
  /** Sum of `turn.tokenBreakdown`'s four token fields; `null` when the breakdown is absent. */
  totalTokens: number | null;
  /**
   * Full cost impact of this turn: its own main-thread tokens, plus that turn's directly
   * activated sub-agents (exact, priced from their own transcripts via
   * `computeTurnDirectAgentCost`), plus that turn's share of workflow-spawned agent cost, priced
   * via `computeWorkflowCostPerToken` — the same DB-accurate per-token rate `SessionLogView.tsx`
   * uses for a turn's displayed "+~$X" workflow addend, so the two never disagree. A prompt that
   * triggers expensive delegation shows that cost here rather than only its own main-thread
   * sliver. `null` — never `0` — when unpriced (breakdown, model, or pricing entry missing); the
   * delegation components add 0 when absent, never turn a priced row into `null`.
   */
  cost: number | null;
}

export interface SessionSummaryDerived {
  peakContextTokens: number | null;
  contextWindow: number | null;
  contextWindowPct: number | null;
  promptCount: number;
  assistantSteps: number;
  toolCalls: number;
  /**
   * Lines written across the whole session tree (root + every descendant sub-agent)
   * when a `codeImpact` is supplied, root-only otherwise. The Code-impact tile's headline.
   */
  linesChanged: number;
  linesAdded: number | null;
  linesRemoved: number | null;
  /** `Edit`/`Write`/`MultiEdit` calls, same scope as {@link linesChanged}. */
  filesTouched: number | null;
  /**
   * Of {@link diffTotalCalls}, how many edit calls carried a usable `structuredPatch`
   * and therefore contributed to `linesAdded`/`linesRemoved`. `null` when no source for the
   * pair was supplied. Lets the Code-impact tile say `no diff data (0 of N calls)` instead of
   * silently printing `+0 / −0`.
   */
  diffCoveredCalls: number | null;
  /** Total edit calls the diff-coverage figure is measured against. */
  diffTotalCalls: number | null;
  subAgentCount: number;
  workflowCount: number;
  delegationCostShare: number | null;
  delegationTokenShare: number | null;
  modelUsage: Array<{ model: string; steps: number }>;
  promptCosts: PromptCostRow[];
  /**
   * The session tree's change surface, straight off
   * `GET :repoId/sessions/:sessionId/change-surface`. `false` means the metric was never
   * computed for this session (an upload from before change surface existed, or no repo root was ever learned): every
   * companion field below is then `null`, **never** `0` — a `0` would read as "this session
   * changed nothing", which is a different and much stronger claim.
   */
  changeSurfaceComputed: boolean;
  /** Distinct in-repo changed paths — not Edit/Write call counts. */
  changeSurfaceChangedFiles: number | null;
  changeSurfaceFoldersTouched: number | null;
  /** Display names of the distinct top-level modules, server-sorted. */
  changeSurfaceTopLevelModules: string[] | null;
  /** 0-100 concentration score; `null` when the session changed no in-repo file. */
  changeSurfaceConcentration: number | null;
  /** Server-computed band — the client never re-derives a boundary. */
  changeSurfaceBand: ChangeBand | null;
  changeSurfaceFilesPerFolder: number | null;
  changeSurfaceSingleFileFolders: number | null;
  changeSurfaceCommonAncestorDepth: number | null;
  isIncomplete: boolean;
}

/** The empty result returned per the null-parse contract. */
const EMPTY_RESULT: SessionSummaryDerived = {
  peakContextTokens: null,
  contextWindow: null,
  contextWindowPct: null,
  promptCount: 0,
  assistantSteps: 0,
  toolCalls: 0,
  linesChanged: 0,
  linesAdded: null,
  linesRemoved: null,
  filesTouched: null,
  diffCoveredCalls: null,
  diffTotalCalls: null,
  subAgentCount: 0,
  workflowCount: 0,
  delegationCostShare: null,
  delegationTokenShare: null,
  modelUsage: [],
  promptCosts: [],
  changeSurfaceComputed: false,
  changeSurfaceChangedFiles: null,
  changeSurfaceFoldersTouched: null,
  changeSurfaceTopLevelModules: null,
  changeSurfaceConcentration: null,
  changeSurfaceBand: null,
  changeSurfaceFilesPerFolder: null,
  changeSurfaceSingleFileFolders: null,
  changeSurfaceCommonAncestorDepth: null,
  isIncomplete: true,
};

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/**
 * `modelUsage`: counted over raw main-log `type === 'assistant'` events
 * via `event.message?.model`, normalized by stripping the trailing date suffix — exactly what
 * `log-parser.ts` does for `summary.model` — sorted by `steps` descending.
 */
function computeModelUsage(
  mainLogs: Record<string, unknown>[] | null,
): Array<{ model: string; steps: number }> {
  if (!mainLogs) return [];
  const counts = new Map<string, number>();
  for (const raw of mainLogs) {
    if (raw['type'] !== 'assistant') continue;
    const message = asRecord(raw['message']);
    const rawModel = message ? message['model'] : undefined;
    if (typeof rawModel !== 'string' || rawModel === '') continue;
    const model = rawModel.replace(/-\d{8}$/, '');
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([model, steps]) => ({ model, steps }))
    .sort((a, b) => b.steps - a.steps);
}

/** Sum of a turn's four token-breakdown fields; `null` when the breakdown is absent. */
function turnTotalTokens(turn: PromptTurn): number | null {
  const b = turn.tokenBreakdown;
  if (b === null) return null;
  return b.input + b.output + b.cacheRead + b.cacheWrite;
}

/**
 * This turn's share of workflow-spawned agent cost, at the DB-accurate `costPerToken` rate
 * (`computeWorkflowCostPerToken`) — `0` when the turn ran no workflow or the rate is unavailable,
 * never `null`, since this is only ever added to another component, not shown on its own. Mirrors
 * `PromptTurnItem.tsx`'s own `workflowCost` memo exactly.
 */
function turnWorkflowCost(
  turn: PromptTurn,
  costPerToken: number | null,
): number {
  if (costPerToken == null) return 0;
  const turnWorkflowTokens = (turn.workflows ?? []).reduce(
    (n, wf) => n + (wf.subagentTokens ?? 0),
    0,
  );
  return turnWorkflowTokens * costPerToken;
}

/**
 * `promptCosts` — one row per turn in `parsedLogs.turns`, in order. Each
 * row's `cost` is this turn's FULL impact (main thread + its direct sub-agents + its workflow
 * share), not just its main-thread sliver — see `PromptCostRow.cost`'s doc comment.
 */
function computePromptCosts(
  turns: PromptTurn[],
  model: string | undefined,
  pricing: ModelPricingMap | undefined,
  subagentLogsMap: Map<string, Record<string, unknown>[]> | undefined,
  agentParentMap: Map<string, string | null> | undefined,
  costPerToken: number | null,
): PromptCostRow[] {
  const entry = model != null ? pricing?.[model] : undefined;
  return turns.map((turn) => {
    const promptText = truncate(
      stripSystemBlocks(getPromptText(turn)).replace(/\s+/g, ' ').trim(),
      PROMPT_COST_TEXT_MAX_CHARS,
    );
    const hasPrompt = !isSystemOnlyTurn(turn);
    let cost: number | null = null;
    if (turn.tokenBreakdown != null && entry != null) {
      const mainCost = computeCost(turn.tokenBreakdown, entry);
      const directAgentCost =
        computeTurnDirectAgentCost(
          turn,
          subagentLogsMap,
          agentParentMap,
          pricing,
        ) ?? 0;
      cost = mainCost + directAgentCost + turnWorkflowCost(turn, costPerToken);
    }
    return {
      turnIndex: turn.index,
      promptText,
      hasPrompt,
      totalTokens: turnTotalTokens(turn),
      cost,
    };
  });
}

export function computeSessionSummaryDerived(input: {
  parsedLogs: ParsedSession | null;
  pricing: ModelPricingMap | undefined;
  info: SessionInfoDerived;
  /**
   * The own/tree code-impact pair from `computeTreeCodeImpact`. When present,
   * `linesChanged`/`filesTouched` become tree-scoped, so the Code-impact tile stops
   * contradicting the Delegation tile next to it. Optional: omitted, the derive keeps its
   * root-only figures.
   *
   * D1 — it is also the **only** source of the diff pair (`linesAdded`/`linesRemoved` and the
   * coverage): those come from `session_stats` via `/logs` `rootStats` + `subagentStats`, never
   * from the transcript walk. Omitted (or no `rootStats`), they are `null` — "no diff data".
   */
  codeImpact?: TreeCodeImpact | null;
  mainLogs: Record<string, unknown>[] | null;
  subagentLogsMap?: Map<string, Record<string, unknown>[]> | undefined;
  agentParentMap?: Map<string, string | null> | undefined;
  /** Server-computed sub-agent cost (`costBreakdown.subagentCost`, D2.3) — same field
   * `SessionLogView.tsx` uses to derive its own accurate workflow cost rate. */
  sessionSubagentCost?: number | null;
  /**
   * The session tree's change-surface aggregate, as fetched by the session detail
   * pane. Optional and nullable: absent (still loading, or an older client surface that does
   * not fetch it) is indistinguishable from `computed: false` here — both yield
   * `changeSurfaceComputed: false` and `null` companions, never zeros.
   */
  changeSurface?: ChangeSurfaceAggregate | null;
}): SessionSummaryDerived {
  const {
    parsedLogs,
    pricing,
    info,
    codeImpact,
    mainLogs,
    subagentLogsMap,
    agentParentMap,
    sessionSubagentCost,
    changeSurface,
  } = input;

  // Null-parse contract: live code, hit on every session open before
  // the shell's `parsedLogs === null` skeleton branch returns.
  if (parsedLogs === null) {
    return EMPTY_RESULT;
  }

  const { summary, turns } = parsedLogs;

  const promptCount = summary.promptCount;
  const assistantSteps = turns.reduce((n, t) => n + t.assistantSteps.length, 0);
  // Main-session turns only — sub-agent tool calls are the Delegation tile's job.
  const toolCalls = turns.reduce((n, t) => n + t.toolCalls.length, 0);
  // Tree-scoped when a `codeImpact` was supplied. `info.derived.filesEditedWritten`
  // is already tree-scoped whenever the same `codeImpact` was threaded into
  // `computeSessionInfoDerived`, so preferring `codeImpact.filesTree` here only matters for a
  // caller that threaded it into one and not the other — and keeps the two in step regardless.
  const linesChanged = codeImpact?.linesTree ?? summary.linesChanged;
  // D1 — the diff pair comes from `codeImpact` only (`rootStats` + `subagentStats`).
  const linesAdded = codeImpact?.linesAdded ?? null;
  const linesRemoved = codeImpact?.linesRemoved ?? null;
  const filesTouched =
    codeImpact?.filesTree ?? info.derived?.filesEditedWritten ?? null;
  const diffCoveredCalls = codeImpact?.diffCoveredCalls ?? null;
  const diffTotalCalls = codeImpact?.diffTotalCalls ?? null;
  // Tree-scoped on purpose: the Delegation tile sits beside the Code-impact tile, whose
  // secondary already counts every descendant, so the narrow `Task`-activation count read
  // `0 agents` next to `… in 11 sub-agents` on any workflow-driven session.
  const subAgentCount = info.derived?.subAgentsTree ?? 0;
  const workflowCount = info.workflowStats?.workflows.length ?? 0;

  // "Unparsed session" is a loaded-but-empty parse.
  const isIncomplete = promptCount === 0 && turns.length === 0;

  // Peak context computed once, `0` collapses to `null`.
  const peakContextTokensRaw = Math.max(
    summary.maxContextTokens ?? 0,
    ...turns.map((t) => t.contextTokens ?? 0),
  );
  const peakContextTokens = peakContextTokensRaw || null;

  // An explicit `model != null` guard is required for strict typing.
  const model = summary.model;
  const contextWindow =
    model != null ? (pricing?.[model]?.contextLength ?? null) : null;
  const contextWindowPct =
    peakContextTokens != null && contextWindow != null && contextWindow > 0
      ? peakContextTokens / contextWindow
      : null;

  // Delegation shares, denominators from `session-info-derive.ts`.
  const {
    subAgentCost,
    workflowEstimatedCost,
    showWorkflowCostRow,
    totalCostWithSubagents,
  } = info;
  const delegationCostShare =
    totalCostWithSubagents != null && totalCostWithSubagents > 0
      ? ((subAgentCost ?? 0) +
          (showWorkflowCostRow ? (workflowEstimatedCost ?? 0) : 0)) /
        totalCostWithSubagents
      : null;
  const delegationTokenShare =
    summary.totalTokens === 0
      ? null
      : info.workflowSubagentTokens / summary.totalTokens;

  const modelUsage = computeModelUsage(mainLogs);
  const costPerToken = computeWorkflowCostPerToken(
    parsedLogs,
    pricing,
    sessionSubagentCost,
    subagentLogsMap,
    agentParentMap,
  );
  // Pass-through, not a derivation: every figure below is the server's, and a
  // never-computed (or absent) aggregate collapses to nulls rather than zeros.
  const cs =
    changeSurface != null && changeSurface.computed ? changeSurface : null;

  const promptCosts = computePromptCosts(
    turns,
    model,
    pricing,
    subagentLogsMap,
    agentParentMap,
    costPerToken,
  );

  return {
    peakContextTokens,
    contextWindow,
    contextWindowPct,
    promptCount,
    assistantSteps,
    toolCalls,
    linesChanged,
    linesAdded,
    linesRemoved,
    filesTouched,
    diffCoveredCalls,
    diffTotalCalls,
    subAgentCount,
    workflowCount,
    delegationCostShare,
    delegationTokenShare,
    modelUsage,
    promptCosts,
    changeSurfaceComputed: cs !== null,
    changeSurfaceChangedFiles: cs?.changedFiles ?? null,
    changeSurfaceFoldersTouched: cs?.foldersTouched ?? null,
    changeSurfaceTopLevelModules: cs?.topLevelModules ?? null,
    changeSurfaceConcentration: cs?.concentration ?? null,
    changeSurfaceBand: cs?.band ?? null,
    changeSurfaceFilesPerFolder: cs?.filesPerFolder ?? null,
    changeSurfaceSingleFileFolders: cs?.singleFileFolders ?? null,
    changeSurfaceCommonAncestorDepth: cs?.commonAncestorDepth ?? null,
    isIncomplete,
  };
}
