/**
 * Display helpers of the session OTEL waterfall and span details (2026-10-30 otel-tabs-traces):
 * short operation names, the per-row detail text (tool, model, decision), agent labels and the
 * `requestId` → call lookup. Pure, no React.
 */
import type {
  OtelCallRow,
  OtelSpanRow,
} from '../../../../../models/repositories';
import {
  OTEL_SPAN_BLOCKED_ON_USER,
  OTEL_SPAN_INTERACTION,
  OTEL_SPAN_LLM_REQUEST,
  OTEL_SPAN_TOOL,
  OTEL_SPAN_TOOL_EXECUTION,
} from './otel-trace-assembly';

/** The span name without the `claude_code.` prefix and the `tool.` prefix of tool children. */
export function otelSpanOperation(name: string): string {
  switch (name) {
    case OTEL_SPAN_INTERACTION:
      return 'interaction';
    case OTEL_SPAN_LLM_REQUEST:
      return 'llm_request';
    case OTEL_SPAN_TOOL:
      return 'tool';
    case OTEL_SPAN_BLOCKED_ON_USER:
      return 'blocked_on_user';
    case OTEL_SPAN_TOOL_EXECUTION:
      return 'execution';
    default:
      return name.startsWith('claude_code.') ? name.slice(12) : name;
  }
}

/** A string attribute of the span, or null (masked attributes, missing or non-scalar value). */
export function otelSpanAttr(span: OtelSpanRow, key: string): string | null {
  const v = span.attributes?.[key];
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** A numeric attribute of the span, or null. */
export function otelSpanNumberAttr(
  span: OtelSpanRow,
  key: string,
): number | null {
  const v = span.attributes?.[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** `claude-opus-5-5` → `opus-5-5`. */
export function shortModelName(model: string | null): string | null {
  if (model === null) return null;
  return model.startsWith('claude-') ? model.slice(7) : model;
}

/** The first 6 characters of an agent id, as the waterfall's `agent <id>` label shows it. */
export function shortAgentId(agentId: string): string {
  return agentId.length > 6 ? agentId.slice(0, 6) : agentId;
}

/** Calls by `requestId` (the first call wins when a request id repeats). */
export function otelCallsByRequest(
  calls: readonly OtelCallRow[],
): Map<string, OtelCallRow> {
  const out = new Map<string, OtelCallRow>();
  for (const c of calls) {
    if (c.requestId !== null && !out.has(c.requestId)) out.set(c.requestId, c);
  }
  return out;
}

/** The model of an `llm_request` span: its call's model, else the `model` attribute. */
export function otelSpanModel(
  span: OtelSpanRow,
  call: OtelCallRow | undefined,
): string | null {
  return call?.model ?? otelSpanAttr(span, 'model');
}

/**
 * The detail next to the operation name: the model (and a non-main query_source) of an
 * `llm_request`, the tool name of a `tool`, the decision of a `blocked_on_user`, the outcome of
 * an `execution`.
 */
export function otelSpanDetail(
  span: OtelSpanRow,
  call: OtelCallRow | undefined,
): string {
  switch (span.name) {
    case OTEL_SPAN_LLM_REQUEST: {
      const model = shortModelName(otelSpanModel(span, call));
      const qs = span.querySource;
      const showQs =
        qs !== null && qs !== 'repl_main_thread' && !qs.startsWith('agent:');
      return [model, showQs ? qs : null].filter(Boolean).join(' · ');
    }
    case OTEL_SPAN_TOOL:
      return otelSpanAttr(span, 'tool_name') ?? '';
    case OTEL_SPAN_BLOCKED_ON_USER:
      return otelSpanAttr(span, 'decision') ?? '';
    case OTEL_SPAN_TOOL_EXECUTION: {
      const ok = otelSpanAttr(span, 'success');
      return ok === 'true' ? 'ok' : ok === 'false' ? 'failed' : '';
    }
    default:
      return '';
  }
}

/** The span's own duration in ms; null while it has no end. */
export function otelSpanDurationMs(span: OtelSpanRow): number | null {
  if (span.endTime === null) return null;
  const d = Date.parse(span.endTime) - Date.parse(span.startTime);
  return Number.isFinite(d) ? Math.max(0, d) : null;
}
