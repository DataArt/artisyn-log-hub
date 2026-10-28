/**
 * OKF usage — per-node access extraction (FR-1, FR-2, FR-6; impl-plan DD-1..DD-8, DD-27).
 *
 * Walks one `claude` / `claude-subagent` transcript (one tree node) and turns its tool calls into
 * `session_okf_access` rows: which repo paths the node read, searched, listed or wrote, how many
 * result bytes each got and in which order it first touched them. Pure: no DB, no filesystem; the
 * Bash parser is handed in (`getServerBashParser()`), and a `null` parser skips Bash calls only.
 *
 * Rules (pinned by `docs/knowledgebase/algorithms/okf-access-extraction.md`):
 * - Bytes = UTF-8 bytes of the call's `tool_result` text (string content, or the concatenated
 *   `text` blocks; images count 0) — DD-1.
 * - Op per tool (DD-3): Read → `read` (file); Edit / MultiEdit / Write / NotebookEdit → `write`
 *   (bytes 0); Grep → `grep` (file when its `path` names a file, else the folder, cwd when absent);
 *   Glob → `list` (folder = `path` or cwd plus the static prefix of `pattern`); Bash → its
 *   `analyzeBash` `readAccess` kinds plus `write` for `changes`.
 * - A Bash call's bytes are split evenly over its resolved read/grep/list paths, the remainder to
 *   the first (DD-2); every path gets `calls += 1`; write paths get 0 bytes.
 * - Paths resolve to repo-relative keys through `resolveRepoPath` (DD-5, DD-6); a path outside
 *   every root, or any path when the node has no root, yields nothing. File rows are kept only for
 *   `.md` files; folder rows (`<rel>/`, repo root `/`) for any folder (DD-3, DD-4).
 * - `afterOwnEdit`: a `read` / `grep` of a path this node already wrote (DD-7).
 * - A `tool_use` id seen twice counts once, first occurrence wins (DD-8).
 * - `seq` = 1-based rank of the path's first stored access in the node; all rows of one path share
 *   it (DD-27).
 */
import { analyzeBash, type BashParser } from '@loghub/bash-view';
import {
  resolveRepoPath,
  truncateChangedPath,
} from '../change-surface/path-normalise';

export type OkfAccessOp = 'read' | 'grep' | 'list' | 'write';

/** One `session_okf_access` row of a node (without the node's session id). */
export interface OkfAccessRow {
  /** Repo-relative file path, or folder path ending in `/` (repo root = `/`). */
  pathKey: string;
  op: OkfAccessOp;
  afterOwnEdit: boolean;
  bytes: number;
  calls: number;
  seq: number;
}

export interface ExtractOkfAccessOptions {
  /**
   * `true` for a `claude-subagent` log, whose every line is a sidechain line. In a root log,
   * `isSidechain` lines belong to a sub-agent and are skipped (same rule as harness usage).
   */
  isSubagentLog?: boolean;
}

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as AnyRecord)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** DD-1: UTF-8 bytes of a tool_result's text (string content or `text` blocks). */
export function toolResultBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const item of content) {
    const b = asRecord(item);
    if (b === null || b['type'] !== 'text') continue;
    const text = asString(b['text']);
    if (text !== null) total += Buffer.byteLength(text, 'utf8');
  }
  return total;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function isAbsolutePosix(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:(\/|$)/.test(p);
}

/**
 * Absolute spelling of `p` against the base directories (DD-5): an absolute `p` is kept, a
 * relative one is joined onto the first base, which itself may be relative to the next. `~` paths
 * and relative paths without an absolute base cannot be resolved (`null`).
 */
export function toAbsolute(
  p: string,
  ...bases: (string | null | undefined)[]
): string | null {
  let current = toPosix(p.trim());
  if (current.startsWith('~')) return null;
  for (const base of bases) {
    if (isAbsolutePosix(current)) return current;
    if (base === null || base === undefined || base === '') continue;
    const b = toPosix(base.trim());
    if (b.startsWith('~')) return null;
    current = current === '' ? b : `${b.replace(/\/+$/, '')}/${current}`;
  }
  return isAbsolutePosix(current) ? current : null;
}

function lastSegment(p: string): string {
  const parts = p.split('/').filter((s) => s.length > 0);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/** A name with an extension (`a.md`, `x.test.ts`); a dot-folder such as `.claude` has none. */
function hasExtension(p: string): boolean {
  return /^.+\.[^.]+$/.test(lastSegment(p));
}

function folderKey(rel: string): string {
  return rel === '' ? '/' : `${rel}/`;
}

/** Static leading segments of a glob pattern (before the first segment with a glob char). */
function globStaticPrefix(pattern: string): string {
  const segs = toPosix(pattern).split('/');
  const out: string[] = [];
  for (const seg of segs) {
    if (/[*?[\]{}]/.test(seg)) {
      return out.length === 1 && out[0] === '' ? '/' : out.join('/');
    }
    out.push(seg);
  }
  // No glob char at all: the pattern names one file — its folder is listed.
  out.pop();
  return out.length === 1 && out[0] === '' ? '/' : out.join('/');
}

/** One resolved access of a call, before aggregation. */
interface CallAccess {
  key: string;
  isFolder: boolean;
  op: OkfAccessOp;
  /** Read-side access: shares the call's result bytes (DD-2). */
  readSide: boolean;
}

function isStoredKey(access: CallAccess): boolean {
  return access.isFolder || access.key.toLowerCase().endsWith('.md');
}

/** Accesses of one tool call, in the order the bytes split and `seq` see them. */
function accessesOfCall(
  name: string,
  input: AnyRecord,
  cwd: string | null,
  roots: readonly string[],
  parser: BashParser | null,
): CallAccess[] {
  const resolve = (
    p: string | null,
    ...bases: (string | null)[]
  ): string | null => {
    if (p === null) return null;
    const abs = toAbsolute(p, ...bases);
    return abs === null ? null : resolveRepoPath(abs, roots);
  };
  const file = (
    rel: string | null,
    op: OkfAccessOp,
    readSide: boolean,
  ): CallAccess[] =>
    rel === null || rel === ''
      ? []
      : [{ key: rel, isFolder: false, op, readSide }];
  const folder = (rel: string | null, op: OkfAccessOp): CallAccess[] =>
    rel === null
      ? []
      : [{ key: folderKey(rel), isFolder: true, op, readSide: true }];

  switch (name) {
    case 'Read':
      return file(resolve(asString(input['file_path']), cwd), 'read', true);
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return file(resolve(asString(input['file_path']), cwd), 'write', false);
    case 'NotebookEdit':
      return file(
        resolve(asString(input['notebook_path']), cwd),
        'write',
        false,
      );
    case 'Grep': {
      const given = asString(input['path']);
      const rel = resolve(given ?? '', cwd);
      if (given !== null && !given.endsWith('/') && hasExtension(given)) {
        return file(rel, 'grep', true);
      }
      return folder(rel, 'grep');
    }
    case 'Glob': {
      const base = asString(input['path']);
      const pattern = asString(input['pattern']) ?? '';
      const prefix = globStaticPrefix(pattern);
      return folder(resolve(prefix, base, cwd), 'list');
    }
    case 'Bash': {
      if (parser === null) return [];
      const command = asString(input['command']);
      if (command === null || command.trim() === '') return [];
      let analysis: ReturnType<typeof analyzeBash>;
      try {
        analysis = analyzeBash(parser, command);
      } catch {
        return [];
      }
      const out: CallAccess[] = [];
      for (const access of analysis.readAccess) {
        const rel = resolve(access.path, analysis.workDir, cwd);
        if (access.kind === 'list') out.push(...folder(rel, 'list'));
        else if (
          access.kind === 'grep' &&
          (access.path.endsWith('/') || !hasExtension(access.path))
        ) {
          out.push(...folder(rel, 'grep'));
        } else out.push(...file(rel, access.kind, true));
      }
      for (const p of analysis.changes) {
        out.push(...file(resolve(p, analysis.workDir, cwd), 'write', false));
      }
      return out;
    }
    default:
      return [];
  }
}

/** Drop a repeated `(key, op)` within one call (two spellings of one path). */
function dedupeWithinCall(accesses: CallAccess[]): CallAccess[] {
  const seen = new Set<string>();
  return accesses.filter((a) => {
    const id = `${a.op}\0${a.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Extracts the OKF access rows of one tree node from its transcript lines.
 *
 * `roots` are the session's candidate repo roots (as `writeSessionFileStats` receives them);
 * with none, nothing is extracted (FR-2). `parser` `null` skips Bash calls only (DD-10).
 */
export function extractOkfAccess(
  entries: readonly object[],
  roots: readonly (string | null | undefined)[],
  parser: BashParser | null,
  options: ExtractOkfAccessOptions = {},
): OkfAccessRow[] {
  const usableRoots = roots.filter(
    (r): r is string => typeof r === 'string' && r.trim() !== '',
  );
  if (usableRoots.length === 0) return [];
  const isSubagentLog = options.isSubagentLog === true;

  const visible = entries.filter((line) => {
    const rec = line as AnyRecord;
    return isSubagentLog || rec['isSidechain'] !== true;
  });

  // Pass 1: result bytes per tool_use id (first result wins, DD-8).
  const resultBytes = new Map<string, number>();
  for (const line of visible) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'user') continue;
    const content = asRecord(rec['message'])?.['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_result') continue;
      const id = asString(b['tool_use_id']);
      if (id === null || resultBytes.has(id)) continue;
      resultBytes.set(id, toolResultBytes(b['content']));
    }
  }

  // Pass 2: tool calls in transcript order.
  const rows = new Map<string, OkfAccessRow>();
  const seqByKey = new Map<string, number>();
  const ownWritten = new Set<string>();
  const seenIds = new Set<string>();
  let cwd: string | null = null;

  for (const line of visible) {
    const rec = line as AnyRecord;
    const lineCwd = asString(rec['cwd']);
    if (lineCwd !== null && lineCwd !== '') cwd = lineCwd;
    if (rec['type'] !== 'assistant') continue;
    const content = asRecord(rec['message'])?.['content'];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_use') continue;
      const id = asString(b['id']);
      if (id !== null) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      const name = asString(b['name']);
      const input = asRecord(b['input']);
      if (name === null || input === null) continue;

      const accesses = dedupeWithinCall(
        accessesOfCall(name, input, cwd, usableRoots, parser),
      );
      if (accesses.length === 0) continue;

      // DD-2: even split of the result bytes over the read-side paths, remainder to the first.
      const total = id === null ? 0 : (resultBytes.get(id) ?? 0);
      const readSide = accesses.filter((a) => a.readSide);
      const share =
        readSide.length > 0 ? Math.floor(total / readSide.length) : 0;
      const remainder = total - share * readSide.length;
      const bytesOf = new Map<CallAccess, number>();
      readSide.forEach((a, i) =>
        bytesOf.set(a, share + (i === 0 ? remainder : 0)),
      );

      // Reads are judged against the writes of earlier calls (DD-7), then this call's writes count.
      for (const access of accesses) {
        if (!isStoredKey(access)) continue;
        const pathKey = truncateChangedPath(access.key);
        let seq = seqByKey.get(pathKey);
        if (seq === undefined) {
          seq = seqByKey.size + 1;
          seqByKey.set(pathKey, seq);
        }
        const afterOwnEdit =
          (access.op === 'read' || access.op === 'grep') &&
          ownWritten.has(pathKey);
        const rowId = `${pathKey}\0${access.op}\0${afterOwnEdit ? 1 : 0}`;
        let row = rows.get(rowId);
        if (row === undefined) {
          row = {
            pathKey,
            op: access.op,
            afterOwnEdit,
            bytes: 0,
            calls: 0,
            seq,
          };
          rows.set(rowId, row);
        }
        row.bytes += bytesOf.get(access) ?? 0;
        row.calls += 1;
      }
      for (const access of accesses) {
        if (access.op === 'write')
          ownWritten.add(truncateChangedPath(access.key));
      }
    }
  }

  return [...rows.values()];
}
