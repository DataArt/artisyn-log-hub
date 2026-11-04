/**
 * Pure helpers of the session logs delta (`GET …/sessions/:sessionId/logs/delta`, session-map
 * DD-4..6): the opaque cursor codec, the row classification and the growth check. No DB access
 * here — {@link SessionLogsDeltaService} runs the SQL around them.
 *
 * Cursor v1 = `base64url(JSON.stringify({ v: 1, r: [[sid, t, ut, n, fp], …] }))`, one entry per
 * `(session, log_type)` row the client already holds:
 * - `sid` — internal `sessions.id`, base 36;
 * - `t`   — log type code: `a` artisyn, `c` claude, `s` claude-subagent;
 * - `ut`  — `logs.updated_at` as epoch microseconds, base 36 (compared for equality only);
 * - `n`   — line count of the body the client holds;
 * - `fp`  — fingerprint of line `n-1`: `left(md5((body -> (n-1))::text), 12)`, `''` when `n = 0`.
 */

/** Longest cursor accepted / issued (keeps the URL well under Node's 16 KB header limit). */
export const DELTA_CURSOR_MAX_CHARS = 12_000;

/** Current cursor version. */
export const DELTA_CURSOR_VERSION = 1;

/** Log type code in the cursor. */
export type DeltaLogTypeCode = 'a' | 'c' | 's';

/** The `logs.log_type` values the delta reads, by cursor code. */
export const DELTA_LOG_TYPES: Readonly<Record<DeltaLogTypeCode, string>> = {
  a: 'artisyn',
  c: 'claude',
  s: 'claude-subagent',
};

/** Length of the fingerprint (`left(md5(...), 12)`). */
export const DELTA_FINGERPRINT_CHARS = 12;

/** One decoded cursor entry. */
export interface DeltaCursorRow {
  /** Internal `sessions.id`. */
  sid: number;
  t: DeltaLogTypeCode;
  /** `logs.updated_at` epoch µs in base 36. */
  ut: string;
  /** Line count the client holds. */
  n: number;
  /** Fingerprint of line `n-1`, `''` when `n = 0`. */
  fp: string;
}

/** Metadata of one current tree row (never its body). */
export interface DeltaCurrentRow {
  sid: number;
  t: DeltaLogTypeCode;
  /** `logs.updated_at` epoch µs in base 36. */
  ut: string;
}

/** A current row together with what the cursor says the client holds for it. */
export interface DeltaKnownRow {
  current: DeltaCurrentRow;
  prev: DeltaCursorRow;
}

/** {@link classifyDeltaRows} result: every row in exactly one bucket. */
export interface DeltaClassification {
  /** Same `ut` as in the cursor — body not read. */
  unchanged: DeltaKnownRow[];
  /** Different `ut` — read the slice after `prev.n` and check the fingerprint. */
  changed: DeltaKnownRow[];
  /** In the tree, not in the cursor — read in full. */
  new: DeltaCurrentRow[];
  /** In the cursor but its session left the tree, or its row is gone — answer `reload`. */
  stale: DeltaCursorRow[];
}

/** {@link checkGrowth} verdict: `append` = return `body[prevN:]`, `stale` = answer `reload`. */
export type DeltaGrowth = 'append' | 'stale';

const BASE36_RE = /^[0-9a-z]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const FP_RE = /^[0-9a-f]*$/;

/** Epoch microseconds (as SQL returns a bigint: a decimal string or a number) → base 36. */
export function microsToUt(micros: string | number | bigint): string {
  return BigInt(micros).toString(36);
}

function rowKey(sid: number, t: DeltaLogTypeCode): string {
  return `${sid}:${t}`;
}

function isTypeCode(value: unknown): value is DeltaLogTypeCode {
  return value === 'a' || value === 'c' || value === 's';
}

function decodeRow(raw: unknown): DeltaCursorRow | null {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  const [sid, t, ut, n, fp] = raw as unknown[];
  if (typeof sid !== 'string' || !BASE36_RE.test(sid)) return null;
  if (!isTypeCode(t)) return null;
  if (typeof ut !== 'string' || !BASE36_RE.test(ut)) return null;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null;
  if (
    typeof fp !== 'string' ||
    fp.length > DELTA_FINGERPRINT_CHARS ||
    !FP_RE.test(fp) ||
    (n === 0) !== (fp === '')
  ) {
    return null;
  }
  const sidNum = parseInt(sid, 36);
  if (!Number.isSafeInteger(sidNum)) return null;
  return { sid: sidNum, t, ut, n, fp };
}

/**
 * Decodes a cursor. A missing, malformed (bad base64url / JSON / any bad entry), unknown-version
 * or oversized (> {@link DELTA_CURSOR_MAX_CHARS}) cursor is an EMPTY cursor — the caller then
 * answers with a full snapshot; it never fails the request.
 */
export function decodeDeltaCursor(
  raw: string | null | undefined,
): DeltaCursorRow[] {
  if (typeof raw !== 'string' || raw === '') return [];
  if (raw.length > DELTA_CURSOR_MAX_CHARS || !BASE64URL_RE.test(raw)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const { v, r } = parsed as { v?: unknown; r?: unknown };
  if (v !== DELTA_CURSOR_VERSION || !Array.isArray(r)) return [];
  const rows: DeltaCursorRow[] = [];
  for (const entry of r) {
    const row = decodeRow(entry);
    if (row === null) return [];
    rows.push(row);
  }
  return rows;
}

/**
 * Encodes the next cursor; `''` when it would be longer than {@link DELTA_CURSOR_MAX_CHARS}
 * (the client then sends no cursor and the next poll is a full snapshot).
 */
export function encodeDeltaCursor(rows: readonly DeltaCursorRow[]): string {
  const payload = {
    v: DELTA_CURSOR_VERSION,
    r: rows.map((row) => [row.sid.toString(36), row.t, row.ut, row.n, row.fp]),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  return encoded.length > DELTA_CURSOR_MAX_CHARS ? '' : encoded;
}

/**
 * Sorts the cursor entries against the current tree rows (metadata only). Only `changed` and
 * `new` rows ever have their body read, so a poll where nothing moved reads no `logs.body`.
 */
export function classifyDeltaRows(
  cursorRows: readonly DeltaCursorRow[],
  currentRows: readonly DeltaCurrentRow[],
  treeSessionIds: ReadonlySet<number> | readonly number[],
): DeltaClassification {
  const inTree =
    treeSessionIds instanceof Set
      ? (treeSessionIds as ReadonlySet<number>)
      : new Set(treeSessionIds as readonly number[]);
  const currentByKey = new Map<string, DeltaCurrentRow>();
  for (const row of currentRows) currentByKey.set(rowKey(row.sid, row.t), row);

  const result: DeltaClassification = {
    unchanged: [],
    changed: [],
    new: [],
    stale: [],
  };
  const known = new Set<string>();
  for (const prev of cursorRows) {
    const key = rowKey(prev.sid, prev.t);
    if (known.has(key)) continue; // a duplicated entry counts once
    known.add(key);
    const current = currentByKey.get(key);
    if (!inTree.has(prev.sid) || current === undefined) {
      result.stale.push(prev);
    } else if (current.ut === prev.ut) {
      result.unchanged.push({ current, prev });
    } else {
      result.changed.push({ current, prev });
    }
  }
  for (const row of currentRows) {
    if (!known.has(rowKey(row.sid, row.t))) result.new.push(row);
  }
  return result;
}

/**
 * After reading a changed row: the body may only have grown. Shorter than the client's copy,
 * or a different line at the client's last position, means it was rewritten → `stale`.
 * Otherwise the client appends `body[prevN:]` (possibly nothing).
 */
export function checkGrowth(
  prevN: number,
  prevFp: string,
  newLen: number,
  fpAtPrevN: string,
): DeltaGrowth {
  if (newLen < prevN) return 'stale';
  if (fpAtPrevN !== prevFp) return 'stale';
  return 'append';
}
