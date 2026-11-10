/**
 * Background-MCP join (CC >= 2.1.212): an `mcp__*` call still running after a few seconds is
 * handed off to a background task. Its `tool_result` is then only an ack
 * ("… It was moved to the background as task <id> …"), and the real end arrives later as a
 * `<task-notification>` (a string-content user line, and/or a `queue-operation` enqueue).
 *
 * Twin: `client/src/viewer/pages/repository/session-log/background-mcp.ts` — keep in sync.
 *
 * Compatibility (impl-plan DD-1): handling is shape-based and never reads the transcript
 * `version`. A call is background only when its name starts with `mcp__`, its result is not
 * `is_error: true`, and the full result text matches {@link BACKGROUND_ACK_RE}; anything else
 * (old CC, in-session MCP calls, Bash `run_in_background` acks) keeps today's handling.
 *
 * Pure: no DB, no Nest.
 */
import {
  parseTaskNotification,
  type QueueOperationEvent,
} from './workflow-extractor';

/**
 * The hand-off ack wording. The id class (not `\S+`) keeps trailing punctuation or backticks
 * out of the captured task id.
 */
export const BACKGROUND_ACK_RE =
  /moved to the background as task ([A-Za-z0-9_-]+)/;

/**
 * The background task id an ack names, or null. Run it over the **full** result text, never a
 * prefix cut: the match offset grows with the server/tool name.
 */
export function matchBackgroundAckTaskId(fullText: string): string | null {
  const m = BACKGROUND_ACK_RE.exec(fullText);
  return m === null ? null : m[1];
}

/**
 * {@link matchBackgroundAckTaskId} over a raw `tool_result.content` (string, or an array of
 * blocks). Each `text` block is matched on its own: the ack is one sentence in one block, so
 * this equals matching the joined text, without allocating a joined copy of a large result.
 */
export function matchBackgroundAckInContent(content: unknown): string | null {
  if (typeof content === 'string') return matchBackgroundAckTaskId(content);
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    if (b['type'] !== 'text' || typeof b['text'] !== 'string') continue;
    const id = matchBackgroundAckTaskId(b['text']);
    if (id !== null) return id;
  }
  return null;
}

/** Name/error half of the background test, checked in the call↔result join. */
export function isBackgroundCandidate(
  toolName: string,
  isError: boolean | null,
): boolean {
  return toolName.startsWith('mcp__') && isError !== true;
}

/**
 * The output shown for a background call whose log holds no notification, instead of the ack:
 * the ack only says the call was handed off, and its result never reached this log.
 */
export function backgroundPendingText(taskId: string): string {
  return `⧗ Moved to the background as task ${taskId}. No result in this log: the task was still running at the last upload, or the session ended before Claude Code wrote the result.`;
}

/** A background task's completion notification. */
export interface BackgroundTaskNotification {
  taskId: string;
  /** `<status>` (`completed`, `failed`, `killed`, …); `''` when absent. */
  status: string;
  /** `<result>` trimmed (a failure is prefixed `Task failed: `); null when absent. */
  result: string | null;
  /** Epoch ms of the notification: the user line, else the queue enqueue. */
  ts: number | null;
}

const TASK_NOTIFICATION_OPEN = '<task-notification>';

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function toNotification(
  xml: string,
  ts: number | null,
): BackgroundTaskNotification | null {
  const parsed = parseTaskNotification(xml);
  if (parsed === null || parsed.taskId === null || parsed.taskId === '') {
    return null;
  }
  return {
    taskId: parsed.taskId,
    status: parsed.status,
    result: parsed.result,
    ts,
  };
}

/**
 * Every `<task-notification>` of a transcript, keyed by task id. Sources:
 * - a `type:"user"` line whose `message.content` is a string starting (after `trimStart`)
 *   with `<task-notification>`;
 * - a `type:"queue-operation"` line with `operation:"enqueue"` and that XML as `content`.
 *
 * The user line wins over the enqueue (its timestamp is the one the model saw); the enqueue is
 * the required fallback — a plain `-p` run that ends its turn writes only an enqueue (with
 * `<status>failed</status>`). Within one source the first notification per task id wins.
 */
export function collectBackgroundTaskNotifications(
  lines: readonly unknown[],
): Map<string, BackgroundTaskNotification> {
  const fromUser = new Map<string, BackgroundTaskNotification>();
  const fromEnqueue = new Map<string, BackgroundTaskNotification>();
  for (const line of lines) {
    if (line === null || typeof line !== 'object') continue;
    const rec = line as Record<string, unknown>;
    const type = rec['type'];
    if (type === 'user') {
      const message = rec['message'];
      if (message === null || typeof message !== 'object') continue;
      const content = (message as Record<string, unknown>)['content'];
      if (typeof content !== 'string') continue;
      const trimmed = content.trimStart();
      if (!trimmed.startsWith(TASK_NOTIFICATION_OPEN)) continue;
      const n = toNotification(trimmed, parseTs(rec['timestamp']));
      if (n !== null && !fromUser.has(n.taskId)) fromUser.set(n.taskId, n);
    } else if (type === 'queue-operation') {
      const qe = rec as Partial<QueueOperationEvent>;
      if (qe.operation !== 'enqueue' || typeof qe.content !== 'string') {
        continue;
      }
      if (!qe.content.trimStart().startsWith(TASK_NOTIFICATION_OPEN)) continue;
      const n = toNotification(qe.content, parseTs(rec['timestamp']));
      if (n !== null && !fromEnqueue.has(n.taskId))
        fromEnqueue.set(n.taskId, n);
    }
  }
  for (const [taskId, n] of fromEnqueue) {
    if (!fromUser.has(taskId)) fromUser.set(taskId, n);
  }
  return fromUser;
}
