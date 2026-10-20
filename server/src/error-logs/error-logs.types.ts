/**
 * Response shape for `GET /api/v1/admin/error-logs`. This is the single named source of truth for the
 * endpoint's shape — `ErrorLogsService.getErrorLogs()` and the controller
 * handler both use this as their return type. The client declares an
 * independent `ErrorLogEntry` interface in `client/src/models/admin.ts` (per
 * the `RepoRow` (server) / `AdminRepo` (client) isolation convention) rather
 * than importing this file.
 */
export interface ErrorLogEntry {
  /** ISO 8601, parsed from the log line's local-time string */
  timestamp: string;
  /** NestJS logger context, e.g. "AdminPanelController" */
  source: string;
  message: string;
  /** trailing key=val metadata blob and/or continuation lines; null if none */
  details: string | null;
}

export interface ErrorLogsResponse {
  /** newest first, max MAX_ENTRIES */
  entries: ErrorLogEntry[];
}
