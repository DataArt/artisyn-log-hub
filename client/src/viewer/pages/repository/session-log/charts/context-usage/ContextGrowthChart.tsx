import { useState, useRef, useEffect } from 'react';
import { getPromptText, resolveCharsPerToken } from '../../log-parser';
import type { CompactBoundary, ParsedSession, PromptTurn } from '../../types';
import type { ModelPricingMap } from '../../../../../../models/pricing';
import { buildTurnSlices } from './context-data';
import { ContextUsageTable } from './ContextUsageTable';
import { ContextPieChart } from './ContextPieChart';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GrowthRow =
  | { kind: 'turn'; turn: PromptTurn }
  | {
      kind: 'boundary';
      boundary: CompactBoundary;
      /** contextTokensStart of the turn immediately after this compaction */
      nextTurnContextStart: number | null;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildGrowthRows(
  turns: PromptTurn[],
  boundaries: CompactBoundary[],
): GrowthRow[] {
  const rows: GrowthRow[] = [];
  const sorted = [...boundaries].sort((a, b) =>
    (a.timestamp ?? '') < (b.timestamp ?? '') ? -1 : 1,
  );

  // Precompute turn timestamps in ms for efficient epsilon and lookahead checks
  const turnTimes = turns.map((t) => {
    const ts = t.userEvent?.timestamp;
    return ts ? new Date(ts).getTime() : null;
  });

  let bIdx = 0;

  const pushBoundary = (b: CompactBoundary, nextTurnIdx: number) => {
    const nextTurnContextStart = turns[nextTurnIdx]?.contextTokensStart ?? null;
    const lastRow = rows[rows.length - 1];
    // Deduplicate: if the previous row is already a boundary (consecutive compaction
    // events in the same gap), keep the one with higher preTokens.
    if (lastRow?.kind === 'boundary') {
      if ((b.preTokens ?? 0) > (lastRow.boundary.preTokens ?? 0)) {
        rows[rows.length - 1] = {
          kind: 'boundary',
          boundary: b,
          nextTurnContextStart,
        };
      }
      return;
    }
    rows.push({ kind: 'boundary', boundary: b, nextTurnContextStart });
  };

  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    rows.push({ kind: 'turn', turn });

    const nextTurnTime = turnTimes[ti + 1] ?? null;

    while (bIdx < sorted.length) {
      const bTsStr = sorted[bIdx].timestamp;
      const bTsTime = bTsStr ? new Date(bTsStr).getTime() : null;

      if (nextTurnTime !== null) {
        if (bTsTime !== null && bTsTime - nextTurnTime <= 1_000) {
          // Boundary fires before or within 1 second of the next turn's start.
          // The 1s tolerance handles compact_boundary events that are logged
          // a few ms after the user event they precede (same-millisecond race).
          pushBoundary(sorted[bIdx], ti + 1);
          bIdx++;
        } else {
          // Boundary fires well after the next turn started.
          // Proximity fallback for continuation sessions: the compact_boundary
          // event can fire tens of seconds into the first turn of a new session
          // file, so timestamp-based placement alone is insufficient.
          const preT = sorted[bIdx].preTokens ?? 0;
          const curCtx = turn.contextTokens ?? 0;
          const nextCtx = turns[ti + 1]?.contextTokens ?? 0;
          const near =
            preT > 0 && curCtx > 0 && Math.abs(preT - curCtx) / preT < 0.3;
          // Context must have dropped by at least 30% — rules out growth turns
          const dropped = nextCtx > 0 && nextCtx < curCtx * 0.7;
          // Don't use proximity if a later turn is within 1s of this boundary;
          // the epsilon check will place it correctly at that slot instead.
          const hasLaterSlot =
            bTsTime !== null &&
            turnTimes
              .slice(ti + 2)
              .some((tTime) => tTime !== null && bTsTime - tTime <= 1_000);
          if (near && dropped && !hasLaterSlot) {
            pushBoundary(sorted[bIdx], ti + 1);
            bIdx++;
          } else {
            break;
          }
        }
      } else {
        // No next-turn timestamp: fall back to preTokens ≤ current turn's context
        const preTokens = sorted[bIdx].preTokens ?? 0;
        if (preTokens <= (turn.contextTokens ?? 0)) {
          pushBoundary(sorted[bIdx], ti + 1);
          bIdx++;
        } else {
          break;
        }
      }
    }
  }

  // Append any remaining boundaries
  while (bIdx < sorted.length) {
    pushBoundary(sorted[bIdx], turns.length);
    bIdx++;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fullToolDetail(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => String(v ?? '');
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return s(input.file_path);
    case 'Bash':
      return s(input.command);
    case 'Glob': {
      const parts = [s(input.pattern)];
      if (input.path) {
        const p = s(input.path);
        // Skip absolute paths (local machine root) — only show relative subdirs
        if (!/^([A-Za-z]:[\\/]|\/)/.test(p)) parts.push(`in ${p}`);
      }
      return parts.join(' ');
    }
    case 'Grep': {
      const parts = [s(input.pattern)];
      if (input.path) {
        const p = s(input.path);
        if (!/^([A-Za-z]:[\\/]|\/)/.test(p)) parts.push(`in ${p}`);
      }
      return parts.join(' ');
    }
    case 'Agent':
      return s(input.description ?? input.prompt);
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEFT_LABEL_W = 180;
const RIGHT_LABEL_W = 120;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  session: ParsedSession;
  pricing?: ModelPricingMap;
}

export function ContextGrowthChart({ session, pricing }: Props) {
  const charsPerToken = resolveCharsPerToken(pricing, session.summary.model);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<PromptTurn | null>(null);
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(760);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const barMaxPx = Math.max(
    80,
    containerWidth - LEFT_LABEL_W - RIGHT_LABEL_W - 20,
  );

  function toggleExpand(turnIndex: number, e: React.MouseEvent) {
    e.stopPropagation();
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnIndex)) next.delete(turnIndex);
      else next.add(turnIndex);
      return next;
    });
  }

  const turns = session.turns;
  const maxContextTokens = Math.max(
    0,
    ...turns.map((t) => t.contextTokens ?? 0),
  );

  if (maxContextTokens === 0 || turns.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No context data available
      </div>
    );
  }

  const rows = buildGrowthRows(turns, session.compactBoundaries ?? []);

  let turnIndex = 0;

  return (
    <>
      <div
        ref={containerRef}
        className="rounded-md border border-border bg-card"
      >
        {/* Card header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <span className="text-sm font-medium">
            {turns.length} LLM calls · peak{' '}
            {Math.round(maxContextTokens / 1000)}k tokens
          </span>
          {/* Legend */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#bfdbfe]" />
              Prior context
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#3b82f6]" />
              New delta
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#fde68a] border border-[#fbbf24]" />
              User turn
            </span>
          </div>
        </div>

        {/* Column headers */}
        <div className="flex items-center px-4 py-1 border-b border-border text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <div style={{ width: LEFT_LABEL_W }}>PROMPT</div>
          <div style={{ width: barMaxPx }}>CONTEXT GROWTH</div>
          <div style={{ width: RIGHT_LABEL_W }} className="text-right">
            TOKENS
          </div>
        </div>

        {/* Rows */}
        {rows.map((row, i) => {
          if (row.kind === 'boundary') {
            const { boundary, nextTurnContextStart } = row;
            const preK = Math.round((boundary.preTokens ?? 0) / 1000);
            const postK = Math.round((boundary.postTokens ?? 0) / 1000);
            const nextK =
              nextTurnContextStart != null
                ? Math.round(nextTurnContextStart / 1000)
                : null;
            return (
              <div
                key={`boundary-${i}`}
                className="mx-4 my-1 flex items-center gap-2"
              >
                <div className="flex-1 border-t border-dashed border-amber-400" />
                <span
                  className="shrink-0 rounded px-2 py-0.5 text-xs font-medium"
                  style={{
                    background: '#fef3c7',
                    border: '1px solid #fcd34d',
                    color: '#92400e',
                  }}
                >
                  &#9889; Compaction: {preK}k &rarr; {postK}k
                  {nextK != null && (
                    <span className="opacity-70 font-normal">
                      {' '}
                      · next: {nextK}k
                    </span>
                  )}
                </span>
                <div className="flex-1 border-t border-dashed border-amber-400" />
              </div>
            );
          }

          // turn row
          const { turn } = row;
          const currentTurnIdx = turnIndex;
          turnIndex++;

          const contextTokens = turn.contextTokens;
          const contextTokensStart = turn.contextTokensStart;
          const priorPx = Math.round(
            ((contextTokensStart ?? 0) / maxContextTokens) * barMaxPx,
          );
          const totalPx = Math.max(
            4,
            Math.round(((contextTokens ?? 0) / maxContextTokens) * barMaxPx),
          );
          const deltaPx = totalPx - priorPx;

          const promptText = getPromptText(turn);
          const isUserTurn = promptText.trim() !== '';

          const truncatedLabel =
            promptText.length > 30 ? promptText.slice(0, 30) + '…' : promptText;

          // Right label
          let rightLabel: string;
          if (contextTokens === null) {
            rightLabel = '—';
          } else if (contextTokensStart === null || contextTokensStart === 0) {
            rightLabel = `${Math.round(contextTokens / 1000)}k tok`;
          } else {
            const priorK = Math.round(contextTokensStart / 1000);
            const deltaK = Math.round(
              (contextTokens - contextTokensStart) / 1000,
            );
            rightLabel = `${priorK}k + ${deltaK}k`;
          }

          const isHovered = hoveredIdx === currentTurnIdx;

          const steps = turn.assistantSteps ?? [];
          const hasSubSteps = steps.length > 1;
          const isExpanded = expandedTurns.has(turn.index);

          return (
            <div key={`turn-${turn.index}`}>
              <div
                data-testid="growth-row"
                className="flex items-center cursor-pointer transition-colors"
                style={{ background: isHovered ? '#eff6ff' : undefined }}
                onMouseEnter={() => setHoveredIdx(currentTurnIdx)}
                onMouseLeave={() => setHoveredIdx(null)}
                onClick={() => setSelectedTurn(turn)}
              >
                {/* Yellow accent for user turns */}
                {isUserTurn ? (
                  <div className="w-[3px] shrink-0 self-stretch bg-[#fbbf24]" />
                ) : (
                  <div className="w-[3px] shrink-0" />
                )}

                {/* Left label */}
                <div
                  className="py-1 pl-1 pr-2 shrink-0 flex items-center gap-1 text-xs truncate"
                  style={{ width: LEFT_LABEL_W - 3 }}
                >
                  {hasSubSteps ? (
                    <button
                      className="shrink-0 text-muted-foreground hover:text-foreground leading-none"
                      onClick={(e) => toggleExpand(turn.index, e)}
                      title={isExpanded ? 'Collapse steps' : 'Expand steps'}
                    >
                      {isExpanded ? '▾' : '▶'}
                    </button>
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  {isUserTurn ? (
                    <span className="truncate">
                      #{turn.index + 1} &mdash; {truncatedLabel}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic truncate">
                      #{turn.index + 1} &mdash; tool results
                    </span>
                  )}
                </div>

                {/* Bar */}
                <div
                  className="py-1 shrink-0 flex items-center"
                  style={{ width: barMaxPx }}
                >
                  {contextTokens === null ? (
                    <div className="text-xs text-muted-foreground">&mdash;</div>
                  ) : contextTokensStart === null ||
                    contextTokensStart === 0 ? (
                    /* First call: entire bar is delta */
                    <div
                      className="h-4 rounded-sm bg-[#3b82f6]"
                      style={{ width: totalPx }}
                    />
                  ) : (
                    /* Prior + delta */
                    <div className="flex items-center h-4">
                      <div
                        className="h-full rounded-l-sm bg-[#bfdbfe]"
                        style={{ width: priorPx }}
                      />
                      <div
                        className="h-full rounded-r-sm bg-[#3b82f6]"
                        style={{ width: Math.max(2, deltaPx) }}
                      />
                    </div>
                  )}
                </div>

                {/* Right label */}
                <div
                  className="py-1 px-2 shrink-0 text-xs text-right text-muted-foreground"
                  style={{ width: RIGHT_LABEL_W }}
                >
                  {isHovered ? (
                    <span className="text-primary font-medium">
                      click to inspect &rarr;
                    </span>
                  ) : (
                    rightLabel
                  )}
                </div>
              </div>

              {/* Sub-step rows */}
              {hasSubSteps &&
                isExpanded &&
                steps.map((step, si) => {
                  const prevCtx =
                    si === 0
                      ? (turn.contextTokensStart ?? 0)
                      : steps[si - 1].contextTokens;
                  const stepPriorPx = Math.round(
                    (prevCtx / maxContextTokens) * barMaxPx,
                  );
                  const stepTotalPx = Math.max(
                    4,
                    Math.round(
                      (step.contextTokens / maxContextTokens) * barMaxPx,
                    ),
                  );
                  const stepDeltaPx = stepTotalPx - stepPriorPx;
                  const deltaK = Math.round(
                    (step.contextTokens - prevCtx) / 1000,
                  );

                  const rawNames = step.toolCallNames;
                  const rawSummaries = step.toolCallSummaries ?? [];
                  const rawInputs = step.toolCallInputs ?? [];
                  let stepLabel: string;
                  if (rawNames.length === 0) {
                    stepLabel =
                      si === steps.length - 1 ? 'final' : `step ${si + 1}`;
                  } else if (rawNames.length === 1) {
                    const summary = rawSummaries[0] ?? '';
                    stepLabel = summary
                      ? `${rawNames[0]}: ${summary}`
                      : rawNames[0];
                  } else {
                    const first = rawNames[0];
                    const firstSummary = rawSummaries[0] ?? '';
                    const firstPart = firstSummary
                      ? `${first}: ${firstSummary}`
                      : first;
                    const truncFirst =
                      firstPart.length > 28
                        ? firstPart.slice(0, 28) + '…'
                        : firstPart;
                    stepLabel = `${truncFirst} (+${rawNames.length - 1})`;
                  }

                  const timeLabel = step.timestamp
                    ? new Date(step.timestamp).toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                      })
                    : null;

                  // Tooltip content: full tool details + assistant text + stop reason
                  const tooltipContent = (
                    <div className="space-y-1.5 max-w-xs">
                      {step.text && (
                        <p className="italic text-muted-foreground leading-snug">
                          {step.text.length > 180
                            ? step.text.slice(0, 180) + '…'
                            : step.text}
                        </p>
                      )}
                      {rawNames.length > 0 && (
                        <div className="space-y-0.5">
                          {rawNames.slice(0, 12).map((n, i) => {
                            const detail = rawInputs[i]
                              ? fullToolDetail(n, rawInputs[i])
                              : (rawSummaries[i] ?? '');
                            return (
                              <div key={i} className="font-mono break-all">
                                <span className="font-semibold">{n}</span>
                                {detail && (
                                  <span className="text-muted-foreground">
                                    : {detail}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                          {rawNames.length > 12 && (
                            <div className="text-muted-foreground">
                              …and {rawNames.length - 12} more
                            </div>
                          )}
                        </div>
                      )}
                      {step.stopReason && (
                        <div className="text-muted-foreground border-t border-border/40 pt-1">
                          stop: {step.stopReason}
                        </div>
                      )}
                    </div>
                  );

                  return (
                    <div
                      key={`step-${turn.index}-${si}`}
                      className="flex items-center bg-muted/20 hover:bg-muted/40"
                      style={{ minHeight: 32 }}
                    >
                      {/* No accent */}
                      <div className="w-[3px] shrink-0" />
                      {/* Label — tooltip trigger only on the label area for correct positioning */}
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className="py-1 pl-6 pr-2 shrink-0 text-xs text-muted-foreground flex flex-col justify-center cursor-default"
                              style={{ width: LEFT_LABEL_W - 3 }}
                            >
                              <div className="flex items-center gap-1 truncate">
                                <span className="shrink-0 opacity-40 text-[10px]">
                                  ↳
                                </span>
                                <span className="truncate">{stepLabel}</span>
                              </div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent
                            side="bottom"
                            sideOffset={4}
                            variant="light"
                            className="text-xs max-w-sm"
                          >
                            {tooltipContent}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      {/* Bar */}
                      <div
                        className="shrink-0 flex items-center"
                        style={{ width: barMaxPx }}
                      >
                        <div className="flex items-center h-3">
                          <div
                            className="h-full rounded-l-sm opacity-40"
                            style={{
                              width: stepPriorPx,
                              background: '#bfdbfe',
                            }}
                          />
                          <div
                            className="h-full rounded-r-sm"
                            style={{
                              width: Math.max(2, stepDeltaPx),
                              background: '#3b82f6',
                            }}
                          />
                        </div>
                      </div>
                      {/* Right label */}
                      <div
                        className="px-2 shrink-0 text-right text-muted-foreground"
                        style={{ width: RIGHT_LABEL_W }}
                      >
                        <div className="text-xs">
                          {si === 0
                            ? `${Math.round(step.contextTokens / 1000)}k tok`
                            : `+${Math.max(0, deltaK)}k`}
                        </div>
                        {timeLabel && (
                          <div className="text-[10px] opacity-60 leading-tight">
                            {timeLabel}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}

        {/* Scale ruler */}
        <div className="px-4 pt-1 pb-2 border-t border-border">
          <div style={{ marginLeft: LEFT_LABEL_W }}>
            <div style={{ width: barMaxPx }}>
              <div className="flex justify-between text-xs text-muted-foreground mb-0.5">
                <span>0</span>
                <span>{Math.round(maxContextTokens / 1000)}k (max)</span>
              </div>
              <div className="border-t border-muted-foreground w-full" />
            </div>
          </div>
        </div>
      </div>

      {/* Click-to-inspect modal */}
      <Dialog
        open={selectedTurn !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedTurn(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Turn #{selectedTurn ? selectedTurn.index + 1 : ''} &mdash; Context
              Breakdown
            </DialogTitle>
            <DialogDescription>
              LLM call context at this point in the session
            </DialogDescription>
          </DialogHeader>
          {selectedTurn &&
            (() => {
              const slices = buildTurnSlices(selectedTurn, 0, charsPerToken);
              return (
                <div className="grid grid-cols-2 gap-6">
                  <ContextUsageTable slices={slices} />
                  <div className="flex justify-center">
                    <ContextPieChart slices={slices} size={220} />
                  </div>
                </div>
              );
            })()}
          <p className="text-xs text-muted-foreground mt-2">
            Raw text is not stored &mdash; breakdown is estimated from token
            counts
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
