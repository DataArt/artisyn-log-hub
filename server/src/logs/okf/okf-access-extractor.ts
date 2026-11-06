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
 * - A call's bytes are split over its resolved read/grep/list paths in proportion to each file's
 *   size in `options.snapshotFiles` (`Math.floor` per path, the remainder to the first); when
 *   there is no snapshot map, a target has no known size (folders never have one) or the sizes
 *   sum to 0, the split is even, the remainder to the first (DD-2, value-view DD-7). Every path
 *   gets `calls += 1`; write paths get 0 bytes.
 * - Ranges (value-view DD-3/DD-4): a Read with `offset` / `limit`, or a Bash read with a known
 *   `range` (`sed -n 'a,bp'`, `head -n N`, `tail -n N`), is a ranged read; its row gets
 *   `rangedCalls += 1` and `rangedBytes += <its bytes>`, both also counted in `calls` / `bytes`.
 * - Search hits (value-view DD-6): a `grep` / `list` access whose call result is not an error
 *   and, trimmed, is neither empty nor `No files found` / `No matches found` adds 1 to the row's
 *   `searchHits`.
 * - A Bash `list` of a path with an extension (`ls a.md`) yields no access at all (FR-8).
 * - Paths resolve to repo-relative keys through `resolveRepoPath` (DD-5, DD-6); a path outside
 *   every root, or any path when the node has no root, yields nothing. File rows are kept only for
 *   `.md` files; folder rows (`<rel>/`, repo root `/`) for any folder (DD-3, DD-4).
 * - `afterOwnEdit`: a `read` / `grep` of a path this node already wrote (DD-7).
 * - A `tool_use` id seen twice counts once, first occurrence wins (DD-8).
 * - `seq` = 1-based rank of the path's first stored access in the node; all rows of one path share
 *   it (DD-27).
 *
 * `extractOkfDetail` adds, from the same walk (value-view DD-1..DD-10):
 * - `ord`: 1-based index of a tool call among the node's tool calls after the duplicate-id rule;
 *   events, pointer rows and the sequence share it (DD-2).
 * - Code events: one per resolved access path of a call, except `.md` files of the snapshot (no
 *   snapshot → all); op read → `read`, grep / list → `search`, write → `write`; a path with a
 *   segment in `OKF_EVENT_SKIP_SEGMENTS` or longer than `OKF_PATH_MAX_CHARS` is dropped; the
 *   pattern is cut to `OKF_PATTERN_MAX_CHARS` (Glob keeps none); at most `OKF_EVENT_CAP_PER_NODE`
 *   events, beyond it `truncated` (DD-5).
 * - Pointer rows: a call that reads exactly one stored `.md` key yields one row per pointer of its
 *   result text (`extractPointers`; none from an error result). `isNew` = not named in the node's
 *   earlier text (user text incl. prompt and system reminders, assistant text, tool_result text,
 *   in transcript order); `partial` per `isPartialResult`; `followed` = a later call of the node
 *   touched the pointer path or a path under it. A partial read with no pointers stores one row
 *   with `pointer: ''`; a call reading several `.md` keys stores only such a `''` partial row per
 *   article. At most `OKF_POINTER_CAP_PER_NODE` rows, beyond it `truncated` (DD-8..DD-10).
 * - `seq`: every access of every call in order (`kb_*` ops for KB articles, code paths filtered
 *   like events), with range, pattern and the new pointers of a single-article KB read, and `hit`
 *   (the DD-6 search-hit test of the call's result) on search items; uncapped.
 */
import { analyzeBash, type BashParser } from '@loghub/bash-view';
import {
  resolveRepoPath,
  truncateChangedPath,
} from '../change-surface/path-normalise';
import {
  OKF_EVENT_CAP_PER_NODE,
  OKF_EVENT_SKIP_SEGMENTS,
  OKF_PATH_MAX_CHARS,
  OKF_PATTERN_MAX_CHARS,
  OKF_POINTER_CAP_PER_NODE,
} from './okf-constants';
import { extractPointers, isNewPointer, isPartialResult } from './okf-pointers';

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
  /** `read` calls of this row that carried a line range (DD-3/DD-4); included in `calls`. */
  rangedCalls: number;
  /** Bytes of those ranged calls; included in `bytes`. */
  rangedBytes: number;
  /** `grep` / `list` calls of this row whose result was a hit (DD-6). */
  searchHits: number;
}

/** Size and content hash of one file of the root's bound OKF snapshot. */
export interface OkfSnapshotFileInfo {
  size: number | null;
  hash: string | null;
}

export interface ExtractOkfAccessOptions {
  /**
   * `true` for a `claude-subagent` log, whose every line is a sidechain line. In a root log,
   * `isSidechain` lines belong to a sub-agent and are skipped (same rule as harness usage).
   */
  isSubagentLog?: boolean;
  /**
   * Files of the root's bound snapshot, keyed by repo-relative path. Drives the size-proportional
   * byte split (DD-7); absent → the even split.
   */
  snapshotFiles?: ReadonlyMap<string, OkfSnapshotFileInfo>;
}

/** Result of one `tool_use` id (first result wins, DD-8). */
interface CallResult {
  bytes: number;
  text: string;
  isError: boolean;
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

/** Text of a tool_result: string content, or the concatenated `text` blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const item of content) {
    const b = asRecord(item);
    if (b === null || b['type'] !== 'text') continue;
    const text = asString(b['text']);
    if (text !== null) out += text;
  }
  return out;
}

/** DD-6: a grep / list result is a hit when it is no error and has a non-empty, non-"no match" body. */
function isSearchHit(result: CallResult | undefined): boolean {
  if (result === undefined || result.isError) return false;
  const body = result.text.trim();
  return (
    body !== '' && body !== 'No files found' && body !== 'No matches found'
  );
}

/** A finite, non-negative integer input value, else null. */
function asLineNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : null;
}

/** DD-4: the line range of a Read call's `offset` / `limit`, or null when it has neither. */
function readRange(input: AnyRecord): AccessRange | null {
  const offset = asLineNumber(input['offset']);
  const limit = asLineNumber(input['limit']);
  if (offset === null && limit === null) return null;
  const from = offset ?? 1;
  return { from, to: limit ? from + limit - 1 : null };
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
export function hasExtension(p: string): boolean {
  return /^.+\.[^.]+$/.test(lastSegment(p));
}

function folderKey(rel: string): string {
  return rel === '' ? '/' : `${rel}/`;
}

/** Static leading segments of a glob pattern (before the first segment with a glob char). */
export function globStaticPrefix(pattern: string): string {
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

/** A line range of a read: 1-based, `to` inclusive; `to: null` = to the end; negative `from` counts from the end. */
interface AccessRange {
  from: number;
  to: number | null;
}

/** One resolved access of a call, before aggregation. */
interface CallAccess {
  key: string;
  isFolder: boolean;
  op: OkfAccessOp;
  /** Read-side access: shares the call's result bytes (DD-2). */
  readSide: boolean;
  /** Line range of a ranged read (DD-4); null for a whole-file read and every other op. */
  range: AccessRange | null;
  /** Search pattern of a grep access (Grep `pattern`, Bash `BashReadAccess.pattern`); else null. */
  pattern: string | null;
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
    range: AccessRange | null = null,
    pattern: string | null = null,
  ): CallAccess[] =>
    rel === null || rel === ''
      ? []
      : [
          {
            key: rel,
            isFolder: false,
            op,
            readSide,
            range: op === 'read' ? range : null,
            pattern: op === 'grep' ? pattern : null,
          },
        ];
  const folder = (
    rel: string | null,
    op: OkfAccessOp,
    pattern: string | null = null,
  ): CallAccess[] =>
    rel === null
      ? []
      : [
          {
            key: folderKey(rel),
            isFolder: true,
            op,
            readSide: true,
            range: null,
            pattern: op === 'grep' ? pattern : null,
          },
        ];

  switch (name) {
    case 'Read':
      return file(
        resolve(asString(input['file_path']), cwd),
        'read',
        true,
        readRange(input),
      );
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
      const pattern = asString(input['pattern']);
      if (given !== null && !given.endsWith('/') && hasExtension(given)) {
        return file(rel, 'grep', true, null, pattern);
      }
      return folder(rel, 'grep', pattern);
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
        const named = !access.path.endsWith('/') && hasExtension(access.path);
        // FR-8: `ls a.md` lists one named file — no folder row and no access row.
        if (access.kind === 'list' && named) continue;
        const rel = resolve(access.path, analysis.workDir, cwd);
        if (access.kind === 'list') out.push(...folder(rel, 'list'));
        else if (access.kind === 'grep' && !named) {
          out.push(...folder(rel, 'grep', access.pattern ?? null));
        } else {
          out.push(
            ...file(
              rel,
              access.kind,
              true,
              access.range ?? null,
              access.pattern ?? null,
            ),
          );
        }
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
 * DD-7: splits a call's result bytes over its read-side accesses — in proportion to each target's
 * snapshot size (`Math.floor` per path, the remainder to the first), or evenly (remainder to the
 * first) when there is no snapshot map, any target has no known size (folders never do) or the
 * sizes sum to 0.
 */
function splitBytes(
  total: number,
  readSide: readonly CallAccess[],
  snapshotFiles: ReadonlyMap<string, OkfSnapshotFileInfo> | undefined,
): Map<CallAccess, number> {
  const out = new Map<CallAccess, number>();
  if (readSide.length === 0) return out;
  let sizes: number[] | null = null;
  if (snapshotFiles !== undefined) {
    sizes = [];
    for (const a of readSide) {
      const size = a.isFolder ? null : (snapshotFiles.get(a.key)?.size ?? null);
      if (size === null || !Number.isFinite(size) || size < 0) {
        sizes = null;
        break;
      }
      sizes.push(size);
    }
  }
  const sizeSum = sizes === null ? 0 : sizes.reduce((s, v) => s + v, 0);
  const shares =
    sizes !== null && sizeSum > 0
      ? sizes.map((size) => Math.floor((total * size) / sizeSum))
      : readSide.map(() => Math.floor(total / readSide.length));
  const remainder = total - shares.reduce((s, v) => s + v, 0);
  readSide.forEach((a, i) => out.set(a, shares[i] + (i === 0 ? remainder : 0)));
  return out;
}

/** Op of a code event (DD-5): read → `read`, grep / list → `search`, write → `write`. */
export type OkfEventOp = 'read' | 'search' | 'write';

/** One `session_okf_event` row of a node (without the node's session id) — DD-1a, DD-5. */
export interface OkfEventRow {
  /** Call ordinal of the node (DD-2). */
  ord: number;
  op: OkfEventOp;
  /** Repo-relative path; folders end in `/`, the repo root is `/`. */
  path: string;
  rangeFrom: number | null;
  rangeTo: number | null;
  /** Search pattern, cut to `OKF_PATTERN_MAX_CHARS`; null for reads, writes and Glob. */
  pattern: string | null;
}

/** One `session_okf_pointer` row of a node (without the node's session id) — DD-1a, DD-9, DD-10. */
export interface OkfPointerRow {
  articlePath: string;
  articleHash: string | null;
  /** Ordinal of the KB read call (DD-2). */
  readOrd: number;
  /** Repo-relative pointer; `''` marks a partial read with no pointers. */
  pointer: string;
  isNew: boolean;
  followed: boolean;
  partial: boolean;
}

/** Op of one ordered access of the facts sequence; `kb_*` = a KB article access. */
export type OkfSeqOp =
  | 'kb_read'
  | 'kb_search'
  | 'kb_write'
  | 'read'
  | 'search'
  | 'write';

/** One ordered access of a node, for the facts route (DD-1a). */
export interface OkfSeqItem {
  ord: number;
  op: OkfSeqOp;
  path: string;
  /** First line of a ranged read; negative counts from the end (`tail -n N`). */
  offset?: number;
  /** Line count of a ranged read with a known end. */
  limit?: number;
  pattern?: string;
  /** New pointers of a single-article KB read (DD-9). */
  newPointers?: string[];
  /**
   * Search items only (`kb_search` / `search`): the call's result was a hit — not an error and,
   * trimmed, neither empty nor `No files found` / `No matches found` (rule 11, read per request).
   */
  hit?: boolean;
}

/** Everything one node's transcript yields for OKF (DD-1). */
export interface OkfDetail {
  access: OkfAccessRow[];
  events: OkfEventRow[];
  pointers: OkfPointerRow[];
  seq: OkfSeqItem[];
  /** The event or pointer cap was hit (DD-5, DD-9). */
  truncated: boolean;
}

function eventOp(op: OkfAccessOp): OkfEventOp {
  if (op === 'grep' || op === 'list') return 'search';
  return op;
}

/** DD-5: a path with a skipped segment (`node_modules`, `.git`, `dist`, …). */
function hasSkipSegment(path: string): boolean {
  return path
    .split('/')
    .some((seg) => OKF_EVENT_SKIP_SEGMENTS.includes(seg.toLowerCase()));
}

/** A KB article access: an `.md` file of the snapshot (any `.md` file when there is none). */
function isKbArticle(
  access: CallAccess,
  snapshotFiles: ReadonlyMap<string, OkfSnapshotFileInfo> | undefined,
): boolean {
  if (access.isFolder || !access.key.toLowerCase().endsWith('.md')) {
    return false;
  }
  return snapshotFiles === undefined || snapshotFiles.has(access.key);
}

/** A code-side path kept for events and the sequence (DD-5). */
function isKeptCodePath(path: string): boolean {
  return path.length <= OKF_PATH_MAX_CHARS && !hasSkipSegment(path);
}

function cutPattern(pattern: string | null): string | null {
  return pattern === null ? null : pattern.slice(0, OKF_PATTERN_MAX_CHARS);
}

/** Text a user line adds to the node's prior text: its string, text blocks and tool_result texts. */
function userLineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const item of content) {
    const b = asRecord(item);
    if (b === null) continue;
    if (b['type'] === 'text') out += `${asString(b['text']) ?? ''}\n`;
    else if (b['type'] === 'tool_result') {
      out += `${toolResultText(b['content'])}\n`;
    }
  }
  return out;
}

/** Every folder prefix of a path plus the path itself (`a/b/c.ts` → `a`, `a/b`, `a/b/c.ts`). */
function pathAndAncestors(path: string): string[] {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return [];
  const segs = trimmed.split('/');
  const out: string[] = [];
  for (let i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join('/'));
  return out;
}

/**
 * Extracts everything OKF needs from one tree node's transcript lines (DD-1): the access rows, the
 * code events, the pointer rows of its KB reads and the ordered access sequence.
 *
 * `roots` are the session's candidate repo roots (as `writeSessionFileStats` receives them);
 * with none, nothing is extracted (FR-2). `parser` `null` skips Bash calls only (DD-10).
 */
export function extractOkfDetail(
  entries: readonly object[],
  roots: readonly (string | null | undefined)[],
  parser: BashParser | null,
  options: ExtractOkfAccessOptions = {},
): OkfDetail {
  const usableRoots = roots.filter(
    (r): r is string => typeof r === 'string' && r.trim() !== '',
  );
  if (usableRoots.length === 0) {
    return { access: [], events: [], pointers: [], seq: [], truncated: false };
  }
  const isSubagentLog = options.isSubagentLog === true;
  const snapshotFiles = options.snapshotFiles;

  const visible = entries.filter((line) => {
    const rec = line as AnyRecord;
    return isSubagentLog || rec['isSidechain'] !== true;
  });

  // Pass 1: result bytes, text and error flag per tool_use id (first result wins, DD-8).
  const results = new Map<string, CallResult>();
  for (const line of visible) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'user') continue;
    const content = asRecord(rec['message'])?.['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_result') continue;
      const id = asString(b['tool_use_id']);
      if (id === null || results.has(id)) continue;
      results.set(id, {
        bytes: toolResultBytes(b['content']),
        text: toolResultText(b['content']),
        isError: b['is_error'] === true,
      });
    }
  }

  // Pass 2: tool calls in transcript order.
  const rows = new Map<string, OkfAccessRow>();
  const seqByKey = new Map<string, number>();
  const ownWritten = new Set<string>();
  const seenIds = new Set<string>();
  const events: OkfEventRow[] = [];
  const pointers: OkfPointerRow[] = [];
  const seq: OkfSeqItem[] = [];
  /** Path (and every folder above it) → ordinal of the last call that touched it (DD-9 followed). */
  const lastTouch = new Map<string, number>();
  let truncated = false;
  let prior = '';
  let ord = 0;
  let cwd: string | null = null;

  for (const line of visible) {
    const rec = line as AnyRecord;
    const lineCwd = asString(rec['cwd']);
    if (lineCwd !== null && lineCwd !== '') cwd = lineCwd;
    const content = asRecord(rec['message'])?.['content'];
    if (rec['type'] === 'user') {
      prior += userLineText(content);
      continue;
    }
    if (rec['type'] !== 'assistant' || !Array.isArray(content)) continue;

    for (const block of content) {
      const b = asRecord(block);
      if (b === null) continue;
      if (b['type'] === 'text') {
        prior += `${asString(b['text']) ?? ''}\n`;
        continue;
      }
      if (b['type'] !== 'tool_use') continue;
      const id = asString(b['id']);
      if (id !== null) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      ord += 1;
      const name = asString(b['name']);
      const input = asRecord(b['input']);
      if (name === null || input === null) continue;

      const accesses = dedupeWithinCall(
        accessesOfCall(name, input, cwd, usableRoots, parser),
      );
      if (accesses.length === 0) continue;

      const result = id === null ? undefined : results.get(id);
      const total = result?.bytes ?? 0;
      const bytesOf = splitBytes(
        total,
        accesses.filter((a) => a.readSide),
        snapshotFiles,
      );
      const hit = isSearchHit(result);

      // Reads are judged against the writes of earlier calls (DD-7), then this call's writes count.
      for (const access of accesses) {
        if (!isStoredKey(access)) continue;
        const pathKey = truncateChangedPath(access.key);
        let rank = seqByKey.get(pathKey);
        if (rank === undefined) {
          rank = seqByKey.size + 1;
          seqByKey.set(pathKey, rank);
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
            seq: rank,
            rangedCalls: 0,
            rangedBytes: 0,
            searchHits: 0,
          };
          rows.set(rowId, row);
        }
        const bytes = bytesOf.get(access) ?? 0;
        row.bytes += bytes;
        row.calls += 1;
        if (access.op === 'read' && access.range !== null) {
          row.rangedCalls += 1;
          row.rangedBytes += bytes;
        }
        if ((access.op === 'grep' || access.op === 'list') && hit) {
          row.searchHits += 1;
        }
      }
      for (const access of accesses) {
        if (access.op === 'write')
          ownWritten.add(truncateChangedPath(access.key));
      }

      // Pointers of a KB read (DD-9, DD-10): single-article reads only.
      const kbReads = accesses.filter(
        (a) => a.op === 'read' && !a.isFolder && isStoredKey(a),
      );
      let newPointers: string[] | null = null;
      const pushPointer = (row: OkfPointerRow): void => {
        if (pointers.length >= OKF_POINTER_CAP_PER_NODE) truncated = true;
        else pointers.push(row);
      };
      if (kbReads.length === 1) {
        const articleKey = kbReads[0].key;
        const articlePath = truncateChangedPath(articleKey);
        const articleHash = snapshotFiles?.get(articleKey)?.hash ?? null;
        const text = result?.text ?? '';
        const isError = result?.isError ?? false;
        const partial = isPartialResult(text, isError);
        const found = isError ? [] : extractPointers(text, usableRoots);
        newPointers = [];
        for (const pointer of found) {
          const isNew = isNewPointer(pointer, prior);
          if (isNew) newPointers.push(pointer);
          pushPointer({
            articlePath,
            articleHash,
            readOrd: ord,
            pointer,
            isNew,
            followed: false,
            partial,
          });
        }
        if (found.length === 0 && partial) {
          pushPointer({
            articlePath,
            articleHash,
            readOrd: ord,
            pointer: '',
            isNew: false,
            followed: false,
            partial: true,
          });
        }
      } else if (kbReads.length > 1) {
        // A multi-file read stores no pointers; each article counts as one partial read.
        for (const a of kbReads) {
          pushPointer({
            articlePath: truncateChangedPath(a.key),
            articleHash: snapshotFiles?.get(a.key)?.hash ?? null,
            readOrd: ord,
            pointer: '',
            isNew: false,
            followed: false,
            partial: true,
          });
        }
      }

      // Code events (DD-5) and the ordered sequence (DD-1a).
      const eventIds = new Set<string>();
      for (const access of accesses) {
        const op = eventOp(access.op);
        const kb = isKbArticle(access, snapshotFiles);
        const pattern = cutPattern(access.pattern);
        const range = access.range;
        const keepCode = isKeptCodePath(access.key);
        // DD-5: every access except `.md` files of the snapshot (no snapshot → every access).
        const inSnapshotMd = snapshotFiles !== undefined && kb;
        if (!inSnapshotMd && keepCode) {
          const eventId = `${op}\0${access.key}`;
          if (!eventIds.has(eventId)) {
            eventIds.add(eventId);
            if (events.length >= OKF_EVENT_CAP_PER_NODE) truncated = true;
            else {
              events.push({
                ord,
                op,
                path: access.key,
                rangeFrom: range?.from ?? null,
                rangeTo: range?.to ?? null,
                pattern,
              });
            }
          }
        }
        if (kb || keepCode) {
          const item: OkfSeqItem = {
            ord,
            op: kb ? (`kb_${op}` as const) : op,
            path: kb ? truncateChangedPath(access.key) : access.key,
          };
          if (range !== null) {
            item.offset = range.from;
            if (range.to !== null) item.limit = range.to - range.from + 1;
          }
          if (pattern !== null) item.pattern = pattern;
          if (kb && access.op === 'read' && newPointers !== null) {
            item.newPointers = newPointers;
          }
          if (op === 'search') item.hit = hit;
          seq.push(item);
        }
      }

      // Followed (DD-9): remember the last call that touched each path or anything under it.
      for (const access of accesses) {
        for (const p of pathAndAncestors(access.key)) lastTouch.set(p, ord);
      }
    }
  }

  for (const row of pointers) {
    if (row.pointer === '') continue;
    const last = lastTouch.get(row.pointer);
    row.followed = last !== undefined && last > row.readOrd;
  }

  return { access: [...rows.values()], events, pointers, seq, truncated };
}

/**
 * Extracts the OKF access rows of one tree node from its transcript lines — the `access` part of
 * {@link extractOkfDetail}.
 */
export function extractOkfAccess(
  entries: readonly object[],
  roots: readonly (string | null | undefined)[],
  parser: BashParser | null,
  options: ExtractOkfAccessOptions = {},
): OkfAccessRow[] {
  return extractOkfDetail(entries, roots, parser, options).access;
}
