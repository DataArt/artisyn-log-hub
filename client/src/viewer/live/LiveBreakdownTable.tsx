/**
 * Breakdown of the selected Live node (2026-11-04 otel-live-view, FR-5 / DD-9): its direct
 * children (`view.breakdown`) with the FR-5 columns, or for an agent node its latest calls
 * (`view.calls`). Ended rows are greyed. Clicking a row opens its details panel; session rows
 * carry "Open session ↗" (DD-16), which leaves the page and so closes the modal.
 */
import { cn } from '@/lib/cn';
import type {
  OtelLiveCallRow,
  OtelLiveNode,
  OtelLiveView,
} from '../../models/otel-live';
import {
  formatCount,
  formatMicrosUsd,
  formatTokenCount,
} from '../pages/repository/otel/otel-format';
import {
  formatLiveClock,
  formatLiveDuration,
  formatLiveSpanMs,
} from './live-format';
import {
  liveSessionTarget,
  useOpenLiveTarget,
  type LiveLinkTarget,
} from './live-links';
import { LiveNodeLabel } from './LiveTree';

export interface LiveBreakdownTableProps {
  node: OtelLiveNode;
  view: OtelLiveView;
  /** `generatedAt` of the answer, epoch ms (for "today" clock times). */
  now: number;
  onOpenPanel: (key: string) => void;
}

const TH = 'px-2 py-1 text-left font-medium whitespace-nowrap';
const TD = 'px-2 py-1 whitespace-nowrap';
const NUM = 'px-2 py-1 whitespace-nowrap text-right font-mono tabular-nums';

export const LIVE_DISTINCT_FOOTNOTE =
  'Parents count each session once; a session in several repos or teams appears under each.';

function NodeRows({
  rows,
  now,
  onOpenPanel,
  onOpen,
}: {
  rows: readonly OtelLiveNode[];
  now: number;
  onOpenPanel: (key: string) => void;
  onOpen: (target: LiveLinkTarget) => void;
}) {
  return rows.map((n) => {
    const t = n.totals;
    const target = liveSessionTarget(n);
    return (
      <tr
        key={n.key}
        className={cn(
          'cursor-pointer border-t border-border hover:bg-accent',
          !n.live && 'opacity-60',
        )}
        onClick={() => onOpenPanel(n.key)}
        data-testid="live-breakdown-row"
        data-key={n.key}
        data-live={n.live ? 'true' : 'false'}
      >
        <td className={cn(TD, 'max-w-[360px]')}>
          <div className="flex min-w-0 items-center gap-2">
            <LiveNodeLabel node={n} />
            {!n.live && (
              <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                ended
              </span>
            )}
            {target !== null && (
              <button
                type="button"
                className="shrink-0 text-xs text-primary hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(target);
                }}
                data-testid="live-breakdown-open-session"
              >
                Open session ↗
              </button>
            )}
          </div>
        </td>
        <td className={NUM}>{formatMicrosUsd(t.costUsdMicros)}</td>
        <td className={NUM}>{formatTokenCount(t.inputTokens)}</td>
        <td className={NUM}>{formatTokenCount(t.outputTokens)}</td>
        <td className={NUM}>{formatTokenCount(t.cacheReadTokens)}</td>
        <td className={NUM}>{formatTokenCount(t.cacheWriteTokens)}</td>
        <td className={NUM}>{formatCount(t.calls)}</td>
        <td className={NUM}>{formatLiveDuration(t.runningMs)}</td>
        <td className={NUM}>{formatLiveClock(t.lastActivityAt, now)}</td>
      </tr>
    );
  });
}

function CallsTable({
  calls,
  now,
}: {
  calls: readonly OtelLiveCallRow[];
  now: number;
}) {
  return (
    <table className="text-xs" data-testid="live-calls-table">
      <thead className="text-muted-foreground">
        <tr>
          <th className={TH}>Time</th>
          <th className={TH}>Model</th>
          <th className={TH}>Source</th>
          <th className={cn(TH, 'text-right')}>Cost</th>
          <th className={cn(TH, 'text-right')}>In/Out</th>
          <th className={cn(TH, 'text-right')}>Cache R</th>
          <th className={cn(TH, 'text-right')}>Duration</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c) => (
          <tr
            key={c.callKey}
            className="border-t border-border"
            data-testid="live-call-row"
          >
            <td className={cn(TD, 'font-mono')}>
              {formatLiveClock(c.eventTime, now)}
            </td>
            <td
              className={cn(TD, 'max-w-[200px] truncate')}
              title={c.model ?? ''}
            >
              {c.model ?? '—'}
            </td>
            <td
              className={cn(TD, 'max-w-[200px] truncate')}
              title={c.agentLabel}
            >
              {c.agentLabel}
              {c.structure !== 'main' && (
                <span className="ml-1 text-muted-foreground">
                  ({c.structure})
                </span>
              )}
            </td>
            <td className={NUM}>{formatMicrosUsd(c.costUsdMicros)}</td>
            <td className={NUM}>
              {formatTokenCount(c.inputTokens)} /{' '}
              {formatTokenCount(c.outputTokens)}
            </td>
            <td className={NUM}>{formatTokenCount(c.cacheReadTokens)}</td>
            <td className={NUM}>{formatLiveSpanMs(c.durationMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LiveBreakdownTable({
  node,
  view,
  now,
  onOpenPanel,
}: LiveBreakdownTableProps) {
  const onOpen = useOpenLiveTarget();

  if (node.type === 'agent') {
    const calls = view.calls ?? [];
    return (
      <section className="space-y-2" data-testid="live-breakdown">
        <h3 className="text-sm font-medium">Latest calls</h3>
        {calls.length === 0 ? (
          <p className="text-xs text-muted-foreground">No calls yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <CallsTable calls={calls} now={now} />
          </div>
        )}
      </section>
    );
  }

  const rows = view.breakdown;
  const title = node.type === 'session' ? 'Agents' : 'Breakdown';
  return (
    <section className="space-y-2" data-testid="live-breakdown">
      <h3 className="text-sm font-medium">
        {title}{' '}
        <span className="text-xs font-normal text-muted-foreground">
          · since start
        </span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing below this node.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-xs" data-testid="live-breakdown-table">
            <thead className="text-muted-foreground">
              <tr>
                <th className={TH}>Name</th>
                <th className={cn(TH, 'text-right')}>Cost</th>
                <th className={cn(TH, 'text-right')}>In</th>
                <th className={cn(TH, 'text-right')}>Out</th>
                <th className={cn(TH, 'text-right')}>Cache R</th>
                <th className={cn(TH, 'text-right')}>Cache W</th>
                <th className={cn(TH, 'text-right')}>Calls</th>
                <th className={cn(TH, 'text-right')}>Running</th>
                <th className={cn(TH, 'text-right')}>Last activity</th>
              </tr>
            </thead>
            <tbody>
              <NodeRows
                rows={rows}
                now={now}
                onOpenPanel={onOpenPanel}
                onOpen={onOpen}
              />
              {view.moreAgents > 0 && (
                <tr
                  className="border-t border-border text-muted-foreground"
                  data-testid="live-breakdown-more"
                >
                  <td className={TD} colSpan={9}>
                    +{view.moreAgents} more{' '}
                    {view.moreAgents === 1 ? 'agent' : 'agents'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {view.distinctFootnote && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="live-breakdown-footnote"
        >
          {LIVE_DISTINCT_FOOTNOTE}
        </p>
      )}
    </section>
  );
}
