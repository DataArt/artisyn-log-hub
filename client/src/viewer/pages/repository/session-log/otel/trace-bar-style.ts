/**
 * Bar colours of the session OTEL waterfall and minimap (2026-10-30 otel-tabs-traces): one
 * Tailwind background class per span kind; hidden `llm_request` spans are red.
 */
import type { OtelTraceNode } from './otel-trace-assembly';
import {
  OTEL_SPAN_BLOCKED_ON_USER,
  OTEL_SPAN_INTERACTION,
  OTEL_SPAN_LLM_REQUEST,
  OTEL_SPAN_TOOL,
  OTEL_SPAN_TOOL_EXECUTION,
} from './otel-trace-assembly';

export function otelSpanBarClass(node: OtelTraceNode): string {
  const span = node.span;
  if (span === null) return 'bg-slate-300';
  switch (span.name) {
    case OTEL_SPAN_INTERACTION:
      return 'bg-slate-400';
    case OTEL_SPAN_LLM_REQUEST:
      return span.hidden === true ? 'bg-red-500' : 'bg-blue-500';
    case OTEL_SPAN_TOOL:
      return 'bg-emerald-400';
    case OTEL_SPAN_TOOL_EXECUTION:
      return 'bg-emerald-600';
    case OTEL_SPAN_BLOCKED_ON_USER:
      return 'bg-amber-400';
    default:
      return 'bg-violet-400';
  }
}
