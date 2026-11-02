/**
 * Per-user browser storage (`localStorage`), keyed `artisyn:<userId>:<name>`.
 *
 * Several people can share one browser, so navigation memory (the remembered session lens,
 * recent visits, expanded map nodes) is kept per user id. Every
 * access is wrapped in try/catch: storage can be missing, full or blocked (private windows,
 * cleared site data), and a value that no longer parses reads as `undefined`. Without a user id
 * nothing is read or written.
 */

export const USER_STORAGE_PREFIX = 'artisyn';

/** The names stored per user. */
export type UserStorageName = 'session-lens' | 'recent-visits' | 'map-expanded';

type UserId = number | string | null | undefined;

/** The storage key of `name` for `userId`, or `null` without a user. */
export function userStorageKey(
  userId: UserId,
  name: UserStorageName,
): string | null {
  if (userId === null || userId === undefined || userId === '') return null;
  return `${USER_STORAGE_PREFIX}:${String(userId)}:${name}`;
}

/**
 * Reads and parses a stored value. `parse` receives the JSON-decoded value and returns the typed
 * value, or `undefined` when it does not match. Any failure (no user, no storage, bad JSON, a
 * throwing `parse`) returns `undefined`.
 */
export function readUserItem<T>(
  userId: UserId,
  name: UserStorageName,
  parse: (raw: unknown) => T | undefined,
): T | undefined {
  const key = userStorageKey(userId, name);
  if (key === null) return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    return parse(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/** Stores `value` as JSON. Silently does nothing when there is no user or storage fails. */
export function writeUserItem(
  userId: UserId,
  name: UserStorageName,
  value: unknown,
): void {
  const key = userStorageKey(userId, name);
  if (key === null) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: navigation memory is a convenience, never required.
  }
}

/** Removes a stored value. Silently does nothing when there is no user or storage fails. */
export function removeUserItem(userId: UserId, name: UserStorageName): void {
  const key = userStorageKey(userId, name);
  if (key === null) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing to remove.
  }
}
