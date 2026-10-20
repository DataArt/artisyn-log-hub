/**
 * Client feature-flag helpers, for flags resolved from Vite's compile-time env
 * (`import.meta.env`).
 *
 * A flag is OFF unless its `VITE_*` var is set to an explicitly truthy value, so
 * any build that does not set it — dev, prod, CI, a fresh clone — hides the
 * feature. Turn one on for your own machine in the gitignored
 * `client/.env.local`; Vite inlines the value at build time, so this is a
 * build-time switch, not a runtime one. No flag is currently defined.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Parses a `VITE_*` boolean flag. Only `1`/`true`/`yes`/`on` (case- and
 * whitespace-insensitive) enable it; unset, empty or anything else is `false`.
 */
export function parseBooleanFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}
