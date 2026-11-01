/**
 * Session-list flags derived from a session's own `claude` transcript at ingest time and
 * stored on `session_stats` (`main_model`, `has_workflow`, `has_main_assistant`,
 * `list_flags_version` — migration 0080; `claude_line_count` — migration 0081), so
 * `GET /api/v1/repositories/:repoId/sessions` and `…/analytics/timeline` never scan
 * `logs.body` jsonb at request time.
 *
 * The rules mirror, line for line, the SQL the session list used to run (and the startup
 * backfill still runs over old rows), so a value computed here equals the value the SQL
 * derives from the same body:
 *
 * - **Main assistant lines:** `type === 'assistant'` and `isSidechain` neither boolean `true`
 *   nor string `'true'` (Postgres `evt->>'isSidechain' IS DISTINCT FROM 'true'`).
 * - **Dedup:** key = `message.id` when not null, else `uuid` (both null → one shared null
 *   key); per key the LAST line wins (`DISTINCT ON … ORDER BY ord DESC`).
 * - **`mainModel`:** the first non-null `message.model` over the kept lines in log order
 *   (`ARRAY_AGG(… ORDER BY ord) FILTER (WHERE model IS NOT NULL))[1]`).
 * - **`hasMainAssistant`:** at least one kept line exists.
 * - **`hasWorkflow`:** the predicate of `extractWorkflows` step 1 (workflow-extractor.ts) —
 *   any assistant event, sidechain included, whose `message.content` array holds a
 *   `tool_use` block named `Workflow` with a non-empty string `id`.
 * - **`lineCount`:** the number of transcript lines — the stored body is exactly these lines,
 *   so it equals Postgres `jsonb_array_length(logs.body)` (the timeline's log line count).
 *
 * Scalar values are compared as their JSON text, like Postgres `->>` does (a numeric
 * `message.id` 5 and a string `"5"` are the same key).
 *
 * Bump {@link SESSION_LIST_FLAGS_VERSION} whenever these rules change, so the startup
 * backfill can tell stale rows apart.
 */

/** Version of the rules above, stored in `session_stats.list_flags_version`. */
export const SESSION_LIST_FLAGS_VERSION = 2;

export interface SessionListFlags {
  /** First non-null model of the deduped main (non-sidechain) assistant lines; null if none. */
  mainModel: string | null;
  /** True when any assistant event carries a valid `Workflow` tool_use block. */
  hasWorkflow: boolean;
  /** True when the transcript has at least one main (non-sidechain) assistant line. */
  hasMainAssistant: boolean;
  /** Number of transcript lines (`jsonb_array_length` of the stored body). Added in version 2. */
  lineCount: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Text of a JSON value the way Postgres `->>` returns it: SQL NULL for a missing key or a
 * JSON null, the raw string for a string, the JSON text for anything else.
 */
function jsonText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function isSidechain(rec: Record<string, unknown>): boolean {
  return jsonText(rec['isSidechain']) === 'true';
}

function hasWorkflowBlock(rec: Record<string, unknown>): boolean {
  const message = asRecord(rec['message']);
  if (!message) return false;
  const content = message['content'];
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b['type'] !== 'tool_use' || b['name'] !== 'Workflow') continue;
    const id = b['id'];
    if (typeof id === 'string' && id !== '') return true;
  }
  return false;
}

export function computeSessionListFlags(lines: unknown[]): SessionListFlags {
  // Dedup key → index of the LAST main assistant line carrying it.
  const lastIndexByKey = new Map<string | null, number>();
  let hasWorkflow = false;

  lines.forEach((line, index) => {
    const rec = asRecord(line);
    if (!rec || jsonText(rec['type']) !== 'assistant') return;
    if (!hasWorkflow && hasWorkflowBlock(rec)) {
      hasWorkflow = true;
    }
    if (isSidechain(rec)) return;
    const message = asRecord(rec['message']);
    const key = jsonText(message?.['id']) ?? jsonText(rec['uuid']);
    lastIndexByKey.set(key, index);
  });

  const keptIndexes = [...lastIndexByKey.values()].sort((a, b) => a - b);
  let mainModel: string | null = null;
  for (const index of keptIndexes) {
    const message = asRecord(asRecord(lines[index])?.['message']);
    const model = jsonText(message?.['model']);
    if (model !== null) {
      mainModel = model;
      break;
    }
  }

  return {
    mainModel,
    hasWorkflow,
    hasMainAssistant: keptIndexes.length > 0,
    lineCount: lines.length,
  };
}
