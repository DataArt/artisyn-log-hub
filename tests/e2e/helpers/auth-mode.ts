/**
 * auth-mode.ts — the AUTH_MODE the server under test is actually running in.
 *
 * The suite drives the always-on dev server rather than booting its own, and
 * that box now runs Mode 1 (`none`) permanently. In Mode 1 there is no signup
 * and no login — `AuthModeGuard` 404s those routes outright — and a session is
 * instead opened by `POST /api/v1/auth/identify { email }`, which is
 * localhost-only and auto-provisions the account on first sight (first user
 * ever created still becomes admin, exactly as signup does).
 *
 * Rather than hardcode a mode, the config-level `globalSetup` asks the server
 * once (`GET /api/v1/auth/config`) and publishes the answer on `process.env`.
 * Playwright forks its worker processes after `globalSetup` returns, so they
 * inherit it — which is what lets specs and helpers branch synchronously
 * instead of each re-querying the server.
 */
import { request } from '@playwright/test';
import { BASE_URL } from './credentials';

/** Env var carrying the detected mode from globalSetup into every worker. */
export const AUTH_MODE_ENV = 'E2E_AUTH_MODE';

/**
 * Asks the running server which mode it is in. Call from `globalSetup` only —
 * everywhere else use the synchronous {@link authMode}.
 */
export async function detectAuthMode(): Promise<string> {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  try {
    const resp = await ctx.get('/api/v1/auth/config');
    if (!resp.ok()) {
      throw new Error(
        `Could not read /api/v1/auth/config (${resp.status()}): ${await resp.text()}`,
      );
    }
    const { mode } = (await resp.json()) as { mode?: string };
    // Server-side, an unset/empty AUTH_MODE means Mode 2 (legacy default).
    return mode && mode.trim() !== '' ? mode : 'password';
  } finally {
    await ctx.dispose();
  }
}

/** The mode detected in globalSetup. Safe in workers, specs and helpers. */
export function authMode(): string {
  return process.env[AUTH_MODE_ENV] ?? 'password';
}

/**
 * Mode 1. Sessions come from `/auth/identify`, and every password /
 * email-confirmation feature is absent from the server entirely — specs
 * covering those must skip rather than fail.
 */
export function isNoAuthMode(): boolean {
  return authMode() === 'none';
}
