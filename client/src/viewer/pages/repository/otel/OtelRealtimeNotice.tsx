/**
 * The "Realtime data" badge and the realtime notice row of the OTEL tabs (2026-10-30
 * otel-tabs-traces, DD-14 / FR-32).
 *
 * | State | Notice |
 * |---|---|
 * | unconfirmed > 0 | Includes N calls received in realtime and not yet confirmed … |
 * | upload delayed | The regular upload is delayed (last at HH:MM) … |
 * | gap | Some realtime data was missed … |
 * | a delta with `fill` rows (session tab only) | Filled N calls / M spans … (transient) |
 *
 * The session tab feeds `status.realtime` (`otelNoticeFromSession`), the repository and team
 * tabs the scoped counts (`otelNoticeFromCounts`).
 */
import { Info } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import type {
  OtelRealtimeCounts,
  OtelSessionRealtimeStatus,
} from '../../../../models/repositories';
import type { OtelFilledCounts } from './otel-merge';
import { formatClock, formatCount } from './otel-format';
import { OtelHelpLink } from './OtelHelpLink';
import { OTEL_HELP_ANCHORS } from './otel.constants';

export interface OtelRealtimeNoticeInput {
  unconfirmedCalls: number;
  /** Session: 1 when delayed; repository / team: the number of delayed sessions. */
  chunkDelayedSessions: number;
  /** Session only: the last regular upload, for "last at HH:MM". */
  lastChunkAt: string | null;
  /** Session: 1 on a gap; repository / team: the number of sessions with a gap. */
  gapSessions: number;
  scope: 'session' | 'repository' | 'team';
}

export function otelNoticeFromSession(
  r: OtelSessionRealtimeStatus,
): OtelRealtimeNoticeInput {
  return {
    unconfirmedCalls: r.unconfirmedCalls,
    chunkDelayedSessions: r.chunkDelayed ? 1 : 0,
    lastChunkAt: r.lastChunkAt,
    gapSessions: r.gap ? 1 : 0,
    scope: 'session',
  };
}

export function otelNoticeFromCounts(
  c: OtelRealtimeCounts,
  scope: 'repository' | 'team',
): OtelRealtimeNoticeInput {
  return {
    unconfirmedCalls: c.unconfirmedCalls,
    chunkDelayedSessions: c.chunkDelayedSessions,
    lastChunkAt: null,
    gapSessions: c.gapSessions,
    scope,
  };
}

/** The notice texts for one input, in display order (pure, for the tests). */
export function otelRealtimeNotices(
  input: OtelRealtimeNoticeInput,
  filled: OtelFilledCounts,
): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const session = input.scope === 'session';
  if (input.unconfirmedCalls > 0) {
    const n = input.unconfirmedCalls;
    out.push({
      id: 'unconfirmed',
      text: `Includes ${formatCount(n)} call${n === 1 ? '' : 's'} received in realtime and not yet confirmed by the hook's regular upload — totals may still change.`,
    });
  }
  if (input.chunkDelayedSessions > 0) {
    out.push({
      id: 'delayed',
      text: session
        ? `The regular upload is delayed (last at ${formatClock(input.lastChunkAt)}); gaps are filled when it arrives.`
        : `The regular upload is delayed for ${formatCount(input.chunkDelayedSessions)} session${input.chunkDelayedSessions === 1 ? '' : 's'}; gaps are filled when it arrives.`,
    });
  }
  if (input.gapSessions > 0) {
    out.push({
      id: 'gap',
      text: session
        ? 'Some realtime data was missed (connection problems); it will be filled from the regular upload.'
        : `Some realtime data was missed in ${formatCount(input.gapSessions)} session${input.gapSessions === 1 ? '' : 's'} (connection problems); it will be filled from the regular upload.`,
    });
  }
  if (filled.calls > 0 || filled.spans > 0) {
    out.push({
      id: 'filled',
      text: `Filled ${formatCount(filled.calls)} call${filled.calls === 1 ? '' : 's'} / ${formatCount(filled.spans)} span${filled.spans === 1 ? '' : 's'} from the regular upload.`,
    });
  }
  return out;
}

/** The permanent badge next to the tab title. */
export function OtelRealtimeBadge() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700"
          data-testid="otel-realtime-badge"
        >
          <Info className="size-3" />
          Realtime data
        </TooltipTrigger>
        <TooltipContent className="max-w-[380px]">
          This tab combines two channels. The hook sends new calls and spans in
          realtime every few seconds while a session runs, so figures appear
          quickly but are preliminary. The hook's regular upload at the end of
          each turn then confirms them and fills anything the realtime channel
          missed.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface OtelRealtimeNoticeProps {
  input: OtelRealtimeNoticeInput;
  filled: OtelFilledCounts;
}

/** The notice row; renders nothing when there is nothing to say. */
export function OtelRealtimeNotice({ input, filled }: OtelRealtimeNoticeProps) {
  const notices = otelRealtimeNotices(input, filled);
  if (notices.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900"
      data-testid="otel-realtime-notices"
    >
      {notices.map((n) => (
        <p key={n.id} data-testid={`otel-notice-${n.id}`}>
          {n.text}
        </p>
      ))}
      <OtelHelpLink
        anchor={OTEL_HELP_ANCHORS.realtime}
        className="self-start text-xs"
      >
        What do these notices mean?
      </OtelHelpLink>
    </div>
  );
}
