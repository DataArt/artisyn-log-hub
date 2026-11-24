/**
 * Integer env-var reader shared by the background drains, the rebuild governor and the session
 * log stream limiter.
 */

/** Reads `name` as a positive integer, else returns `fallback`. */
export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}
