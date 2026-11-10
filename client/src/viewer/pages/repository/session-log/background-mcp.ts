/**
 * Background-MCP join (CC >= 2.1.212): an `mcp__*` call still running after a few seconds is
 * handed off to a background task. Its `tool_result` is then only an ack
 * ("… It was moved to the background as task <id> …"), and the real end arrives later as a
 * `<task-notification>` (a string-content user line, and/or a `queue-operation` enqueue).
 *
 * Twin: `server/src/logs/background-mcp.ts` — keep in sync. The client package is isolated from
 * `server/`, so the rule is mirrored here with its own tag parser.
 *
 * Compatibility: handling is shape-based and never reads the transcript `version`. A call is
 * background only when its name starts with `mcp__`, its result is not `is_error: true`, and the
 * full result text matches {@link BACKGROUND_ACK_RE}; anything else (old CC, in-session MCP
 * calls, Bash `run_in_background` acks) keeps today's handling.
 */

import type { TelemetryEvent, UserEvent } from './types';

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

/** A transcript `queue-operation` line; not part of the `TelemetryEvent` union on purpose. */
export interface QueueOperationLine {
  type: 'queue-operation';
  operation?: string;
  content?: unknown;
  timestamp?: string;
}

export function isQueueOperationLine(e: unknown): e is QueueOperationLine {
  return (
    e !== null &&
    typeof e === 'object' &&
    (e as { type?: unknown }).type === 'queue-operation'
  );
}

function isUserLine(e: unknown): e is UserEvent {
  return (
    e !== null &&
    typeof e === 'object' &&
    (e as { type?: unknown }).type === 'user'
  );
}

const TASK_NOTIFICATION_OPEN = '<task-notification>';

function extractTagContent(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const match = re.exec(xml);
  return match ? match[1] : null;
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function toNotification(
  xml: string,
  ts: number | null,
): BackgroundTaskNotification | null {
  const taskId = extractTagContent(xml, 'task-id')?.trim() ?? null;
  if (taskId === null || taskId === '') return null;
  return {
    taskId,
    status: extractTagContent(xml, 'status')?.trim() ?? '',
    result: extractTagContent(xml, 'result')?.trim() ?? null,
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
 *
 * Takes `TelemetryEvent[]` (Logs) as well as the raw line records of the Statistics walker, so
 * it narrows each line itself.
 */
export function collectBackgroundTaskNotifications(
  events: readonly TelemetryEvent[] | readonly Record<string, unknown>[],
): Map<string, BackgroundTaskNotification> {
  const fromUser = new Map<string, BackgroundTaskNotification>();
  const fromEnqueue = new Map<string, BackgroundTaskNotification>();
  const lines: readonly unknown[] = events;
  for (const e of lines) {
    if (isUserLine(e)) {
      const content = e.message?.content;
      if (typeof content !== 'string') continue;
      const trimmed = content.trimStart();
      if (!trimmed.startsWith(TASK_NOTIFICATION_OPEN)) continue;
      const n = toNotification(trimmed, parseTs(e.timestamp));
      if (n !== null && !fromUser.has(n.taskId)) fromUser.set(n.taskId, n);
    } else if (isQueueOperationLine(e)) {
      if (e.operation !== 'enqueue' || typeof e.content !== 'string') continue;
      if (!e.content.trimStart().startsWith(TASK_NOTIFICATION_OPEN)) continue;
      const n = toNotification(e.content, parseTs(e.timestamp));
      if (n !== null && !fromEnqueue.has(n.taskId))
        fromEnqueue.set(n.taskId, n);
    }
  }
  for (const [taskId, n] of fromEnqueue) {
    if (!fromUser.has(taskId)) fromUser.set(taskId, n);
  }
  return fromUser;
}
