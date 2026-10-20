/**
 * Computes the expected cluster worker count from a CPU count.
 *
 * Formula floor: at least 3 instances, at most floor(cpus / 2), capped at 15.
 * This keeps the container from spawning an instance per core (which would
 * multiply DB connections / memory) while still using some parallelism on
 * multi-core hosts.
 */
export function computeInstanceCount(cpus: number): number {
  return Math.max(1, Math.max(3, Math.min(Math.floor(cpus / 2), 15)));
}

/**
 * Per-worker `DB_POOL_MAX` ceiling for a given worker count — the cluster
 * primary passes this into every `cluster.fork()`. The 20 mirrors the
 * `Number(process.env.DB_POOL_MAX) || 20` fallback in
 * `database.module.ts` / `system-info.service.ts`, and the 5 is the floor
 * below which a single worker cannot serve concurrent requests comfortably.
 */
export function computeWorkerPoolMax(instances: number): number {
  return Math.max(5, Math.floor(20 / instances));
}
