/**
 * Background-rebuild governor (impl-plan DD-15 of 2026-11-23-session-logs-streaming).
 *
 * Every background drain (rebuilds, backfills, the gzip builder, the upload-queue tick) calls
 * `admit()` before each unit of work. Below `REBUILD_SLOWDOWN_CPU_PERCENT` it resolves at once,
 * so an idle instance rebuilds right after an upload; between the slowdown and the pause
 * threshold it waits up to `REBUILD_MAX_DELAY_MS`; at `REBUILD_PAUSE_CPU_PERCENT` and above it
 * pauses, re-checking after every load sample, until `REBUILD_HARD_CAP_MS` has passed, after
 * which work runs anyway (drain mode) so deferred work always converges. Work is never dropped:
 * a paused caller simply has not run yet. The pacing rules are the pure `decideRebuildPace`
 * (`docs/knowledgebase/algorithms/rebuild-load-governor.md`).
 */
import { Injectable } from '@nestjs/common';
import { readPositiveIntEnv } from '../env-int';
import { CpuLoadSampler } from './cpu-load-sampler';
import { decideRebuildPace } from './rebuild-pace';

/** Load % at which rebuilds start to slow down, when the env var is unset or invalid. */
export const DEFAULT_REBUILD_SLOWDOWN_CPU_PERCENT = 60;
/** Load % at which rebuilds pause, when the env var is unset or invalid. */
export const DEFAULT_REBUILD_PAUSE_CPU_PERCENT = 99;
/** Longest pause before drain mode, when the env var is unset or invalid. */
export const DEFAULT_REBUILD_HARD_CAP_MS = 300_000;
/** Delay just below the pause threshold, when the env var is unset or invalid. */
export const DEFAULT_REBUILD_MAX_DELAY_MS = 10_000;

export interface RebuildGovernorConfig {
  slowdownPct: number;
  pausePct: number;
  hardCapMs: number;
  maxDelayMs: number;
}

function readPercentEnv(name: string, fallback: number): number {
  return Math.min(100, readPositiveIntEnv(name, fallback));
}

/**
 * The governor's thresholds from env. Percent values are clamped to 1–100, and a slowdown
 * threshold above the pause threshold is lowered to it (no slope, straight to pause).
 */
export function resolveRebuildGovernorConfig(): RebuildGovernorConfig {
  const pausePct = readPercentEnv(
    'REBUILD_PAUSE_CPU_PERCENT',
    DEFAULT_REBUILD_PAUSE_CPU_PERCENT,
  );
  const slowdownPct = Math.min(
    pausePct,
    readPercentEnv(
      'REBUILD_SLOWDOWN_CPU_PERCENT',
      DEFAULT_REBUILD_SLOWDOWN_CPU_PERCENT,
    ),
  );
  return {
    slowdownPct,
    pausePct,
    hardCapMs: readPositiveIntEnv(
      'REBUILD_HARD_CAP_MS',
      DEFAULT_REBUILD_HARD_CAP_MS,
    ),
    maxDelayMs: readPositiveIntEnv(
      'REBUILD_MAX_DELAY_MS',
      DEFAULT_REBUILD_MAX_DELAY_MS,
    ),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

@Injectable()
export class RebuildGovernor {
  private readonly config = resolveRebuildGovernorConfig();
  /** Start of the current high-load pause in this worker, shared by every drain. */
  private pausedSinceMs: number | null = null;
  /** `admit()` calls currently waiting or paused. */
  private waiting = 0;

  constructor(private readonly sampler: CpuLoadSampler) {}

  /** Resolves when one unit of background work may run. Never rejects. */
  async admit(): Promise<void> {
    this.waiting += 1;
    try {
      for (;;) {
        const decision = decideRebuildPace({
          loadPct: this.sampler.loadPct(),
          nowMs: Date.now(),
          pausedSinceMs: this.pausedSinceMs,
          ...this.config,
        });
        this.pausedSinceMs = decision.pausedSinceMs;
        if (decision.action === 'run') {
          return;
        }
        if (decision.action === 'wait') {
          await sleep(decision.waitMs);
          return;
        }
        await sleep(this.sampler.sampleMs);
      }
    } finally {
      this.waiting -= 1;
    }
  }

  /**
   * A drain found no waiting work. Ends drain mode (a pause that outlived the hard cap) once no
   * other caller is still waiting, so the next high-load spell starts a fresh pause.
   */
  reportIdle(): void {
    if (
      this.waiting === 0 &&
      this.pausedSinceMs !== null &&
      Date.now() - this.pausedSinceMs >= this.config.hardCapMs
    ) {
      this.pausedSinceMs = null;
    }
  }
}
