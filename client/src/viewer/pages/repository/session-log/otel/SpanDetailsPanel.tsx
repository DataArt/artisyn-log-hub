/**
 * Details of the selected waterfall span (2026-10-30 otel-tabs-traces, `session-otel-tab.svg`
 * marker 4): request_id, query_source, agent_id, model + ttft, tokens, cache, cost and its source,
 * context, confirmed / realtime, and the raw attributes ("show all raw (N)"), or "hidden for your
 * role" when the server masked them (DD-22). The selection is kept across live updates.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import type { OtelCallRow } from '../../../../../models/repositories';
import { formatDuration } from '../../../../lib/format';
import { formatCount, formatMicrosUsd } from '../../otel/otel-format';
import type { OtelTraceNode } from './otel-trace-assembly';
import { OTEL_SPAN_LLM_REQUEST } from './otel-trace-assembly';
import {
  otelSpanDurationMs,
  otelSpanModel,
  otelSpanNumberAttr,
} from './otel-span-format';

export interface SpanDetailsPanelProps {
  node: OtelTraceNode;
  call: OtelCallRow | undefined;
  attributesMasked: boolean;
  onClose: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono">{children}</dd>
    </>
  );
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

function tokenPair(a: number | null, b: number | null): string {
  return `${formatCount(a)} / ${formatCount(b)}`;
}

export function SpanDetailsPanel({
  node,
  call,
  attributesMasked,
  onClose,
}: SpanDetailsPanelProps) {
  const [rawOpenFor, setRawOpenFor] = useState<string | null>(null);
  const span = node.span;

  if (span === null) {
    return (
      <aside
        className="rounded-md border bg-background p-3 text-xs"
        data-testid="otel-span-details"
      >
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold">Turn in progress</p>
          <CloseButton onClose={onClose} />
        </div>
        <p className="mt-1 text-muted-foreground">
          The turn&apos;s root span has not been received yet; Claude Code
          exports a span when it ends. {node.children.length} span
          {node.children.length === 1 ? '' : 's'} wait for their parent.
        </p>
      </aside>
    );
  }

  const isLlm = span.name === OTEL_SPAN_LLM_REQUEST;
  const attrs = span.attributes;
  const attrCount = attrs ? Object.keys(attrs).length : 0;
  const rawOpen = rawOpenFor === node.key;
  const ttft = otelSpanNumberAttr(span, 'ttft_ms');
  const model = otelSpanModel(span, call);
  const duration = otelSpanDurationMs(span);
  const inTok = call?.inputTokens ?? otelSpanNumberAttr(span, 'input_tokens');
  const outTok =
    call?.outputTokens ?? otelSpanNumberAttr(span, 'output_tokens');
  const cacheRead =
    call?.cacheReadTokens ?? otelSpanNumberAttr(span, 'cache_read_tokens');
  const cacheWrite =
    call?.cacheWriteTokens ?? otelSpanNumberAttr(span, 'cache_creation_tokens');

  return (
    <aside
      className="rounded-md border bg-background p-3 text-xs"
      data-testid="otel-span-details"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-all">
          <span className="text-muted-foreground">span </span>
          <span className="font-mono font-semibold">{span.name}</span>
          <span className="text-muted-foreground">
            {' '}
            · {shortId(span.spanId)}
          </span>
        </p>
        <CloseButton onClose={onClose} />
      </div>
      <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
        {span.requestId && <Field label="request_id">{span.requestId}</Field>}
        {span.querySource && (
          <Field label="query_source">{span.querySource}</Field>
        )}
        {span.agentId && <Field label="agent_id">{span.agentId}</Field>}
        {model && (
          <Field label="model">
            {model}
            {ttft !== null && ` · ttft ${formatCount(Math.round(ttft))} ms`}
          </Field>
        )}
        {isLlm && (
          <>
            <Field label="tokens in / out">{tokenPair(inTok, outTok)}</Field>
            <Field label="cache read / write">
              {tokenPair(cacheRead, cacheWrite)}
            </Field>
          </>
        )}
        {isLlm && (
          <Field label="cost">
            {node.costUsdMicros !== null
              ? `${formatMicrosUsd(node.costUsdMicros)}  (api_request by request_id)`
              : 'no matching api_request yet'}
            {span.hidden === true && (
              <span className="ml-1 text-red-600">· hidden call</span>
            )}
          </Field>
        )}
        {!isLlm && node.children.length > 0 && (
          <Field label="Σ cost">
            {formatMicrosUsd(node.rollupCostUsdMicros)}
          </Field>
        )}
        <Field label="duration">
          {duration === null ? 'running' : formatDuration(duration)}
        </Field>
        {span.context && <Field label="context">{span.context}</Field>}
        <Field label="data">
          {span.confirmed ? (
            'confirmed by the regular upload'
          ) : (
            <span className="text-amber-700">realtime, not yet confirmed</span>
          )}
        </Field>
        <Field label="attributes">
          {attributesMasked || attrs === null ? (
            <span className="text-muted-foreground">hidden for your role</span>
          ) : (
            <button
              type="button"
              className="text-blue-700 hover:underline"
              onClick={() => setRawOpenFor(rawOpen ? null : node.key)}
              data-testid="otel-span-raw-toggle"
            >
              {rawOpen ? 'hide raw' : `show all raw (${attrCount}) ▸`}
            </button>
          )}
        </Field>
      </dl>
      {rawOpen && attrs !== null && (
        <pre
          className="mt-2 max-h-[320px] overflow-auto rounded bg-muted p-2 font-mono text-[11px]"
          data-testid="otel-span-raw"
        >
          {JSON.stringify(attrs, null, 2)}
        </pre>
      )}
    </aside>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="shrink-0 rounded p-0.5 hover:bg-accent"
      onClick={onClose}
      aria-label="Close details"
    >
      <X className="size-3.5" />
    </button>
  );
}
