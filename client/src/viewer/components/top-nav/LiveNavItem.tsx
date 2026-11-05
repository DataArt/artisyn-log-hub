/**
 * The `Live` header entry (2026-11-04 otel-live-view, DD-14 / DD-15 / DD-17).
 *
 * Polls `GET /api/v1/otel/live/status` every `LIVE_STATUS_POLL_MS` while the page is visible,
 * shows a square activity icon — grey when idle, glowing green while anything is live
 * (`nav-live-dot`) — next to a per-minute token sparkline
 * (`spark`, 2026-11-05) — the tooltip sums it — and opens the Live modal (`?live=home`).
 * The modal lives in the lazily loaded repository-tabs chunk and mounts while `?live=` is set,
 * so a shared link opens it on any page that has the header.
 */
import { lazy, Suspense, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SquareActivity } from 'lucide-react';
import { fetchOtelLiveStatus } from '../../api';
import type { OtelLiveStatusResponse } from '../../../models/otel-live';
import { Button } from '../../ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../ui/tooltip';
import { cn } from '@/lib/cn';
import {
  formatMicrosUsd,
  formatTokenCount,
} from '../../pages/repository/otel/otel-format';
import { LiveSparkline } from './LiveSparkline';
import { usePixelSnap } from './usePixelSnap';
import {
  LIVE_STATUS_POLL_MS,
  LIVE_STATUS_QUERY_KEY,
} from '../../live/live.constants';
import { useLiveUrlState } from '../../live/useLiveUrlState';

const LiveModal = lazy(() =>
  import('../../pages/repository/repository-tabs-lazy-group').then((m) => ({
    default: m.LiveModal,
  })),
);

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function statusLine(status: OtelLiveStatusResponse | undefined): string {
  if (!status?.live) return 'Nothing live right now';
  const parts = [plural(status.liveSessions, 'session', 'sessions')];
  if (status.liveAgents != null) {
    parts.push(plural(status.liveAgents, 'agent', 'agents'));
  }
  if (status.costUsdMicros != null) {
    parts.push(`${formatMicrosUsd(status.costUsdMicros)} total`);
  }
  return `Live now: ${parts.join(' · ')}`;
}

/** `Last 15 min: 1.2 M tokens · $0.45`; null for a server without the sparkline. */
function sparkLine(status: OtelLiveStatusResponse | undefined): string | null {
  const spark = status?.spark;
  if (!spark) return null;
  const tokens = spark.tokens.reduce((a, b) => a + b, 0);
  const micros = spark.costUsdMicros.reduce((a, b) => a + Number(b), 0);
  return `Last ${spark.minutes} min: ${formatTokenCount(tokens)} tokens · ${formatMicrosUsd(micros)}`;
}

export function LiveNavItem() {
  const { liveKey, open } = useLiveUrlState();
  // Default refetchIntervalInBackground (false): polls only while the page is visible.
  const { data: status } = useQuery({
    queryKey: LIVE_STATUS_QUERY_KEY,
    queryFn: ({ signal }) => fetchOtelLiveStatus(signal),
    refetchInterval: LIVE_STATUS_POLL_MS,
  });
  const live = status?.live === true;
  const lastMinutes = sparkLine(status);
  const buttonRef = useRef<HTMLButtonElement>(null);
  usePixelSnap(buttonRef);

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-testid="nav-live"
              data-live={live ? 'true' : 'false'}
              aria-pressed={liveKey !== null}
              aria-label="Live"
              ref={buttonRef}
              className={cn(
                // 8 + 16 icon + 5 gap + 63 chart + 8 = 100; `has-[>svg]:px-2` undoes the
                // Button's 10 px icon padding (the chart svg is a direct child).
                'w-[100px] justify-start gap-[5px] px-2 has-[>svg]:px-2',
                liveKey !== null && 'bg-accent',
              )}
              onClick={open}
            >
              <span
                className="relative inline-flex size-4 shrink-0"
                data-testid={live ? 'nav-live-dot' : undefined}
              >
                {/* The glow is a box-shadow behind the icon's square, not a filter on
                    the icon: a filter blurs the thin strokes themselves. */}
                {live && (
                  <span className="absolute inset-[2px] rounded-[3px] shadow-[0_0_6px_1px_rgb(16_185_129/0.45)]" />
                )}
                <SquareActivity
                  className={cn(
                    'relative size-4',
                    live ? 'text-emerald-500' : 'text-muted-foreground',
                  )}
                />
              </span>
              <LiveSparkline values={status?.spark?.tokens ?? []} live={live} />
            </Button>
          </TooltipTrigger>
          <TooltipContent
            variant="light"
            side="bottom"
            className="flex flex-col gap-0.5"
            data-testid="nav-live-tooltip"
          >
            <span className="font-medium">{statusLine(status)}</span>
            {lastMinutes && <span>{lastMinutes}</span>}
            <span className="text-muted-foreground">Click for details</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {liveKey !== null && (
        <Suspense fallback={null}>
          <LiveModal />
        </Suspense>
      )}
    </>
  );
}
