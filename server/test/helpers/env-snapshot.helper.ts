/**
 * A copy of `process.env` taken when this module is first loaded.
 *
 * `in-process-app.helper.ts` imports this BEFORE `src/app.module.ts`, whose
 * module-level dotenv calls (including the `override: true` load of
 * server/.env.local) would otherwise replace values global-setup.ts pinned for
 * the run — e.g. put the dev box's AUTH_MODE=none back — for the rest of the
 * spec file. The helper restores this snapshot right after that import.
 */
export const envBeforeAppModule: Readonly<NodeJS.ProcessEnv> = {
  ...process.env,
};

/** Puts `process.env` back to exactly `snapshot`: removes added vars, resets changed ones. */
export function restoreEnv(snapshot: Readonly<NodeJS.ProcessEnv>): void {
  for (const name of Object.keys(process.env)) {
    if (!(name in snapshot)) delete process.env[name];
  }
  Object.assign(process.env, snapshot);
}
