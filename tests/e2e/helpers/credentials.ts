/**
 * credentials.ts — shared e2e role credentials, repo-URL prefix, and paths.
 *
 * E2E ONLY: these are throwaway identities for the local Playwright suite against a dev server.
 * They are not real accounts and must never be used to seed or log in to a deployed server.
 *
 * Part of the e2e shared-helper suite. Consumed by auth.ts / seed.ts / sweep.ts
 * and the global setup + spec refactors.
 *
 * Role model (5 roles):
 *   - primary / admin / owner  → all point at muaddib@arrakis.test (first signup ⇒ admin).
 *     Tests reference roles by *intent*; each still gets its own storageState file.
 *   - regular  → a distinct non-admin user.
 *   - nonowner → a distinct user used for cross-user 403 checks.
 *
 * The shared password `12345678` assumes the dev server runs with `PASSWORD_POLICY=any` in the
 * password modes.
 */
import * as path from 'path';

export interface Creds {
  email: string;
  password: string;
}

export const ROLES = {
  primary: { email: 'muaddib@arrakis.test', password: '12345678' },
  admin: { email: 'muaddib@arrakis.test', password: '12345678' },
  owner: { email: 'muaddib@arrakis.test', password: '12345678' },
  regular: { email: 'regular@arrakis.test', password: '12345678' },
  nonowner: { email: 'nonowner@arrakis.test', password: '12345678' },
} as const satisfies Record<string, Creds>;

export type Role = keyof typeof ROLES;

/** Shared prefix for every repo URL an e2e run seeds. The backstop sweep deletes
 *  any repo whose URL starts with this — so nothing else may use it. */
export const E2E_REPO_PREFIX = 'https://git.example.com/e2e/';

/** Shared prefix for every API key name seed.ts mints (see keyName in seed.ts).
 *  The backstop sweep deletes any key whose name starts with this — so nothing
 *  else may use it. */
export const E2E_API_KEY_PREFIX = 'e2e-key-';

/** The client dev server (Vite) proxies /api → backend. All e2e traffic goes here. */
export const BASE_URL = 'http://localhost:5173';

/** Absolute path to the storageState file for a role: tests/e2e/.auth/<role>.json */
export function storageStatePath(role: Role): string {
  return path.join(__dirname, '..', '.auth', `${role}.json`);
}
