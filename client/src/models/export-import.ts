/**
 * Types for the Repository Export/Import endpoints — mirrors
 * `RepositoryExportImportController`'s response shapes
 * (`server/src/logs/repository-export-import.controller.ts`,
 * `server/src/logs/export-import-zip.ts`). See
 * `docs/knowledgebase/api-reference.md` § "Repository Export/Import".
 */

/** Scope a `GET .../export-import/scope`, `POST .../export`, or
 * `GET .../export-import/scope`-style request narrows to. */
export type ExportImportScope = 'all' | 'dateRange' | 'sessionIds';

/** `GET :repoId/export-import/scope` response — session count + approximate
 * (not byte-exact) uncompressed size for the requested scope. */
export interface ExportScopeSummary {
  sessionCount: number;
  approxUncompressedBytes: number;
}

/** `GET :repoId/export/:jobId/status` / `GET :repoId/import/:jobId/status`
 * response shape. `status` never actually resolves to `'staged'` through
 * these two endpoints (a still-staged, unconfirmed upload 404s instead), but
 * the field is left inclusive of it to mirror the server's
 * `ExportImportJobStatus` union exactly. */
export interface ExportImportJobStatus {
  status: 'staged' | 'running' | 'done' | 'error';
  processed: number;
  total: number;
  errorMessage?: string;
}

/** Top-level `meta.json` shape (also embedded in `ImportUploadSummary`) — see
 * `docs/knowledgebase/api-reference.md` § "Repository Export/Import". */
export interface ExportMetaJson {
  formatVersion: number;
  createdAt: string;
  sourceHost: string;
  sourceRepoUrl: string;
  sourceRepoContext: {
    type: 'personal' | 'team';
    teamId?: number;
    teamName?: string;
  };
  description?: string;
  sessionCount: number;
  approxUncompressedBytes: number;
}

/** `POST :repoId/import/upload` response — the staged zip's preview summary,
 * shown before the user confirms the import. */
export interface ImportUploadSummary {
  uploadToken: string;
  sessionCount: number;
  approxUncompressedBytes: number;
  meta: ExportMetaJson;
}

/** `GET .../bootstrap-import/:jobId/status` response — same shape as
 * {@link ExportImportJobStatus} plus the target repo's id, which isn't known
 * to the caller up front (there's no existing `repoId` for a bootstrap
 * import — the target repo is resolved/created from the zip's own
 * `meta.sourceRepoUrl` at confirm time). */
export interface BootstrapImportJobStatus extends ExportImportJobStatus {
  repoId: number | null;
}
