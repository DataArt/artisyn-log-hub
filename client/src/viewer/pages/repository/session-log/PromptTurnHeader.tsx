import { Clock } from 'lucide-react';
import { formatDuration, formatWorkflowDuration } from './log-parser';
import { formatLocalTimestamp } from '../../../lib/format';
import { DetailTooltip } from '../../../components/DetailTooltip';
import type { PromptTurn } from './types';

interface Props {
  timestamp: string;
  workTimeMs: number | null;
  workflows: PromptTurn['workflows'];
}

export function PromptTurnHeader({ timestamp, workTimeMs, workflows }: Props) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="shrink-0 text-base leading-none text-sky-400">✦</span>
      <span className="text-sm text-muted-foreground">
        {formatLocalTimestamp(timestamp)}
      </span>
      {workTimeMs !== null && (
        <DetailTooltip
          rows={[
            {
              label: 'Autonomous work time',
              value:
                'How long Claude worked on this prompt — from receiving the message to delivering the response',
            },
          ]}
        >
          <span className="flex cursor-help items-center gap-1 text-sm text-muted-foreground">
            <Clock className="size-3 shrink-0" />
            {formatDuration(workTimeMs)}
          </span>
        </DetailTooltip>
      )}
      {workflows &&
        workflows.length > 0 &&
        (() => {
          const count = workflows.length;
          const totalDurationMs = workflows.reduce(
            (sum, wf) =>
              wf.status !== 'running' && wf.durationMs !== null
                ? sum + wf.durationMs
                : sum,
            0,
          );
          const hasDuration = workflows.some(
            (wf) => wf.status !== 'running' && wf.durationMs !== null,
          );
          return (
            <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">
              ⚡ {count} workflow{count > 1 ? 's' : ''}
              {hasDuration && ` · ${formatWorkflowDuration(totalDurationMs)}`}
            </span>
          );
        })()}
    </div>
  );
}
