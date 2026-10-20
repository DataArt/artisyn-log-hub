import { createHash } from 'node:crypto';

/** What a cache hit needs to authorize a request without re-running argon2. */
export interface ApiKeyCacheEntry {
  keyId: number;
  userId: number;
  expiresAt: Date | null;
}

export const API_KEY_CACHE_MAX_ENTRIES = 256;

/**
 * Per-process LRU of validated API keys, keyed by the hex SHA-256 of the raw
 * key (the raw key itself is never stored). A `Map` keeps insertion order, so
 * re-inserting on `get` makes the first key the least recently used one.
 *
 * Module-scoped singleton outside DI (the `workerStatsReporter` precedent):
 * `ApiKeysService`, `AccountDeletionService` and the cluster IPC listener all
 * share it without extra module wiring.
 */
export class ApiKeyCache {
  private readonly entries = new Map<string, ApiKeyCacheEntry>();

  constructor(private readonly maxEntries = API_KEY_CACHE_MAX_ENTRIES) {}

  static hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  get(rawKey: string): ApiKeyCacheEntry | undefined {
    const hash = ApiKeyCache.hashKey(rawKey);
    const entry = this.entries.get(hash);
    if (entry === undefined) return undefined;
    this.entries.delete(hash);
    this.entries.set(hash, entry);
    return entry;
  }

  set(rawKey: string, entry: ApiKeyCacheEntry): void {
    const hash = ApiKeyCache.hashKey(rawKey);
    this.entries.delete(hash);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(hash, entry);
  }

  deleteByKeyId(keyId: number): void {
    for (const [hash, entry] of this.entries) {
      if (entry.keyId === keyId) this.entries.delete(hash);
    }
  }

  deleteByUserId(userId: number): void {
    for (const [hash, entry] of this.entries) {
      if (entry.userId === userId) this.entries.delete(hash);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** The stored map keys (SHA-256 hex digests) — for tests. */
  keys(): string[] {
    return [...this.entries.keys()];
  }
}

export const apiKeyCache = new ApiKeyCache();
