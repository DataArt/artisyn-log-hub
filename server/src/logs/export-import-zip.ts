import * as fs from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';
import type { ImportLimits } from './import-limits';
import { getImportLimits, ImportLimitError } from './import-limits';
import { parseNdjsonLines } from './ndjson-parser';

/**
 * Format of the `exportImportJobs`/`meta.json` `formatVersion` field written on
 * export and checked on import. Bump this whenever the zip
 * structure changes in a way that would break parsing an older export.
 */
export const EXPORT_FORMAT_VERSION = 1;

/**
 * Number of sessions processed per batch during both export serialization and
 * import writes — `runExportJob`/`runImportJob` `await` an
 * event-loop yield between batches so a large export/import doesn't monopolize
 * the event loop.
 */
export const EXPORT_IMPORT_CHUNK_SIZE = 25;

/**
 * Resolves (and lazily creates) the on-disk staging directory for both
 * in-progress export zips and uploaded-but-not-yet-confirmed import zips.
 * Mirrors `UploadQueueService.resolveStagingDir()`'s convention:
 * resolved relative to CWD, overridable via env var, created
 * on first use rather than requiring the directory to pre-exist.
 */
export function resolveExportImportStagingDir(): string {
  const dir = path.resolve(process.env.EXPORT_IMPORT_DIR || 'export-import');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Top-level `meta.json` shape (also this task's `RepositoryExportImportController`
 * upload-summary response shape) — see requirements.md's "Proposed zip
 * structure" section. `formatVersion` is always `EXPORT_FORMAT_VERSION` at
 * write time; import validates it equals the *importing* server's constant.
 */
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

/**
 * One `logs` row's export-time owner, keyed by log type. `userEmail` (rather
 * than the source instance's raw `logs.userId`) is the one addition beyond
 * requirements.md's zip-structure example — a raw id
 * is meaningless once imported into a different database instance; import
 * resolves the target `userId` by looking up (or placeholder-creating) a
 * `users` row for this email.
 */
export interface SessionJsonLogEntry {
  userEmail: string;
}

/**
 * Per-session `sessions/<sessionId>/session.json` shape.
 * `stats` mirrors the session's `session_stats`/`session_file_stats` rows at
 * export time as a frozen snapshot for display purposes only — import always
 * re-derives current `session_stats`/`session_file_stats` rows from the
 * imported `claude` log body via `extractClaudeStats`/`upsertSessionFileStats`
 * rather than trusting this snapshot.
 */
export interface SessionJson {
  sessionId: string;
  parentSessionId: string | null;
  workflowRunId: string | null;
  firstPrompt: string | null;
  startTime: string;
  endTime: string;
  gitBranch: string | null;
  stats: Record<string, unknown> | null;
  logs: {
    claude?: SessionJsonLogEntry;
    artisyn?: SessionJsonLogEntry;
  };
}

/**
 * Zip-slip guard: normalizes a zip entry's path and
 * rejects it if it would escape the extraction root — an absolute path, or a
 * relative path starting with a `..` segment. Callers must check this for
 * every entry *before* ever opening a read stream or writing to disk; the
 * whole import job aborts with an error status on the first unsafe entry.
 */
export function isSafeZipEntryPath(entryFileName: string): boolean {
  const normalized = path.normalize(entryFileName);
  if (path.isAbsolute(normalized)) {
    return false;
  }
  const segments = normalized.split(path.sep);
  return segments[0] !== '..';
}

/**
 * Serializes a decoded `logs.body` array back into the newline-delimited-JSON
 * string written to `<sessionId>/<logType>.jsonl` in the export zip — the
 * inverse of {@link parseJsonlToArray}.
 */
export function serializeArrayToJsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

/**
 * Parses a `.jsonl` zip entry's raw contents back into an array of decoded
 * JSON objects on import. Thin wrapper around the existing
 * `parseNdjsonLines` (shared malformed-line validation/null-char stripping
 * used by the upload-queue path) so both the export and import serialization
 * helpers live together in this one file.
 */
export function parseJsonlToArray(raw: string): object[] {
  return parseNdjsonLines(raw);
}

/** Local file header signature every non-empty zip starts with: `PK\x03\x04`. */
const ZIP_LOCAL_HEADER_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function hasZipSignature(filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const head = Buffer.alloc(ZIP_LOCAL_HEADER_SIGNATURE.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(ZIP_LOCAL_HEADER_SIGNATURE);
  } finally {
    await handle.close();
  }
}

/**
 * Counts one entry's bytes as they are actually inflated — never trusting the sizes the
 * zip headers declare — and aborts as soon as the per-entry or the running total limit
 * is exceeded. Returns the entry's byte count.
 */
async function countEntryBytes(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  totalSoFar: number,
  limits: ImportLimits,
): Promise<number> {
  const stream = await zipfile.openReadStreamPromise(entry);
  return new Promise<number>((resolve, reject) => {
    let entryBytes = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(err);
    };
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      entryBytes += chunk.length;
      if (entryBytes > limits.maxEntryBytes) {
        fail(
          ImportLimitError.exceeded(
            'maxEntryBytes',
            entryBytes,
            limits.maxEntryBytes,
          ),
        );
        return;
      }
      const total = totalSoFar + entryBytes;
      if (total > limits.maxUncompressedBytes) {
        fail(
          ImportLimitError.exceeded(
            'maxUncompressedBytes',
            total,
            limits.maxUncompressedBytes,
          ),
        );
      }
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(entryBytes);
    });
    stream.on('error', (err: Error) => fail(err));
  });
}

/**
 * Validates an uploaded import zip against {@link getImportLimits} before anything is
 * staged: the file must start with `PK\x03\x04`, and a streaming
 * pass over every entry checks the entry count, each entry's inflated size and the
 * total inflated size. Throws {@link ImportLimitError} on any violation; a file that
 * cannot be read as a zip at all is reported as "not a zip archive".
 */
export async function scanZipLimits(
  filePath: string,
  limits: ImportLimits = getImportLimits(),
): Promise<void> {
  if (!(await hasZipSignature(filePath))) {
    throw ImportLimitError.notZip();
  }

  let zipfile: yauzl.ZipFile;
  try {
    zipfile = await yauzl.openPromise(filePath, { lazyEntries: true });
  } catch {
    throw ImportLimitError.notZip();
  }

  try {
    // The central directory's count is known up front — reject without reading.
    if (zipfile.entryCount > limits.maxEntries) {
      throw ImportLimitError.exceeded(
        'maxEntries',
        zipfile.entryCount,
        limits.maxEntries,
      );
    }

    let entries = 0;
    let totalBytes = 0;
    for await (const entry of zipfile.eachEntry()) {
      entries += 1;
      if (entries > limits.maxEntries) {
        throw ImportLimitError.exceeded(
          'maxEntries',
          entries,
          limits.maxEntries,
        );
      }
      if (entry.fileName.endsWith('/')) continue; // directory marker
      totalBytes += await countEntryBytes(zipfile, entry, totalBytes, limits);
    }
  } catch (err) {
    if (err instanceof ImportLimitError) throw err;
    throw ImportLimitError.notZip();
  } finally {
    zipfile.close();
  }
}
