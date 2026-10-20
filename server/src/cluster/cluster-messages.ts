import type { SupervisorInfo } from '../system-info/system-info.types';

/**
 * The worker <-> primary IPC envelope. Both guards are mandatory rather than
 * defensive polish: `process.on('message')` and `worker.on('message')` hand
 * over `unknown`, and the channel is shared with anything else Node or a
 * future feature puts on it.
 */

export const WORKER_STATS_MESSAGE = 'artisyn:worker-stats';
export const SUPERVISOR_SNAPSHOT_MESSAGE = 'artisyn:supervisor-snapshot';
export const API_KEY_CACHE_INVALIDATE_MESSAGE = 'api-key-cache-invalidate';

export interface WorkerStatsMessage {
  type: typeof WORKER_STATS_MESSAGE;
  instance: number;
  pid: number;
  rssBytes: number;
}

export interface SupervisorSnapshotMessage {
  type: typeof SUPERVISOR_SNAPSHOT_MESSAGE;
  snapshot: SupervisorInfo;
}

/**
 * Worker -> primary -> every worker: drop cached API keys by key id and/or by
 * owning user id.
 */
export interface ApiKeyCacheInvalidateMessage {
  type: typeof API_KEY_CACHE_INVALIDATE_MESSAGE;
  keyId?: number;
  userId?: number;
}

export type ClusterMessage =
  | WorkerStatsMessage
  | SupervisorSnapshotMessage
  | ApiKeyCacheInvalidateMessage;

function isRecord(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

export function isWorkerStatsMessage(msg: unknown): msg is WorkerStatsMessage {
  if (!isRecord(msg)) return false;
  return (
    msg.type === WORKER_STATS_MESSAGE &&
    typeof msg.instance === 'number' &&
    typeof msg.pid === 'number' &&
    typeof msg.rssBytes === 'number'
  );
}

export function isSupervisorSnapshotMessage(
  msg: unknown,
): msg is SupervisorSnapshotMessage {
  if (!isRecord(msg)) return false;
  if (msg.type !== SUPERVISOR_SNAPSHOT_MESSAGE) return false;
  const snapshot: unknown = msg.snapshot;
  if (!isRecord(snapshot)) return false;
  return (
    typeof snapshot.clustered === 'boolean' && Array.isArray(snapshot.processes)
  );
}

export function isApiKeyCacheInvalidateMessage(
  msg: unknown,
): msg is ApiKeyCacheInvalidateMessage {
  if (!isRecord(msg)) return false;
  if (msg.type !== API_KEY_CACHE_INVALIDATE_MESSAGE) return false;
  const keyIdOk = msg.keyId === undefined || typeof msg.keyId === 'number';
  const userIdOk = msg.userId === undefined || typeof msg.userId === 'number';
  if (!keyIdOk || !userIdOk) return false;
  return msg.keyId !== undefined || msg.userId !== undefined;
}
