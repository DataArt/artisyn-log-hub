// Span names Claude Code's enhanced-telemetry tracer emits (DD-10). An unknown name is still
// stored as is and never fails ingest — these constants only name the spans the server and the
// UI give a meaning to.

/** One user turn: the root of an interaction trace. */
export const OTEL_SPAN_INTERACTION = 'claude_code.interaction';

/** One model API call; carries `request_id`, `query_source_safe`, `llm_request.context`. */
export const OTEL_SPAN_LLM_REQUEST = 'claude_code.llm_request';

/** One tool use, parent of the permission wait and the execution. */
export const OTEL_SPAN_TOOL = 'claude_code.tool';

/** Time a tool use waited for the user's permission decision. */
export const OTEL_SPAN_TOOL_BLOCKED_ON_USER =
  'claude_code.tool.blocked_on_user';

/** The tool's own execution time. */
export const OTEL_SPAN_TOOL_EXECUTION = 'claude_code.tool.execution';

/** Every span name the feature knows about. */
export const OTEL_KNOWN_SPAN_NAMES: readonly string[] = [
  OTEL_SPAN_INTERACTION,
  OTEL_SPAN_LLM_REQUEST,
  OTEL_SPAN_TOOL,
  OTEL_SPAN_TOOL_BLOCKED_ON_USER,
  OTEL_SPAN_TOOL_EXECUTION,
];
