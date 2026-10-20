export interface AdminRepo {
  id: number | null;
  repoUrl: string;
  ownerEmail: string | null;
  sessionCount: number;
  rawUploadCount: number;
  logSize: number;
  maxUploadBytes: number | null;
  lastSession: string | null;
  firstSeen: string | null;
  teamId?: number;
  teamRepoId?: number;
  teamName?: string;
}

export interface AdminTeam {
  id: number;
  name: string;
  ownerEmail: string;
  createdAt: string;
  memberCount: number;
  repoCount: number;
}

export interface AdminUser {
  id: number;
  email: string;
  role: 'admin' | 'user';
  createdAt: string;
  teamCount: number;
  lastActivity: string | null;
}

export interface AdminAuthConfig {
  mode: string;
  smtp?: { host: string; port: number; from: string };
  azure?: {
    tenantId: string;
    clientId: string;
    redirectUri: string;
    authority: string;
  };
}

export interface PendingRegistration {
  id: number;
  email: string;
  registeredAt: string;
  tokenExpiresAt: string;
}

export interface ErrorLogEntry {
  timestamp: string;
  source: string;
  message: string;
  details: string | null;
}

export interface SystemInfoWorkerProcess {
  /** 0-based slot index == NODE_APP_INSTANCE; null in the single-process fallback */
  instance: number | null;
  /** last known pid for the slot; -1 if never forked */
  pid: number;
  /** worker-self-reported RSS; null until the slot has reported */
  memoryBytes: number | null;
  restarts: number;
  lastRestartAt: string | null;
  status: string;
}

export type UploadQueueStatus =
  | 'pending'
  | 'processing'
  | 'failed'
  | 'partially_uploaded'
  | 'rejected_foreign_session';

export interface UploadQueueEntry {
  id: number;
  fileName: string;
  sizeBytes: number;
  receivedAt: string;
  sessionId: string;
  logType: string;
  repoUrl: string | null;
  status: UploadQueueStatus;
  errorMessage: string | null;
  chunksReceived?: number;
  totalChunks?: number;
}

/**
 * One queue-backlog bucket. The server always sends all four statuses, zero-filled
 * and in a fixed order, so the UI never has to handle a missing bucket.
 */
export interface UploadQueueStatusBucket {
  status: UploadQueueStatus;
  files: number;
  bytes: number;
}

/**
 * Worker load / throughput / latency stats for the admin Upload Queue tab
 * (GET /api/v1/admin/upload-queue/stats). Mirrors `UploadQueueStats` in
 * `server/src/admin/upload-queue-stats.service.ts`.
 *
 * Every rate and latency field is `number | null`: `null` means "not measurable in this
 * window" (no successful attempt recorded), and must render as a dash — never as `0`,
 * `Infinity` or `NaN`.
 */
export interface UploadQueueStats {
  /** Rolling window the `worker` and `latency` blocks are measured over. */
  windowMs: number;
  /** Retention window, which is also the window the `worker7d` block is measured over. */
  retentionWindowMs: number;
  byStatus: UploadQueueStatusBucket[];
  total: { files: number; bytes: number };
  processingNow: number;
  worker: {
    instanceCount: number;
    activeMs: number;
    /** 0..100, already clamped server-side. */
    utilizationPercent: number;
    filesPerSec: number | null;
    bytesPerSec: number | null;
    successCount: number;
    failureCount: number;
  };
  worker7d: {
    filesPerSec: number | null;
    bytesPerSec: number | null;
    successCount: number;
  };
  latency: {
    avgMs: number | null;
    p95Ms: number | null;
    minMs: number | null;
    maxMs: number | null;
  };
  drainEtaMs: number | null;
}

export interface DataRetentionDailyBucket {
  day: string;
  sessionCount: number;
  totalSizeBytes: number;
}

export interface DataRetentionStats {
  retentionDays: number;
  oldestSessionAt: string | null;
  youngestSessionAt: string | null;
  totalSessionCount: number;
  dailySeries: DataRetentionDailyBucket[];
}

export interface SystemInfo {
  instances: { expected: number; actual: number };
  cpus: { visible: number; raw: number };
  loadAverage: [number, number, number];
  memory: {
    processRssBytes: number;
    systemUsedBytes: number;
    systemTotalBytes: number;
  };
  uptime: { processSeconds: number; containerSeconds: number | null };
  db: {
    connected: boolean;
    pingMs: number | null;
    pool: { max: number; total: number; idle: number; waiting: number };
  };
  dbSpace: {
    available: boolean;
    logsTableRowEstimate: number | null;
    logsTableBytes: number | null;
    databaseTotalBytes: number | null;
  };
  build: { version: string; gitCommit: string; releaseStamp: string };
  node: { version: string; env: string };
  eventLoopLagMs: number;
  requests: { perSecond: number; active: number };
  disk: {
    logsDirBytes: number;
    filesystemTotalBytes: number;
    filesystemFreeBytes: number;
  };
  supervisor: {
    clustered: boolean;
    processes: SystemInfoWorkerProcess[];
  };
}

/** Architecture of a release bundle. */
export type ReleaseArch = 'amd64' | 'arm64';

/**
 * One release zip carried by this instance, as listed by
 * `GET /api/v1/admin/releases`. Only the newest release stamp is ever listed.
 */
export interface ReleaseZip {
  /** Full file name, e.g. `artisyn-log-hub-20260918-142233-amd64.zip`. */
  fileName: string;
  arch: ReleaseArch;
  /** UTC release stamp, `YYYYMMDD-HHMMSS` — an identity, not a timestamp. */
  stamp: string;
  sizeBytes: number;
}

/** `POST /api/v1/admin/releases/download-link` — a temporary signed link. */
export interface ReleaseDownloadLink {
  /** Absolute, signed, unauthenticated download URL. */
  url: string;
  /** ISO-8601 UTC instant the link stops working. */
  expiresAt: string;
}
