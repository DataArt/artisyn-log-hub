/**
 * The `Live` header entry (2026-11-04 otel-live-view, DD-14 / DD-15 / DD-17).
 *
 * Polls `GET /api/v1/otel/live/status` every `LIVE_STATUS_POLL_MS` while the page is visible,
 * shows a red pulsing dot while anything is live, and opens the Live modal (`?live=home`).
 * The modal lives in the lazily loaded repository-tabs chunk and mounts while `?live=` is set,
 * so a shared link opens it on any page that has the header.
 */
import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Radio } from 'lucide-react';
import { fetchOtelLiveStatus } from '../../api';
import type { OtelLiveStatusResponse } from '../../../models/otel-live';
import { Button } from '../../ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../ui/tooltip';
import { formatMicrosUsd } from '../../pages/repository/otel/otel-format';
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

function statusTooltip(status: OtelLiveStatusResponse | undefined): string {
  if (!status?.live) return 'Nothing live right now';
  const parts = [plural(status.liveSessions, 'session', 'sessions')];
  if (status.liveAgents != null) {
    parts.push(plural(status.liveAgents, 'agent', 'agents'));
  }
  if (status.costUsdMicros != null) {
    parts.push(formatMicrosUsd(status.costUsdMicros));
  }
  return `Live now: ${parts.join(' · ')}`;
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
              className={liveKey !== null ? 'bg-accent' : undefined}
              onClick={open}
            >
              <span className="relative inline-flex">
                <Radio className="size-4" />
                {live && (
                  <span
                    className="absolute -top-0.5 -right-0.5 flex size-2"
                    data-testid="nav-live-dot"
                  >
                    <span className="absolute inline-flex size-full rounded-full bg-red-400/60 animate-ping motion-reduce:animate-none" />
                    <span className="relative inline-flex size-2 rounded-full bg-red-500" />
                  </span>
                )}
              </span>
              Live
            </Button>
          </TooltipTrigger>
          <TooltipContent variant="light" side="bottom">
            {statusTooltip(status)}
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
