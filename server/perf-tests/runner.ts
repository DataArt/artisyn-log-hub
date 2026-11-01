import { Scenario, ScenarioResult, Stats } from './types';
import { AuthClient } from './auth-client';

function calcStats(durations: number[]): Stats {
  if (durations.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
    p50: round(pct(sorted, 50)),
    p95: round(pct(sorted, 95)),
    p99: round(pct(sorted, 99)),
  };
}

function pct(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

interface RunOptions {
  iterations: number;
  warmupIterations: number;
  requestTimeoutMs: number;
}

/**
 * Runs one scenario call, resolving `{ ok: false }` once `timeoutMs` passes — a stalled request
 * counts as an error at the timeout instead of hanging the whole run.
 */
async function callWithTimeout(
  scenario: Scenario,
  auth: AuthClient,
  timeoutMs: number,
): Promise<{ ok: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  try {
    return await Promise.race([scenario.fn(auth), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runScenario(
  scenario: Scenario,
  auth: AuthClient,
  defaults: RunOptions,
  defaultParallelLimit: number,
): Promise<ScenarioResult> {
  // Per-scenario overrides (e.g. a heavy endpoint measured with fewer, serial calls).
  const config = {
    iterations: scenario.iterations ?? defaults.iterations,
    warmupIterations: scenario.warmupIterations ?? defaults.warmupIterations,
  };
  const parallelLimit = Math.max(1, scenario.parallel ?? defaultParallelLimit);
  const label = scenario.name.padEnd(26);
  process.stdout.write(`  ${label} `);

  // Warmup runs (sequential, as before)
  for (let i = 0; i < config.warmupIterations; i++) {
    try {
      await callWithTimeout(scenario, auth, defaults.requestTimeoutMs);
    } catch {
      // Warmup errors are ignored
    }
  }

  const durations: number[] = [];
  let errors = 0;
  const dotEvery = Math.max(1, Math.floor(config.iterations / 20));

  // Sliding window parallelism: maintain ~parallelLimit concurrent requests
  const inFlight = new Set<Promise<void>>();

  for (let i = 0; i < config.iterations; i++) {
    const promise = (async () => {
      const t0 = performance.now();
      let ok = false;
      try {
        const result = await callWithTimeout(
          scenario,
          auth,
          defaults.requestTimeoutMs,
        );
        ok = result.ok;
      } catch {
        ok = false;
      }
      durations.push(performance.now() - t0);
      if (!ok) errors++;
      if ((i + 1) % dotEvery === 0) process.stdout.write('.');
    })();

    // Remove from inFlight when done
    void promise.then(() => {
      inFlight.delete(promise);
    });

    inFlight.add(promise);

    // Wait for one to finish if we've reached the parallelLimit
    if (inFlight.size >= parallelLimit) {
      await Promise.race(inFlight);
    }
  }

  // Wait for all remaining promises to complete
  if (inFlight.size > 0) {
    await Promise.all(inFlight);
  }

  const stats = calcStats(durations);
  const successRate = round(
    ((config.iterations - errors) / config.iterations) * 100,
  );
  console.log(
    ` ✓  mean ${stats.mean}ms  p95 ${stats.p95}ms  err ${errors}/${config.iterations}`,
  );

  return {
    scenario: scenario.name,
    description: scenario.description,
    iterations: config.iterations,
    errors,
    successRate,
    ...stats,
  };
}

export async function runAllScenarios(
  scenarios: Scenario[],
  auth: AuthClient,
  options: {
    iterations: number;
    warmupIterations: number;
    parallelRunsPerScenario: number;
    requestTimeoutMs: number;
  },
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(
      scenario,
      auth,
      {
        iterations: options.iterations,
        warmupIterations: options.warmupIterations,
        requestTimeoutMs: options.requestTimeoutMs,
      },
      options.parallelRunsPerScenario,
    );
    results.push(result);
  }
  return results;
}
