/**
 * CPU load signal of the background-rebuild governor (impl-plan DD-15 of
 * 2026-11-23-session-logs-streaming; choice of signal: the task's `research/load-governor.md`).
 *
 * Every `REBUILD_LOAD_SAMPLE_MS` it measures the system CPU busy share from `os.cpus()` time
 * deltas (works on Windows, Linux and macOS; `os.loadavg()` is always zero on Windows). When the
 * process runs under a cgroup v2 CPU quota (`/sys/fs/cgroup/cpu.max` is not `max`), it also
 * measures the cgroup's share of its quota from `usage_usec` in `/sys/fs/cgroup/cpu.stat` and
 * takes the larger of the two, so a container limited to 1 CPU on a 4-core host is seen as busy
 * when it uses its one CPU. The reported load is the mean of the last `CPU_LOAD_SAMPLE_WINDOW`
 * samples. Each worker samples on its own; there is no cross-worker coordination.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { readFileSync } from 'fs';
import * as os from 'os';
import { readPositiveIntEnv } from '../env-int';

/** Sampling period when `REBUILD_LOAD_SAMPLE_MS` is unset or invalid. */
export const DEFAULT_REBUILD_LOAD_SAMPLE_MS = 2_000;

/** Number of recent samples averaged into the reported load. */
export const CPU_LOAD_SAMPLE_WINDOW = 3;

const CGROUP_CPU_MAX = '/sys/fs/cgroup/cpu.max';
const CGROUP_CPU_STAT = '/sys/fs/cgroup/cpu.stat';

/** `REBUILD_LOAD_SAMPLE_MS` when it is a positive integer, else the default. */
export function resolveRebuildLoadSampleMs(): number {
  return readPositiveIntEnv(
    'REBUILD_LOAD_SAMPLE_MS',
    DEFAULT_REBUILD_LOAD_SAMPLE_MS,
  );
}

interface HostCpuTimes {
  busy: number;
  total: number;
}

interface CgroupUsage {
  usageUsec: number;
  atUsec: number;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 100 ? 100 : value;
}

function readHostCpuTimes(): HostCpuTimes {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times;
    const all = user + nice + sys + idle + irq;
    total += all;
    busy += all - idle;
  }
  return { busy, total };
}

/** CPUs the cgroup v2 quota allows, or null when there is no quota (or no cgroup v2). */
function readCgroupQuotaCpus(): number | null {
  if (process.platform !== 'linux') {
    return null;
  }
  try {
    const [quota, period] = readFileSync(CGROUP_CPU_MAX, 'utf8')
      .trim()
      .split(/\s+/);
    const quotaUsec = Number(quota);
    const periodUsec = Number(period);
    if (
      quota === 'max' ||
      !Number.isFinite(quotaUsec) ||
      !Number.isFinite(periodUsec) ||
      quotaUsec <= 0 ||
      periodUsec <= 0
    ) {
      return null;
    }
    return quotaUsec / periodUsec;
  } catch {
    return null;
  }
}

function readCgroupUsage(): CgroupUsage | null {
  try {
    const match = /^usage_usec\s+(\d+)/m.exec(
      readFileSync(CGROUP_CPU_STAT, 'utf8'),
    );
    if (!match) {
      return null;
    }
    const [seconds, nanos] = process.hrtime();
    const atUsec = seconds * 1e6 + nanos / 1e3;
    return { usageUsec: Number(match[1]), atUsec };
  } catch {
    return null;
  }
}

@Injectable()
export class CpuLoadSampler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CpuLoadSampler.name);
  readonly sampleMs = resolveRebuildLoadSampleMs();
  private readonly quotaCpus = readCgroupQuotaCpus();
  private timer: NodeJS.Timeout | null = null;
  private lastHost: HostCpuTimes | null = null;
  private lastCgroup: CgroupUsage | null = null;
  private readonly samples: number[] = [];

  onModuleInit(): void {
    if (this.quotaCpus !== null) {
      this.logger.log(
        `CPU load uses the cgroup v2 quota of ${this.quotaCpus} CPU(s) as well as host CPU time`,
      );
    }
    this.sample();
    this.timer = setInterval(() => this.sample(), this.sampleMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Mean CPU busy % (0–100) of the last samples; 0 before the first full sample. */
  loadPct(): number {
    if (this.samples.length === 0) {
      return 0;
    }
    const sum = this.samples.reduce((acc, value) => acc + value, 0);
    return sum / this.samples.length;
  }

  /** Takes one sample; the first call only records the baseline. */
  private sample(): void {
    try {
      const host = readHostCpuTimes();
      const cgroup = this.quotaCpus !== null ? readCgroupUsage() : null;
      const hostPct = this.hostSharePct(host);
      const cgroupPct = this.cgroupSharePct(cgroup);
      this.lastHost = host;
      this.lastCgroup = cgroup;
      if (hostPct === null && cgroupPct === null) {
        return;
      }
      this.samples.push(clampPct(Math.max(hostPct ?? 0, cgroupPct ?? 0)));
      while (this.samples.length > CPU_LOAD_SAMPLE_WINDOW) {
        this.samples.shift();
      }
    } catch (err) {
      this.logger.warn(
        `CPU load sample failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private hostSharePct(host: HostCpuTimes): number | null {
    if (!this.lastHost) {
      return null;
    }
    const total = host.total - this.lastHost.total;
    if (total <= 0) {
      return null;
    }
    return ((host.busy - this.lastHost.busy) / total) * 100;
  }

  private cgroupSharePct(cgroup: CgroupUsage | null): number | null {
    if (!cgroup || !this.lastCgroup || this.quotaCpus === null) {
      return null;
    }
    const elapsed = cgroup.atUsec - this.lastCgroup.atUsec;
    if (elapsed <= 0) {
      return null;
    }
    const used = cgroup.usageUsec - this.lastCgroup.usageUsec;
    return (used / (this.quotaCpus * elapsed)) * 100;
  }
}
