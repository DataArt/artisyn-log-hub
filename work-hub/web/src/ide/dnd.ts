// Drag and drop in the file tree (D12, FR-16, FR-17, FR-19):
// - drop from the computer: files and whole folders, read through `webkitGetAsEntry` into
//   paths relative to the drop target;
// - drag out to the computer: `DownloadURL` (Chromium); the "Download" menu item works anywhere;
// - inside the tree: the dragged path under `application/x-workhub-path`, a drop on a folder
//   moves it.

import type { UploadItem } from "../api/fs";

/** MIME type of a path dragged inside the tree. */
export const INTERNAL_MIME = "application/x-workhub-path";

/** The drag carries files from the computer. */
export function isFileDrag(dt: DataTransfer | null): boolean {
  return dt !== null && Array.from(dt.types).includes("Files");
}

/** The drag is a tree entry being moved. */
export function isInternalDrag(dt: DataTransfer | null): boolean {
  return dt !== null && Array.from(dt.types).includes(INTERNAL_MIME);
}

/** The dragged tree path, if this is an internal drag. */
export function internalPath(dt: DataTransfer): string | null {
  const v = dt.getData(INTERNAL_MIME);
  return v === "" ? null : v;
}

/**
 * Starts dragging a tree entry: the internal path for moves, and a `DownloadURL` so dropping it
 * on the desktop downloads it (a folder as `<name>.zip`).
 */
export function startEntryDrag(
  dt: DataTransfer,
  entry: { path: string; name: string; kind: string },
  downloadHref: string,
): void {
  dt.effectAllowed = "copyMove";
  dt.setData(INTERNAL_MIME, entry.path);
  dt.setData("text/plain", entry.path);
  const fileName = entry.kind === "dir" ? `${entry.name}.zip` : entry.name;
  const absolute = new URL(downloadHref, window.location.href).href;
  dt.setData("DownloadURL", `application/octet-stream:${fileName}:${absolute}`);
}

function readAllEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  // `readEntries` returns the folder in batches; an empty batch means the end.
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        next();
      }, reject);
    };
    next();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectoryEntry(
  entry: FileSystemEntry,
): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

async function walk(
  entry: FileSystemEntry,
  prefix: string,
  out: UploadItem[],
): Promise<void> {
  const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
  if (isFileEntry(entry)) {
    out.push({ file: await entryFile(entry), relativePath });
  } else if (isDirectoryEntry(entry)) {
    const children = await readAllEntries(entry.createReader());
    for (const child of children) await walk(child, relativePath, out);
  }
}

/**
 * The files of a drop from the computer, each with its path relative to the drop target
 * (folders recursed). Must be called inside the `drop` handler: the items are only readable
 * during the event, so the entries are taken synchronously before any await.
 */
export function collectDroppedFiles(dt: DataTransfer): Promise<UploadItem[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    // No entry API: plain files only.
    return Promise.resolve(
      Array.from(dt.files).map((file) => ({ file, relativePath: file.name })),
    );
  }
  return (async () => {
    const out: UploadItem[] = [];
    for (const entry of entries) await walk(entry, "", out);
    return out;
  })();
}
