import type { ReactNode } from 'react';
import type { AssistantStep } from '../../types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import { formatStepDelta, type StepBar } from './step-bars';
import { fullToolDetail, stepLabel } from './step-label';
import { useToolView } from '../../tool-call-view/ToolViewContext';
import { toRepoRelative } from '@loghub/bash-view';

interface Props {
  step: AssistantStep;
  si: number;
  stepCount: number;
  bar: StepBar;
  maxContextTokens: number;
  barMaxPx: number;
  /** Pixels for `maxContextTokens` — `barMaxPx` minus the room kept for a tier marker. */
  scalePx: number;
  /** Drawn right of the bar, e.g. the long-context tier marker; null for none. */
  marker: ReactNode;
  leftLabelW: number;
  rightLabelW: number;
  /** Opens the step modal for step `si` (DD-9). */
  onOpen: (si: number) => void;
}

function formatTime(ts: string | null): string | null {
  return ts
    ? new Date(ts).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : null;
}

/** Tooltip body: delta line, assistant text, full tool details and stop reason. */
function StepTooltipBody({ step, bar }: { step: AssistantStep; bar: StepBar }) {
  const names = step.toolCallNames;
  const summaries = step.toolCallSummaries;
  const inputs = step.toolCallInputs;
  const { repoRoot } = useToolView();
  return (
    <div className="space-y-1.5 max-w-xs">
      {bar.delta !== null && (
        <div className="font-medium">
          {formatStepDelta(bar.delta)} tokens · own output + tool results
        </div>
      )}
      {step.text && (
        <p className="italic text-muted-foreground leading-snug">
          {step.text.length > 180 ? step.text.slice(0, 180) + '…' : step.text}
        </p>
      )}
      {names.length > 0 && (
        <div className="space-y-0.5">
          {names.slice(0, 12).map((n, i) => {
            const detail = toRepoRelative(
              inputs[i] ? fullToolDetail(n, inputs[i]) : (summaries[i] ?? ''),
              repoRoot,
            );
            return (
              <div key={i} className="font-mono break-all">
                <span className="font-semibold">{n}</span>
                {detail && (
                  <span className="text-muted-foreground">: {detail}</span>
                )}
              </div>
            );
          })}
          {names.length > 12 && (
            <div className="text-muted-foreground">
              …and {names.length - 12} more
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
}

/**
 * One clickable sub-step row of an expanded Context Growth turn (DD-8, DD-9): the bar runs from
 * the step's own context to the next step's, the right label is the signed delta, and click or
 * Enter/Space opens the step modal.
 */
export function ContextGrowthSubStepRow({
  step,
  si,
  stepCount,
  bar,
  maxContextTokens,
  barMaxPx,
  scalePx,
  marker,
  leftLabelW,
  rightLabelW,
  onOpen,
}: Props) {
  const priorPx = Math.round((bar.prior / maxContextTokens) * scalePx);
  const totalPx = Math.max(
    4,
    Math.round((bar.total / maxContextTokens) * scalePx),
  );
  // No blue segment on the last step; a zero-width one on a non-positive delta (DD-8).
  const deltaPx =
    bar.delta === null || bar.delta <= 0 ? 0 : Math.max(2, totalPx - priorPx);
  const { repoRoot } = useToolView();
  // Summaries are relativised before `stepLabel` truncates them, so the root never survives.
  const label = stepLabel(
    {
      ...step,
      toolCallSummaries: step.toolCallSummaries.map((x) =>
        toRepoRelative(x, repoRoot),
      ),
    },
    si,
    stepCount,
  );
  const timeLabel = formatTime(step.timestamp);

  return (
    <div
      data-testid="growth-step-row"
      role="button"
      tabIndex={0}
      className="group flex items-center cursor-pointer bg-muted/20 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      style={{ minHeight: 32 }}
      onClick={() => onOpen(si)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(si);
        }
      }}
    >
      {/* No accent */}
      <div className="w-[3px] shrink-0" />
      {/* Label — tooltip trigger only on the label area for correct positioning */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="py-1 pl-6 pr-2 shrink-0 text-xs text-muted-foreground flex flex-col justify-center"
              style={{ width: leftLabelW - 3 }}
            >
              <div className="flex items-center gap-1 truncate">
                <span className="shrink-0 opacity-40 text-[10px]">↳</span>
                <span className="truncate underline decoration-dotted underline-offset-2 group-hover:decoration-solid group-hover:text-foreground">
                  {label}
                </span>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            sideOffset={4}
            variant="light"
            className="text-xs max-w-sm"
          >
            <StepTooltipBody step={step} bar={bar} />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* Bar */}
      <div className="shrink-0 flex items-center" style={{ width: barMaxPx }}>
        <div className="flex items-center h-3">
          <div
            className={
              deltaPx > 0
                ? 'h-full rounded-l-sm opacity-40'
                : 'h-full rounded-sm opacity-40'
            }
            style={{ width: priorPx, background: '#bfdbfe' }}
          />
          {deltaPx > 0 && (
            <div
              className="h-full rounded-r-sm"
              style={{ width: deltaPx, background: '#3b82f6' }}
            />
          )}
        </div>
        {marker}
      </div>
      {/* Right label */}
      <div
        className="px-2 shrink-0 text-right text-muted-foreground"
        style={{ width: rightLabelW }}
      >
        <div className="text-xs" data-testid="growth-step-delta">
          {formatStepDelta(bar.delta)}
        </div>
        <div className="text-[10px] leading-tight">
          <span className="hidden text-primary font-medium group-hover:inline group-focus-visible:inline">
            details &rarr;
          </span>
          {timeLabel && (
            <span className="opacity-60 group-hover:hidden group-focus-visible:hidden">
              {timeLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
