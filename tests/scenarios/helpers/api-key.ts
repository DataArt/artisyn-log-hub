/**
 * api-key.ts — mints an API key through the public API (`POST /api/v1/api-keys`), the way a user
 * does from the API keys page. The plaintext `key` is returned only by this call.
 */
import { randomBytes } from 'crypto';
import type { APIRequestContext } from '@playwright/test';

export interface CreatedApiKey {
  id: number;
  name: string;
  slug: string;
  created_at: string;
  expires_at: string | null;
  /** Plaintext key, shown once; the hook sends it in the `X-API-Key` header. */
  key: string;
}

export interface CreateApiKeyOptions {
  /** Defaults to `scn-key-<6 hex>`; names are unique per user. */
  name?: string;
  /** Full ISO datetime with timezone, e.g. `2030-01-01T00:00:00Z`. */
  expiresAt?: string;
}

/** Creates a key for the user whose session `api` carries; throws on any non-201. */
export async function createApiKey(
  api: APIRequestContext,
  { name = `scn-key-${randomBytes(3).toString('hex')}`, expiresAt }: CreateApiKeyOptions = {},
): Promise<CreatedApiKey> {
  const data: Record<string, string> = { name };
  if (expiresAt !== undefined) data.expires_at = expiresAt;
  const res = await api.post('/api/v1/api-keys', { data });
  if (res.status() !== 201) {
    throw new Error(`Creating API key "${name}" failed (${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as CreatedApiKey;
}

/** Headers that authenticate a hook-style request with `key` (ApiKeyAuthGuard reads `x-api-key`). */
export function apiKeyHeaders(key: string): Record<string, string> {
  return { 'X-API-Key': key };
}
