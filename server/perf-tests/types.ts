export interface IdCollector {
  sessionUuids: Set<string>; // session_id UUID strings from log POSTs
  repoIds: Set<number>; // integer DB ids of newly created repos
  userWasCreated: boolean; // true only when signup was called during this run
}

export interface SeedData {
  repoId?: string; // string-serialised integer, used in HTTP URL paths
  sessionId?: string; // session UUID string
  seedRepoNumericId?: number; // integer DB id of the newly-created seed repo (for cleanup)
  heavyRepoId?: string; // string-serialised integer id of the heavy-transcript repo (the *-heavy scenarios)
  heavySessionId?: string; // UUID of one heavy session in that repo (with a Workflow call and a sub-agent)
}

export interface PerftestConfig {
  parallelRunsPerScenario: number;
  baseUrl: string;
  iterations: number;
  warmupIterations: number;
  outputDir: string;
  /** Per-request timeout; a timed-out request is counted as an error, never left hanging. */
  requestTimeoutMs: number;
  /** Read-only target mode: no signup, no API key, no seeding, no writing scenarios, no DB cleanup. */
  readOnly: boolean;
  /** Existing repository id to measure (read-only mode), instead of a seeded one. */
  repoId?: string;
  testUser: {
    email: string;
    password: string;
  };
}

export interface Scenario {
  name: string;
  description: string;
  fn: (auth: unknown) => Promise<{ ok: boolean }>;
  /** Per-scenario override of the timed iteration count (default: config.iterations). */
  iterations?: number;
  /** Per-scenario override of the warm-up count (default: config.warmupIterations). */
  warmupIterations?: number;
  /** Per-scenario override of the concurrency (default: config.parallelRunsPerScenario). */
  parallel?: number;
  /** True when the scenario sends a mutating request (excluded in read-only mode). */
  writes?: boolean;
}

export interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface TestResult {
  duration: number;
  ok: boolean;
}

export interface ScenarioResult extends Stats {
  scenario: string;
  description: string;
  iterations: number;
  errors: number;
  successRate: number;
}
