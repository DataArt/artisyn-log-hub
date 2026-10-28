import { useState } from 'react';
import { cn } from '@/lib/cn';
import type { AssistantStep, PromptTurn, ToolCallDetail } from '../../types';
import { toolSection } from '../../tool-calls';
import { ToolCallView } from '../../tool-call-view/ToolCallView';
import { useToolView } from '../../tool-call-view/ToolViewContext';
import { toRepoRelative } from '@loghub/bash-view';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { formatStepDelta, stepBars } from './step-bars';

export interface StepSelection {
  turn: PromptTurn;
  si: number;
}

interface Props {
  selection: StepSelection | null;
  onClose: () => void;
  charsPerToken: number;
}

/**
 * The step's calls, in block order: each `toolCallIds` entry looked up in `turn.allToolCalls`; an
 * empty or unknown id renders from the step's own name and input with status `'missing'` (DD-10).
 */
function resolveStepCalls(
  turn: PromptTurn,
  step: AssistantStep,
): ToolCallDetail[] {
  const byId = new Map<string, ToolCallDetail>();
  for (const c of turn.allToolCalls) if (c.id) byId.set(c.id, c);
  return step.toolCallNames.map((name, i) => {
    const id = step.toolCallIds[i] ?? '';
    const found = id ? byId.get(id) : undefined;
    if (found) return found;
    return {
      id: id || undefined,
      name,
      input: step.toolCallInputs[i] ?? {},
      section: toolSection(name),
      status: 'missing',
    };
  });
}

/** Index of the call expanded by default: the only one, else the largest result (DD-10). */
function largestIndex(calls: ToolCallDetail[]): number {
  let best = 0;
  for (let i = 1; i < calls.length; i++) {
    if ((calls[i].result?.length ?? 0) > (calls[best].result?.length ?? 0))
      best = i;
  }
  return best;
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

function blockBorder(call: ToolCallDetail): string {
  if (call.status === 'error') return 'border-red-300';
  if (call.status === 'rejected') return 'border-amber-300';
  return 'border-border';
}

function StepBody({
  turn,
  si,
  charsPerToken,
}: StepSelection & { charsPerToken: number }) {
  const step = turn.assistantSteps[si];
  const { repoRoot } = useToolView();
  const calls = resolveStepCalls(turn, step);
  const largest = largestIndex(calls);
  // `null` → default (only the largest open); a boolean → every block open/closed. The epoch
  // remounts the blocks so their own open state restarts from the new default.
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  const [epoch, setEpoch] = useState(0);
  const setAll = (open: boolean) => {
    setAllOpen(open);
    setEpoch((e) => e + 1);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {calls.length > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{calls.length} calls</span>
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => setAll(true)}
          >
            Expand all
          </button>
          <span className="text-muted-foreground">/</span>
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => setAll(false)}
          >
            Collapse all
          </button>
        </div>
      )}
      {calls.map((call, i) => (
        <div
          key={`${call.id ?? 'noid'}-${i}-${epoch}`}
          data-testid="step-call-block"
          className={cn(
            'flex min-w-0 flex-col gap-1 rounded-md border p-3',
            blockBorder(call),
          )}
        >
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="font-mono">#{i + 1}</span>
            {step.toolCallSummaries[i] && (
              <span className="truncate">
                {toRepoRelative(step.toolCallSummaries[i], repoRoot)}
              </span>
            )}
            {calls.length > 1 && i === largest && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-medium uppercase tracking-wide">
                largest
              </span>
            )}
          </div>
          <ToolCallView
            call={call}
            charsPerToken={charsPerToken}
            turnFiles={turn.files}
            subAgents={turn.subAgents}
            defaultOpen={allOpen ?? i === largest}
          />
        </div>
      ))}
      {step.text && (
        <p className="whitespace-pre-wrap text-sm leading-snug">{step.text}</p>
      )}
      {step.stopReason && (
        <div className="text-xs text-muted-foreground">
          stop: {step.stopReason}
        </div>
      )}
    </div>
  );
}

/** Context Growth step modal (DD-10): the step's tool calls, its assistant text and stop reason. */
export function StepDetailsModal({ selection, onClose, charsPerToken }: Props) {
  const step = selection
    ? selection.turn.assistantSteps[selection.si]
    : undefined;
  const bar = selection ? stepBars(selection.turn)[selection.si] : undefined;
  const time = step ? formatTime(step.timestamp) : null;

  return (
    <Dialog
      open={selection !== null && step !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="step-details-modal"
        className="max-w-3xl xl:max-w-5xl 2xl:max-w-7xl max-h-[85vh] flex flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            Turn #{selection ? selection.turn.index + 1 : ''} · Step{' '}
            {selection ? selection.si + 1 : ''}
          </DialogTitle>
          <DialogDescription>
            &Delta; {bar ? formatStepDelta(bar.delta) : '—'} tokens
            {time && <> · {time}</>}
          </DialogDescription>
        </DialogHeader>
        {selection && step && (
          <div className="min-h-0 overflow-y-auto pr-1">
            <StepBody
              key={`${selection.turn.index}-${selection.si}`}
              turn={selection.turn}
              si={selection.si}
              charsPerToken={charsPerToken}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
