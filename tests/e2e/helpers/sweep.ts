/**
 * sweep.ts — backstop cleanup of leftover e2e repos and API keys.
 *
 * Part of the e2e shared-helper suite.
 *
 * sweepE2eRepos(): logs in as `admin`, lists all repos via
 * GET /api/v1/admin/repos, and deletes every repo whose repoUrl starts with
 * E2E_REPO_PREFIX via DELETE /api/v1/admin/repos/:id. This is the backstop
 * for killed runs that did not run their own per-spec cleanup().
 *
 * sweepE2eApiKeys(): there is no admin/cross-user API-key listing endpoint
 * (GET /api/v1/api-keys only returns the authenticated user's own keys), so
 * this logs in as each distinct e2e role email in turn and deletes that
 * user's own keys whose name starts with E2E_API_KEY_PREFIX via
 * DELETE /api/v1/api-keys/:id. Backstop for seed.ts's cleanup() (which
 * deletes the one key it created, but not one left behind by a killed run).
 *
 * SAFETY: both delete leftovers regardless of run id, so they MUST only run
 * while the run lock is held (no other run can own live e2e repos/keys
 * concurrently). See run-lock.ts / global-setup.ts (chunk 3).
 *
 * Note: GET /admin/repos also returns orphan team-repo rows with `id: null`
 * (no owned repository row) — those are skipped (nothing to delete by id).
 */
import { request } from '@playwright/test';
import { isNoAuthMode } from './auth-mode';
import { BASE_URL, E2E_API_KEY_PREFIX, E2E_REPO_PREFIX, ROLES } from './credentials';

interface AdminRepoRow {
  id: number | null;
  repoUrl: string;
}

interface ApiKeyRow {
  id: number;
  name: string;
}

/** Log in (or identify, in Mode 1) as `creds` on a fresh, cookie-free context. */
async function loginAs(creds: { email: string; password: string }) {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const noAuth = isNoAuthMode();
  const sessionResp = noAuth
    ? await ctx.post('/api/v1/auth/identify', { data: { email: creds.email } })
    : await ctx.post('/api/v1/auth/login', { data: creds });
  return { ctx, ok: sessionResp.ok() };
}

/**
 * Delete every repo under E2E_REPO_PREFIX. Returns the number of repos deleted.
 */
export async function sweepE2eRepos(): Promise<number> {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  let deleted = 0;
  try {
    // Mode 1 has no /auth/login at all (AuthModeGuard 404s it) — the session
    // comes from /auth/identify instead. See helpers/auth-mode.ts.
    const noAuth = isNoAuthMode();
    const sessionResp = noAuth
      ? await ctx.post('/api/v1/auth/identify', {
          data: { email: ROLES.admin.email },
        })
      : await ctx.post('/api/v1/auth/login', {
          data: { email: ROLES.admin.email, password: ROLES.admin.password },
        });
    if (!sessionResp.ok()) {
      throw new Error(
        `Sweep: admin ${noAuth ? 'identify' : 'login'} failed (${sessionResp.status()}): ${await sessionResp.text()}`,
      );
    }

    const reposResp = await ctx.get('/api/v1/admin/repos');
    if (!reposResp.ok()) {
      throw new Error(
        `Sweep: GET /admin/repos failed (${reposResp.status()}): ${await reposResp.text()}`,
      );
    }
    const repos = (await reposResp.json()) as AdminRepoRow[];

    for (const repo of repos) {
      if (repo.id == null) continue; // orphan team-repo row — nothing to delete by id
      if (typeof repo.repoUrl !== 'string') continue;
      if (!repo.repoUrl.startsWith(E2E_REPO_PREFIX)) continue;

      const delResp = await ctx.delete(`/api/v1/admin/repos/${repo.id}`);
      if (delResp.ok()) deleted++;
    }
  } finally {
    await ctx.dispose();
  }
  return deleted;
}

/**
 * Delete every API key under E2E_API_KEY_PREFIX, across every distinct e2e
 * role email. Returns the number of keys deleted.
 */
export async function sweepE2eApiKeys(): Promise<number> {
  // ROLES has duplicate emails (primary/admin/owner all point at the same
  // account) — dedupe so each distinct user is only logged into once.
  const uniqueCreds = new Map<string, { email: string; password: string }>();
  for (const creds of Object.values(ROLES)) {
    uniqueCreds.set(creds.email, creds);
  }

  let deleted = 0;
  for (const creds of uniqueCreds.values()) {
    const { ctx, ok } = await loginAs(creds);
    try {
      if (!ok) continue; // user may not exist yet on a fresh DB — nothing to sweep

      const keysResp = await ctx.get('/api/v1/api-keys');
      if (!keysResp.ok()) continue;
      const keys = (await keysResp.json()) as ApiKeyRow[];

      for (const key of keys) {
        if (!key.name.startsWith(E2E_API_KEY_PREFIX)) continue;
        const delResp = await ctx.delete(`/api/v1/api-keys/${key.id}`);
        if (delResp.ok()) deleted++;
      }
    } finally {
      await ctx.dispose();
    }
  }
  return deleted;
}
