/**
 * zip.ts — a dependency-free zip writer and reader for the export/import scenarios
 * (S-REPO-*). The repository root has no zip library, and the scenarios only need two things:
 *
 *  - `buildZip(entries)` — a valid archive with STORED (uncompressed) entries, which the server's
 *    `yauzl` reader accepts like any other zip. Used to hand-craft export archives whose author
 *    does not exist on the stand (`buildExportZip`).
 *  - `readZip(buffer)` — the entries of an archive the stand produced (`archiver`, deflate), read
 *    through the central directory, so a scenario can look inside a downloaded export.
 *
 * No ZIP64, no encryption, no multi-disk: the archives here are a few kilobytes.
 */
import { crc32, inflateRawSync } from 'zlib';
import { promptSessionBodies, type PromptSession } from './prompt-session';

export interface ZipEntryInput {
  name: string;
  data: string | Buffer;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIR = 0x06054b50;
/** 2026-01-05 00:00 in MS-DOS date/time format; the scenarios never read it back. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 5;

/** A zip archive of `entries`, stored without compression, in the given order. */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIR, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

/** Every file entry of `zip` by name (directory markers skipped), stored or deflated. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === END_OF_CENTRAL_DIR) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive: no end-of-central-directory record');

  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(pos) !== CENTRAL_HEADER) throw new Error(`Bad central directory header at ${pos}`);
    const method = zip.readUInt16LE(pos + 10);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;

    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(raw));
    else if (method === 8) entries.set(name, inflateRawSync(raw));
    else throw new Error(`Unsupported zip compression method ${method} for ${name}`);
  }
  return entries;
}

/** One session of a hand-made export archive: a {@link PromptSession} plus its author's e-mail. */
export interface ExportArchiveSession extends PromptSession {
  /** Written into `session.json` as both logs' `userEmail` — the author the import resolves. */
  userEmail: string;
  /** Written into `session.json` as `parentSessionId`; default `null` (a root session). */
  parentSessionId?: string;
}

export interface ExportArchiveOptions {
  /** `meta.sourceRepoUrl` — the repository a bootstrap import resolves or creates. */
  sourceRepoUrl: string;
  sessions: ExportArchiveSession[];
  /** `meta.formatVersion`; default 1 (`EXPORT_FORMAT_VERSION`). */
  formatVersion?: number;
}

/**
 * An archive in the exact layout `RepositoryExportImportService` writes (`meta.json`, then per
 * session `session.json`, `claude.jsonl`, `artisyn.jsonl`), built from prompt sessions. Lets a
 * scenario import sessions whose author is not a user of the stand, which an export of the stand's
 * own data can never contain.
 */
export function buildExportZip({ sourceRepoUrl, sessions, formatVersion = 1 }: ExportArchiveOptions): Buffer {
  const entries: ZipEntryInput[] = [];
  let bytes = 0;
  const sessionEntries: ZipEntryInput[] = [];
  for (const s of sessions) {
    const bodies = promptSessionBodies(s);
    const at = s.at ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const end = new Date(at.getTime() + ((s.turns ?? 1) - 1) * 120_000 + 60_000);
    const sessionJson = {
      sessionId: s.sessionId,
      parentSessionId: s.parentSessionId ?? null,
      workflowRunId: null,
      firstPrompt: s.prompt,
      startTime: at.toISOString(),
      endTime: end.toISOString(),
      gitBranch: s.branch ?? 'main',
      stats: null,
      logs: { claude: { userEmail: s.userEmail }, artisyn: { userEmail: s.userEmail } },
    };
    bytes += bodies.claude.length + bodies.artisyn.length;
    sessionEntries.push(
      { name: `sessions/${s.sessionId}/session.json`, data: JSON.stringify(sessionJson) },
      { name: `sessions/${s.sessionId}/claude.jsonl`, data: bodies.claude },
      { name: `sessions/${s.sessionId}/artisyn.jsonl`, data: bodies.artisyn },
    );
  }
  const meta = {
    formatVersion,
    createdAt: new Date().toISOString(),
    sourceHost: 'scenario-suite',
    sourceRepoUrl,
    sourceRepoContext: { type: 'personal' },
    sessionCount: sessions.length,
    approxUncompressedBytes: bytes,
  };
  entries.push({ name: 'meta.json', data: JSON.stringify(meta) }, ...sessionEntries);
  return buildZip(entries);
}
