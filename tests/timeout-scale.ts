// Test timeout multiplier for slow environments. A Claude sandbox (docker-dev/) runs its worktree
// over Docker Desktop's file-sharing bridge, where several sandboxes at once make UI waits
// noticeably slower; the launcher sets LOG_HUB_TEST_TIMEOUT_SCALE=5 there. Unset (the host) means
// 1, so the configured timeouts are unchanged.

/** The multiplier from LOG_HUB_TEST_TIMEOUT_SCALE (a number >= 1; anything else means 1). */
export function timeoutScale(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.LOG_HUB_TEST_TIMEOUT_SCALE ?? '').trim());
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** `ms` multiplied by timeoutScale(); 0 (no timeout) stays 0. */
export function scaled(ms: number, env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(ms * timeoutScale(env));
}
