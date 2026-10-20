import { apiKeyCache } from '../api-keys/api-key-cache';
import {
  API_KEY_CACHE_INVALIDATE_MESSAGE,
  isApiKeyCacheInvalidateMessage,
} from './cluster-messages';
import type { ApiKeyCacheInvalidateMessage } from './cluster-messages';

/**
 * Worker-side half of the API-key cache invalidation channel. A worker that
 * deletes/expires a key (or deletes a user) invalidates its own cache, then
 * tells the primary, which rebroadcasts to every worker — including the
 * sender, where the second invalidation is a harmless no-op.
 *
 * Both functions are no-ops without an IPC channel (local dev, jest): there
 * is only one process and the local invalidation already covered it.
 */
export function sendApiKeyInvalidation(target: {
  keyId?: number;
  userId?: number;
}): void {
  if (typeof process.send !== 'function') return;
  const message: ApiKeyCacheInvalidateMessage = {
    type: API_KEY_CACHE_INVALIDATE_MESSAGE,
  };
  if (target.keyId !== undefined) message.keyId = target.keyId;
  if (target.userId !== undefined) message.userId = target.userId;
  try {
    process.send(message);
  } catch {
    // The channel closes first during shutdown — nothing left to notify.
  }
}

let listener: ((msg: unknown) => void) | null = null;

/** Idempotent. Applies every rebroadcast invalidation to the local cache. */
export function listenForApiKeyInvalidation(): void {
  if (listener !== null) return;
  if (typeof process.send !== 'function') return;
  listener = (msg: unknown): void => {
    if (!isApiKeyCacheInvalidateMessage(msg)) return;
    if (msg.keyId !== undefined) apiKeyCache.deleteByKeyId(msg.keyId);
    if (msg.userId !== undefined) apiKeyCache.deleteByUserId(msg.userId);
  };
  process.on('message', listener);
}

/** Removes the listener (keeps jest handle-free). */
export function stopListeningForApiKeyInvalidation(): void {
  if (listener === null) return;
  process.off('message', listener);
  listener = null;
}

/**
 * The single invalidation entry point for callers: drops the entries from
 * this process's cache, then asks the primary to do the same everywhere.
 */
export function invalidateApiKeyCache(target: {
  keyId?: number;
  userId?: number;
}): void {
  if (target.keyId !== undefined) apiKeyCache.deleteByKeyId(target.keyId);
  if (target.userId !== undefined) apiKeyCache.deleteByUserId(target.userId);
  sendApiKeyInvalidation(target);
}
