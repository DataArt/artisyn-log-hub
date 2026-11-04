/**
 * Sub-agent metadata labels (`agentDescription` / `workflowPhase`) sent by the hook
 * from the sub-agent's `.meta.json`. Stored in `varchar(255)` columns on `sessions`
 * and `upload_queue`.
 *
 * The hook keeps a plain-JS copy of this contract in
 * `hook/.claude/telemetry_tool/send-logs-hook.js` — keep the two in sync.
 */
export const AGENT_META_MAX_LENGTH = 255;

/**
 * Sanitises one sub-agent metadata value.
 *
 * - Not a string (including a repeated query param, which arrives as `string[]`) → `null`.
 * - Trimmed; an empty result → `null`.
 * - Otherwise cut to {@link AGENT_META_MAX_LENGTH} code points (never UTF-16 units, so a
 *   surrogate pair is never split and the result always fits `varchar(255)`).
 */
export function sanitizeAgentMeta(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).slice(0, AGENT_META_MAX_LENGTH).join('');
}
