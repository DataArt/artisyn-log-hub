/**
 * Version of the server-side derivation of a stored log (DD-20 of
 * 2026-11-23-session-logs-streaming). Stored in `logs.ingest_version` next to `body_sha256`;
 * an identical re-upload is skipped only when the stored row was derived by this same version.
 *
 * Bump it on any change to the NDJSON parser, null stripping, `extractClaudeStats` or
 * `writeClaudeDerived` — every stored transcript is then re-processed on its next upload.
 */
export const INGEST_VERSION = 1;

/**
 * Optional ingest metadata `LogsService.upsert` writes next to the body (DD-18):
 * - `bodySha256` — sha256 hex of the staged raw body string (UTF-8), computed before parsing;
 * - `receivedAt` — `upload_queue.received_at` of the row, the "newer upload wins" key (DD-19).
 *
 * Absent (an older caller), both columns are written as NULL and the ordering guard always lets
 * the write through.
 */
export interface UpsertIngestMeta {
  bodySha256: string;
  receivedAt: Date;
}
