/**
 * Single definition of "running in production" (open-source readiness). The Docker `runtime` stage and the release bundle's `.env` set
 * `NODE_ENV=production`; dev and e2e servers never do.
 *
 * Read at call time (not cached) so specs can flip `process.env.NODE_ENV`.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
