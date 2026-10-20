/**
 * export-import.ts — the repository export/import jobs through the public API
 * (`server/src/logs/repository-export-import.controller.ts`), for the S-REPO-* scenarios:
 * start an export and download its zip, stage and confirm an import, and the bootstrap import
 * that needs no target repository. Every job is polled to a terminal status.
 */
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

export type JobStatus = 'running' | 'done' | 'error' | 'staged';

export interface JobStatusBody {
  status: JobStatus;
  processed: number;
  total: number;
  errorMessage?: string;
  /** Bootstrap status only. */
  repoId?: number | null;
}

export interface UploadSummary {
  uploadToken: string;
  sessionCount: number;
  approxUncompressedBytes: number;
  meta: { sourceRepoUrl: string; sessionCount: number; formatVersion: number };
}

export interface ExportBody {
  scope: 'all' | 'dateRange' | 'sessionIds';
  teamId?: number;
  from?: string;
  to?: string;
  sessionIds?: string[];
}

const repoBase = (repoId: number) => `/api/v1/repositories/${repoId}`;
const teamQuery = (teamId?: number) => (teamId !== undefined ? `?teamId=${teamId}` : '');

/** Polls `statusPath` until the job leaves `running`; fails on a non-200 or after `timeoutMs`. */
export async function waitForJob(api: APIRequestContext, statusPath: string, timeoutMs = 30_000): Promise<JobStatusBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api.get(statusPath);
    expect(res.status(), `GET ${statusPath}`).toBe(200);
    const body = (await res.json()) as JobStatusBody;
    if (body.status === 'done' || body.status === 'error') return body;
    if (Date.now() >= deadline) throw new Error(`Job ${statusPath} still ${body.status} after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** `POST :repoId/export` → 202 `{ jobId }`; the raw response for refusal checks. */
export function startExport(api: APIRequestContext, repoId: number, body: ExportBody = { scope: 'all' }): Promise<APIResponse> {
  return api.post(`${repoBase(repoId)}/export`, { data: body });
}

/** Runs an export job to `done` and returns `{ jobId, zip }` (the downloaded archive). */
export async function exportRepo(
  api: APIRequestContext,
  repoId: number,
  body: ExportBody = { scope: 'all' },
): Promise<{ jobId: string; zip: Buffer }> {
  const start = await startExport(api, repoId, body);
  expect(start.status(), `start export of repo ${repoId}`).toBe(202);
  const { jobId } = (await start.json()) as { jobId: string };
  const status = await waitForJob(api, `${repoBase(repoId)}/export/${jobId}/status${teamQuery(body.teamId)}`);
  expect(status.status, status.errorMessage ?? 'export job').toBe('done');
  const download = await api.get(`${repoBase(repoId)}/export/${jobId}/download${teamQuery(body.teamId)}`);
  expect(download.status(), 'download export zip').toBe(200);
  return { jobId, zip: await download.body() };
}

/** Multipart upload of `zip` under the `file` field to `path`; the raw response. */
export function uploadZip(api: APIRequestContext, path: string, zip: Buffer, fileName = 'export.zip'): Promise<APIResponse> {
  return api.post(path, { multipart: { file: { name: fileName, mimeType: 'application/zip', buffer: zip } } });
}

/** `POST :repoId/import/upload` (staging only); the raw response. */
export function stageImport(api: APIRequestContext, repoId: number, zip: Buffer, teamId?: number): Promise<APIResponse> {
  return uploadZip(api, `${repoBase(repoId)}/import/upload${teamQuery(teamId)}`, zip);
}

/** Stages `zip` into `repoId`, confirms it and waits for the import job; returns the final status. */
export async function importZip(api: APIRequestContext, repoId: number, zip: Buffer): Promise<JobStatusBody> {
  const staged = await stageImport(api, repoId, zip);
  expect(staged.status(), `stage import into repo ${repoId}`).toBe(201);
  const { uploadToken } = (await staged.json()) as UploadSummary;
  const confirm = await api.post(`${repoBase(repoId)}/import/${uploadToken}/confirm`, { data: {} });
  expect(confirm.status(), `confirm import into repo ${repoId}`).toBe(202);
  const { jobId } = (await confirm.json()) as { jobId: string };
  const status = await waitForJob(api, `${repoBase(repoId)}/import/${jobId}/status`);
  expect(status.status, status.errorMessage ?? 'import job').toBe('done');
  return status;
}

/** `POST bootstrap-import/upload`; returns the upload summary (throws on non-201). */
export async function stageBootstrap(api: APIRequestContext, zip: Buffer): Promise<UploadSummary> {
  const res = await uploadZip(api, '/api/v1/repositories/bootstrap-import/upload', zip);
  expect(res.status(), 'stage bootstrap import').toBe(201);
  return (await res.json()) as UploadSummary;
}

/** Confirms a staged bootstrap upload and waits for its job; returns the resolved repo and team. */
export async function confirmBootstrap(
  api: APIRequestContext,
  uploadToken: string,
): Promise<{ jobId: string; repoId: number; teamId: number }> {
  const res = await api.post(`/api/v1/repositories/bootstrap-import/${uploadToken}/confirm`, { data: {} });
  expect(res.status(), 'confirm bootstrap import').toBe(202);
  const body = (await res.json()) as { jobId: string; repoId: number; teamId: number };
  const status = await waitForJob(api, `/api/v1/repositories/bootstrap-import/${body.jobId}/status`);
  expect(status.status, status.errorMessage ?? 'bootstrap import job').toBe('done');
  return body;
}

/** Stages and confirms a bootstrap import in one go. */
export async function bootstrapImport(api: APIRequestContext, zip: Buffer) {
  const { uploadToken } = await stageBootstrap(api, zip);
  return confirmBootstrap(api, uploadToken);
}
