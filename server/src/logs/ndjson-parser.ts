// Matches the U+0000 code point via a hex escape so no raw null byte
// lives in the source file.
// eslint-disable-next-line no-control-regex
const NULL_CHAR_RE = /\x00/g;

// PostgreSQL JSONB cannot store the U+0000 code point. Strip real null
// characters from decoded values (and object keys) AFTER parsing — never from
// the raw text, where a JSON-escaped null character mentioned in message
// content is a legitimate double-escaped string, not a null byte, and
// scrubbing it there corrupts the JSON.
//
// Used by the async upload-queue processor, the only ingest path since the v1
// upload route was removed (open-source readiness).
export function stripNullChars<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(NULL_CHAR_RE, '') as T;
  }
  if (Array.isArray(value)) {
    return value.map(stripNullChars) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key.replace(NULL_CHAR_RE, '')] = stripNullChars(
        (value as Record<string, unknown>)[key],
      );
    }
    return out as T;
  }
  return value;
}

/**
 * Parses a raw NDJSON body into an array of decoded, null-char-stripped
 * objects, one per non-blank line. Throws on the first malformed line, or if
 * the body contains no valid lines at all. The upload-queue scheduler surfaces
 * these messages as the queue row's `errorMessage` / hook warning text, so they
 * keep the wording the removed v1 route returned.
 */
export function parseNdjsonLines(rawBody: string): object[] {
  return parseNdjsonLinesTolerant(rawBody, 0).lines;
}

/** One line `parseNdjsonLinesTolerant()` skipped. `lineNo` is 1-based. */
export interface DroppedNdjsonLine {
  lineNo: number;
  chars: number;
  reason: string;
}

export interface TolerantNdjsonResult {
  lines: object[];
  dropped: DroppedNdjsonLine[];
  /** `rawBody.split('\n').length`, the "of M" in error messages. */
  totalLines: number;
}

/**
 * Default share of non-blank lines the upload-queue processor may drop as
 * malformed and still ingest the rest of the file.
 *
 * Hooks older than 2.15.0 upload a session `.jsonl` as-is, and on filesystems
 * without atomic cross-process appends (WSL `/mnt/<drive>`) concurrent hook
 * processes tear a few records per session — on dev that was 57 of 4,410
 * lines across 8 sessions, at most 1.6% of any one file. All-or-nothing
 * parsing threw those whole sessions away. Above this share the body is not a
 * lightly torn log but garbage, and it still fails as before.
 */
export const MAX_DROPPED_LINE_RATIO = 0.1;

/**
 * `parseNdjsonLines()` that skips up to `maxDroppedRatio` of the non-blank
 * lines instead of throwing on the first malformed one. The caller is
 * responsible for reporting `dropped`. Over the ratio it throws the strict
 * parser's error for the first malformed line, so a failed row's
 * `errorMessage` is unchanged.
 */
export function parseNdjsonLinesTolerant(
  rawBody: string,
  maxDroppedRatio: number = MAX_DROPPED_LINE_RATIO,
): TolerantNdjsonResult {
  const lines: object[] = [];
  const dropped: DroppedNdjsonLine[] = [];
  const rawLines = rawBody.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (!trimmed) continue;
    try {
      lines.push(stripNullChars(JSON.parse(trimmed) as object));
    } catch (err) {
      // V8 appends "(line 1 column N)" relative to the single parsed line,
      // which would contradict the file-level line number reported here.
      const reason = (err instanceof Error ? err.message : String(err)).replace(
        /\s*\(line \d+ column \d+\)$/,
        '',
      );
      dropped.push({ lineNo: i + 1, chars: trimmed.length, reason });
      if (maxDroppedRatio <= 0) break;
    }
  }

  const nonBlank = lines.length + dropped.length;
  if (dropped.length > 0 && dropped.length > nonBlank * maxDroppedRatio) {
    const first = dropped[0];
    // Keeps the v1 message as a prefix (hooks just display it) and appends
    // the 1-based line number and the parser's reason, so an admin can
    // locate the broken line in the downloaded staged file.
    throw new Error(
      `Malformed NDJSON: invalid JSON line ${first.lineNo} of ${rawLines.length} (${first.chars} chars): ${first.reason.slice(0, 300)}`,
    );
  }

  if (lines.length === 0) {
    throw new Error('Body contains no valid NDJSON lines');
  }

  return { lines, dropped, totalLines: rawLines.length };
}
