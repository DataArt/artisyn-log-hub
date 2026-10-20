import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { formatLocalTimestamp } from '../../../lib/format';
import { RawLogsExpandedView } from './raw-logs/renderers';
import type { ParsedSession, PromptTurn } from './types';
import type { ModelPricingMap } from '../../../../models/pricing';
import { getIcon, getCollapsedSummary, sortRawLogs } from './raw-logs/utils';
import { TurnHeader } from './TurnHeader';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  rawLogs: Record<string, unknown>[];
  isLoading: boolean;
  parsedSession?: ParsedSession | null;
  pricing?: ModelPricingMap;
  sessionModel?: string;
}

export function RawLogsTab({
  rawLogs,
  isLoading,
  parsedSession,
  pricing,
  sessionModel,
}: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const sorted = sortRawLogs(
    rawLogs.filter((e) => e.type !== 'artisyn' && typeof e.type === 'string'),
  );

  if (sorted.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">No log entries.</p>
      </div>
    );
  }

  // Build uuid → {turn, displayIndex} map — displayIndex is 1-based sequential position
  // among turns visible in this raw log view, not the global log message index.
  const uuidToTurn = new Map<
    string,
    { turn: PromptTurn; displayIndex: number }
  >();
  let turnCounter = 0;
  for (const turn of parsedSession?.turns ?? []) {
    if (turn.userEvent.uuid) {
      turnCounter++;
      uuidToTurn.set(turn.userEvent.uuid, { turn, displayIndex: turnCounter });
    }
  }

  function toggleRow(idx: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  }

  return (
    <div className="overflow-y-auto overflow-x-hidden h-full">
      <table className="w-full text-sm border-collapse table-fixed">
        <thead className="sticky top-0 z-10 bg-background border-b border-border">
          <tr>
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3 w-40 whitespace-nowrap">
              Timestamp
            </th>
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3 w-44 whitespace-nowrap">
              Type
            </th>
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">
              Message
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry, idx) => {
            const isOpen = expanded.has(idx);
            const Icon = getIcon(entry.type);
            const typeLabel =
              typeof entry.type === 'string' ? entry.type : '(unknown)';
            const timestamp =
              typeof entry.timestamp === 'string'
                ? formatLocalTimestamp(entry.timestamp)
                : '—';
            const summary = getCollapsedSummary(entry);
            const entryUuid =
              typeof entry.uuid === 'string' ? entry.uuid : undefined;
            const turnEntry = entryUuid ? uuidToTurn.get(entryUuid) : undefined;

            return (
              <Fragment key={idx}>
                {turnEntry && (
                  <TurnHeader
                    displayIndex={turnEntry.displayIndex}
                    turn={turnEntry.turn}
                    pricing={pricing}
                    sessionModel={sessionModel}
                  />
                )}
                <tr
                  onClick={() => toggleRow(idx)}
                  className="cursor-pointer border-b border-border/50 hover:bg-muted/30 transition-colors"
                >
                  <td className="py-1.5 px-3 w-40 shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground align-top">
                    {timestamp}
                  </td>
                  <td className="py-1.5 px-3 w-44 shrink-0 align-top">
                    <div className="flex items-center gap-1.5">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="text-xs font-mono">{typeLabel}</span>
                    </div>
                  </td>
                  <td className="py-1.5 px-3 align-top overflow-hidden">
                    <div className="flex items-start gap-1 overflow-hidden">
                      {isOpen ? (
                        <ChevronDown className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                      )}
                      {!isOpen && (
                        <span className="text-xs text-muted-foreground truncate">
                          {summary}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-border/50 bg-muted/20">
                    <td />
                    <td />
                    <td className="py-2 px-3 overflow-hidden">
                      <div className="overflow-x-auto">
                        <RawLogsExpandedView entry={entry} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
