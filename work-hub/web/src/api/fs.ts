// `/api/v1/workspaces/{id}/views/{view}/fs/*` (API changes → Files). `view` is `main` (the
// working branch) or a workstream id.

import { API, apiCall, apiJson, seg } from "./client";

/** The working-branch view; any other view is a workstream id. */
export const MAIN_VIEW = "main";

export type EntryKind = "file" | "dir" | "symlink";

/** `Entry`: `path` is repo-relative, `mtime` is epoch seconds. */
export interface Entry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  mtime: number;
}

/** What the IDE does with a file (`X-WorkHub-Kind`). */
export type FileKind = "text" | "image" | "binary";

/** `POST …/poll`: listings by dir and versions by file, `null` when missing. */
export interface PollResult {
  dirs: Record<string, Entry[] | null>;
  files: Record<string, string | null>;
}

/** `GET …/file`. */
export interface FileContent {
  bytes: Uint8Array<ArrayBuffer>;
  /** The `ETag` without quotes. */
  version: string;
  kind: FileKind;
}

/** One file of an upload: its content and the path relative to the target dir. */
export interface UploadItem {
  file: Blob;
  relativePath: string;
}

function base(workspaceId: string, view: string): string {
  return `${API}/workspaces/${seg(workspaceId)}/views/${seg(view)}/fs`;
}

function q(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function parseKind(v: string | null): FileKind {
  return v === "text" || v === "image" ? v : "binary";
}

function unquote(etag: string | null): string {
  if (!etag) return "";
  return etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

/** 404 when the dir is missing. `dir` is `''` for the root. */
export async function listDir(
  workspaceId: string,
  view: string,
  dir: string,
): Promise<Entry[]> {
  const body = await apiJson<{ entries: Entry[] }>(
    `${base(workspaceId, view)}/list?${q({ dir })}`,
  );
  return body.entries;
}

export async function pollFs(
  workspaceId: string,
  view: string,
  dirs: string[],
  files: string[],
): Promise<PollResult> {
  return apiJson<PollResult>(`${base(workspaceId, view)}/poll`, {
    method: "POST",
    json: { dirs, files },
  });
}

export async function readFile(
  workspaceId: string,
  view: string,
  path: string,
): Promise<FileContent> {
  const res = await apiCall(`${base(workspaceId, view)}/file?${q({ path })}`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    version: unquote(res.headers.get("ETag")),
    kind: parseKind(res.headers.get("X-WorkHub-Kind")),
  };
}

/** URL of a file's raw bytes (images in `<img>`). */
export function fileUrl(workspaceId: string, view: string, path: string) {
  return `${base(workspaceId, view)}/file?${q({ path })}`;
}

/**
 * Saves text guarded by `If-Match: "<version>"`. 409 `changed_on_disk` (with `details.version`)
 * · 400 `not_text`.
 */
export async function saveFile(
  workspaceId: string,
  view: string,
  path: string,
  text: string,
  version: string,
): Promise<{ version: string }> {
  return apiJson<{ version: string }>(
    `${base(workspaceId, view)}/file?${q({ path })}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "If-Match": `"${version}"`,
      },
      body: text,
    },
  );
}

/** Multipart `files`, each named by its relative path. 409 `target_exists {paths}`. */
export async function uploadFiles(
  workspaceId: string,
  view: string,
  dir: string,
  items: UploadItem[],
  overwrite: boolean,
): Promise<{ paths: string[] }> {
  const form = new FormData();
  for (const item of items) form.append("files", item.file, item.relativePath);
  return apiJson<{ paths: string[] }>(
    `${base(workspaceId, view)}/upload?${q({ dir, overwrite: overwrite ? "1" : "0" })}`,
    { method: "POST", body: form },
  );
}

/** 409 `target_exists` · 400 `invalid_path`. */
export async function movePath(
  workspaceId: string,
  view: string,
  from: string,
  toDir: string,
  overwrite: boolean,
): Promise<{ path: string }> {
  return apiJson<{ path: string }>(`${base(workspaceId, view)}/move`, {
    method: "POST",
    json: { from, toDir, overwrite },
  });
}

/** URL of the attachment download (a folder comes as `.zip`). */
export function downloadUrl(
  workspaceId: string,
  view: string,
  path: string,
): string {
  return `${base(workspaceId, view)}/download?${q({ path })}`;
}
