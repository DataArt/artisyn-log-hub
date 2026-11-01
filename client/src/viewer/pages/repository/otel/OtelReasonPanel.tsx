/**
 * The session OTEL tab's no-data panel (2026-10-30 otel-shared-receiver, Visual/UX notes,
 * `wireframes/session-otel-tab-no-data.svg`). Shown in the dashed empty-state area when the
 * root's `otel-status` state is `none`, or when no hook ever reported one (`status` null).
 *
 * Top to bottom: a muted status line (only with a reported status), the reason's title and body
 * (`OTEL_REASON_MESSAGES`, DD-31), the shared "Still works / Not available" boxes (stacked under
 * 640 px), the help button and, with a reported status, the receiver's counts at Stop.
 */
import { Check, CircleSlash, X } from 'lucide-react';
import type { OtelStatusDto } from '../../../../models/repositories';
import { formatClock } from './otel-format';
import { OtelHelpLink } from './OtelHelpLink';
import {
  OTEL_NOT_AVAILABLE,
  OTEL_REASON_MESSAGES,
  OTEL_STILL_WORKS,
} from './otel.constants';

export interface OtelReasonPanelProps {
  /** The root's latest `otel-status` event; null → the generic `no-status` message. */
  status: OtelStatusDto | null;
}

/** `OTEL status: <state> · reason <key> · hook <v> · Claude Code <v> · forward <f>`. */
export function otelStatusLine(status: OtelStatusDto): string {
  return [
    `OTEL status: ${status.state}`,
    `reason ${status.reason ?? '—'}`,
    `hook ${status.hookVersion ?? 'unknown'}`,
    `Claude Code ${status.claudeVersion ?? 'unknown'}`,
    `forward ${status.forward ?? '—'}`,
  ].join(' · ');
}

/** `Received by the receiver at Stop: logs n · metrics n · spans n · first record <time|—>`. */
export function otelReceivedLine(received: OtelStatusDto['received']): string {
  return `Received by the receiver at Stop: logs ${received.logs} · metrics ${received.metrics} · spans ${received.spans} · first record ${formatClock(received.firstAt)}`;
}

export function OtelReasonPanel({ status }: OtelReasonPanelProps) {
  const key = status === null ? 'no-status' : (status.reason ?? 'unknown');
  const message = OTEL_REASON_MESSAGES[key];
  return (
    <div
      className="mx-auto flex max-w-[720px] flex-col gap-3 rounded-md border border-dashed px-6 py-6"
      data-testid="otel-reason-panel"
      data-reason={key}
    >
      {status !== null && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="otel-reason-status-line"
        >
          {otelStatusLine(status)}
        </p>
      )}
      <div className="flex items-start gap-2">
        <CircleSlash className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-semibold" data-testid="otel-reason-title">
            {message.title}
          </p>
          <p
            className="text-xs text-muted-foreground"
            data-testid="otel-reason-body"
          >
            {message.body}
          </p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
          <p className="mb-1 text-xs font-semibold text-emerald-900">
            Still works
          </p>
          <ul className="space-y-0.5 text-xs text-emerald-900">
            {OTEL_STILL_WORKS.map((item) => (
              <li key={item} className="flex items-center gap-1.5">
                <Check className="size-3.5 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="mb-1 text-xs font-semibold text-slate-700">
            Not available
          </p>
          <ul className="space-y-0.5 text-xs text-slate-700">
            {OTEL_NOT_AVAILABLE.map((item) => (
              <li key={item} className="flex items-center gap-1.5">
                <X className="size-3.5 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div>
        <OtelHelpLink variant="button" anchor={message.helpAnchor}>
          Help: {message.helpLabel}
        </OtelHelpLink>
      </div>
      {status !== null && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="otel-reason-received"
        >
          {otelReceivedLine(status.received)}
        </p>
      )}
    </div>
  );
}
