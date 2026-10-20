/**
 * Response shape for `GET /api/v1/admin/system`. This is the single named source of truth for the endpoint's
 * shape — `SystemInfoService.getSystemInfo()` and the (future) controller
 * handler both use this as their return type. The client declares an
 * independent `SystemInfo` interface in `client/src/models/admin.ts` (per the
 * `RepoRow` (server) / `AdminRepo` (client) isolation convention) rather than
 * importing this file.
 */
import type { BuildInfo } from '../common/build-info';

export interface SystemInfoResponse {
  /** expected = computeInstanceCount(cpus.visible); actual = supervisor.processes.length */
  instances: { expected: number; actual: number };
  /** visible = os.availableParallelism(); raw = os.cpus().length */
  cpus: { visible: number; raw: number };
  /** 1m / 5m / 15m, os.loadavg() */
  loadAverage: [number, number, number];
  memory: {
    processRssBytes: number;
    systemUsedBytes: number;
    systemTotalBytes: number;
  };
  /** containerSeconds is null when not running inside a container */
  uptime: { processSeconds: number; containerSeconds: number | null };
  db: {
    connected: boolean;
    /** null when connected=false */
    pingMs: number | null;
    pool: { max: number; total: number; idle: number; waiting: number };
  };
  dbSpace: {
    /** false = DB role lacks size-inspection rights (or query failed) — client hides the whole card */
    available: boolean;
    /** pg_class.reltuples, null when available=false */
    logsTableRowEstimate: number | null;
    /** pg_total_relation_size('logs'), null when available=false */
    logsTableBytes: number | null;
    /** pg_database_size(current_database()), null when available=false */
    databaseTotalBytes: number | null;
  };
  /**
   * Version, git commit and — since the release-zip work — `releaseStamp`,
   * the UTC `YYYYMMDD-HHMMSS` identity of the release this image was built
   * from (`dev` outside a Docker build, `unknown` for an image built before
   * the field existed). The client renders it as its own Release tile.
   */
  build: BuildInfo;
  node: { version: string; env: string };
  /** this-instance only */
  eventLoopLagMs: number;
  /** this-instance only */
  requests: { perSecond: number; active: number };
  disk: {
    logsDirBytes: number;
    filesystemTotalBytes: number;
    filesystemFreeBytes: number;
  };
  supervisor: SupervisorInfo;
}

export interface SupervisorInfo {
  /** false when running as a single process with no cluster primary (e.g. local dev) */
  clustered: boolean;
  processes: WorkerProcessSummary[];
}

export interface WorkerProcessSummary {
  /** 0-based slot index == NODE_APP_INSTANCE; null in the single-process fallback */
  instance: number | null;
  /** last known pid for the slot; -1 if never forked */
  pid: number;
  /** worker-self-reported process.memoryUsage().rss; null until the slot has reported */
  memoryBytes: number | null;
  restarts: number;
  /** ISO string, null if never restarted */
  lastRestartAt: string | null;
  /** 'starting' | 'online' | 'restarting' | 'stopped', or 'online (single process)' in fallback */
  status: string;
}
