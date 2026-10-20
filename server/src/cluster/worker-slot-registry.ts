import {
  WORKER_CRASH_BUDGET,
  WORKER_MIN_UPTIME_MS,
  WORKER_RESTART_BACKOFF_MAX_MS,
  WORKER_RESTART_BACKOFF_START_MS,
} from './cluster.constants';
import type {
  SupervisorInfo,
  WorkerProcessSummary,
} from '../system-info/system-info.types';

export type SlotStatus = 'starting' | 'online' | 'restarting' | 'stopped';

export interface SlotState {
  /** 0-based slot index; also the worker's `NODE_APP_INSTANCE`. */
  instance: number;
  /** Last known pid for the slot; -1 until first forked. */
  pid: number;
  status: SlotStatus;
  restarts: number;
  /** ISO string, null until the slot has been re-forked at least once. */
  lastRestartAt: string | null;
  /** Last self-reported RSS, null until the slot has reported. */
  rssBytes: number | null;
  consecutiveFastCrashes: number;
  /** `now()` of the most recent fork; null before the first one. */
  forkedAt: number | null;
}

export type ExitDecision =
  | { action: 'ignore' }
  | { action: 'refork'; delayMs: number }
  | { action: 'giveUp' };

/**
 * The cluster primary's slot table and restart policy, deliberately free of
 * any `node:cluster` reference and taking an injected clock, so the whole
 * policy is unit-testable without forking a process (`cluster-primary.ts` is
 * then thin glue with no logic of its own).
 *
 * Slot reuse is the point of the table: a replacement worker is forked into
 * the dead worker's index, so `NODE_APP_INSTANCE` is stable across a restart
 * and no new `app-<day>-i<N>.log` series starts. `worker.id` is never used as
 * an instance number.
 */
export class WorkerSlotRegistry {
  private readonly slots: SlotState[];
  private shuttingDown = false;

  constructor(
    instances: number,
    private readonly now: () => number = Date.now,
  ) {
    this.slots = Array.from({ length: instances }, (_unused, instance) => ({
      instance,
      pid: -1,
      status: 'starting',
      restarts: 0,
      lastRestartAt: null,
      rssBytes: null,
      consecutiveFastCrashes: 0,
      forkedAt: null,
    }));
  }

  /**
   * A non-null `forkedAt` is the initial-vs-re-fork discriminator: when it is
   * already set this fork is a restart, so `restarts` increments and
   * `lastRestartAt` is stamped.
   */
  onForked(instance: number, pid: number): void {
    const slot = this.slots[instance];
    if (!slot) return;
    if (slot.forkedAt !== null) {
      slot.restarts += 1;
      slot.lastRestartAt = new Date(this.now()).toISOString();
    }
    slot.pid = pid;
    slot.status = 'starting';
    slot.forkedAt = this.now();
  }

  onOnline(instance: number): void {
    const slot = this.slots[instance];
    if (!slot) return;
    slot.status = 'online';
  }

  /**
   * The restart decision for a worker exit. The exit code and signal are
   * accepted so callers can pass the raw `cluster.on('exit')` arguments
   * straight through, but the policy deliberately does not branch on them
   * (see below) — they are only used by the primary's fatal log line.
   */
  onExit(
    instance: number,
    _code: number | null,
    _signal: string | null,
  ): ExitDecision {
    const slot = this.slots[instance];
    if (!slot) return { action: 'ignore' };
    // No counter is touched during shutdown — every exit there is expected —
    // but the slot must stop counting as live. hasLiveWorkers() is how the
    // primary learns the last worker is gone; leaving the status at 'online'
    // would make it sit out the entire grace period and then SIGKILL
    // processes that had already exited.
    if (this.shuttingDown) {
      slot.status = 'stopped';
      return { action: 'ignore' };
    }

    const uptimeMs = slot.forkedAt === null ? 0 : this.now() - slot.forkedAt;

    // An exit with code 0 outside shutdown takes exactly these branches too:
    // the app never exits cleanly on its own.
    if (uptimeMs >= WORKER_MIN_UPTIME_MS) {
      slot.consecutiveFastCrashes = 0;
      slot.status = 'restarting';
      return { action: 'refork', delayMs: 0 };
    }

    slot.consecutiveFastCrashes += 1;
    if (slot.consecutiveFastCrashes >= WORKER_CRASH_BUDGET) {
      slot.status = 'stopped';
      return { action: 'giveUp' };
    }

    slot.status = 'restarting';
    const delayMs = Math.min(
      WORKER_RESTART_BACKOFF_START_MS * 2 ** (slot.consecutiveFastCrashes - 1),
      WORKER_RESTART_BACKOFF_MAX_MS,
    );
    return { action: 'refork', delayMs };
  }

  /** Overwrites the slot's RSS (and pid, confirming which process reported). */
  onStats(instance: number, pid: number, rssBytes: number): void {
    const slot = this.slots[instance];
    if (!slot) return;
    slot.pid = pid;
    slot.rssBytes = rssBytes;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** True while any slot is `'starting'` or `'online'`. Never polled. */
  hasLiveWorkers(): boolean {
    return this.slots.some(
      (slot) => slot.status === 'starting' || slot.status === 'online',
    );
  }

  /**
   * True once every slot is stopped — each either given up on its crash
   * budget or exited during shutdown. This, and only this, is the
   * crash-budget exit guard — `hasLiveWorkers()` is not, because a slot
   * waiting out a re-fork backoff is neither live nor stopped.
   */
  allSlotsStopped(): boolean {
    return this.slots.every((slot) => slot.status === 'stopped');
  }

  buildSnapshot(): SupervisorInfo {
    const processes: WorkerProcessSummary[] = this.slots.map((slot) => ({
      instance: slot.instance,
      pid: slot.pid,
      memoryBytes: slot.rssBytes,
      restarts: slot.restarts,
      lastRestartAt: slot.lastRestartAt,
      status: slot.status,
    }));
    return { clustered: true, processes };
  }
}
