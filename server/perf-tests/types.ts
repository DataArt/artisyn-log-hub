export interface IdCollector {
  sessionUuids: Set<string>;  // session_id UUID strings from log POSTs
  repoIds: Set<number>;       // integer DB ids of newly created repos
  userWasCreated: boolean;    // true only when signup was called during this run
}

export interface SeedData {
  repoId?: string;           // string-serialised integer, used in HTTP URL paths
  sessionId?: string;        // session UUID string
  seedRepoNumericId?: number; // integer DB id of the newly-created seed repo (for cleanup)
}

export interface PerftestConfig {
  parallelRunsPerScenario: number;
  baseUrl: string;
  iterations: number;
  warmupIterations: number;
  outputDir: string;
  testUser: {
    email: string;
    password: string;
  };
}

export interface Scenario {
  name: string;
  description: string;
  fn: (auth: unknown) => Promise<{ ok: boolean }>;
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
