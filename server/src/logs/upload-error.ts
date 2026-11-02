/**
 * Classification of an upload-queue processing error (docs/knowledgebase/algorithms/upload-error-classify.md).
 *
 * The queue used to store `err.message` verbatim. For a database error that is Drizzle's
 * `Failed query: <the whole SQL>\nparams: <every bound value>` — kilobytes of SQL, the user's
 * local file paths, and still not the reason (the Postgres error sits in `err.cause`). This
 * module turns an error into:
 *
 * - `kind`: `transient` (worth another attempt: deadlock, serialization failure, lock timeout,
 *   lost connection), `server` (Log Hub could not process a good file) or `file` (the uploaded
 *   body itself is broken);
 * - `summary`: one short line safe to store and show to the uploader — no SQL, no parameters;
 * - `logDetail`: the Postgres fields (`code`, `detail`, `constraint`, `table`, `column`) for the
 *   server log, which is where the full picture belongs.
 */

export type UploadErrorKind = 'transient' | 'server' | 'file';

export interface UploadErrorClass {
  kind: UploadErrorKind;
  /** SQLSTATE of the underlying Postgres error, or the Node errno code (`ENOENT`, …). */
  code: string | null;
  summary: string;
  logDetail: string;
}

/** Longest stored / shown summary. */
export const SUMMARY_MAX_CHARS = 300;

/**
 * SQLSTATEs that a plain retry can clear: deadlock, serialization failure, lock not available,
 * the connection classes (08xxx) and an administrator / crash shutdown of the backend (57P0x).
 */
function isTransientCode(code: string): boolean {
  return (
    code === '40P01' ||
    code === '40001' ||
    code === '55P03' ||
    code.startsWith('08') ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03'
  );
}

interface PgLikeError {
  code: string;
  message: string;
  detail?: unknown;
  constraint?: unknown;
  table?: unknown;
  column?: unknown;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The first error in the `cause` chain that carries a SQLSTATE `code` (the `pg` driver's error). */
function findPgError(err: unknown): PgLikeError | null {
  let cur: unknown = err;
  for (
    let depth = 0;
    depth < 5 && cur !== null && typeof cur === 'object';
    depth++
  ) {
    const candidate = cur as Partial<PgLikeError> & { cause?: unknown };
    if (typeof candidate.code === 'string' && SQLSTATE.test(candidate.code)) {
      return {
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message : '',
        detail: candidate.detail,
        constraint: candidate.constraint,
        table: candidate.table,
        column: candidate.column,
      };
    }
    cur = candidate.cause;
  }
  return null;
}

/** First line, cut to {@link SUMMARY_MAX_CHARS}. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length > SUMMARY_MAX_CHARS
    ? `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : line;
}

/**
 * Shortens an already stored `error_message` for display. Rows written before this module
 * hold Drizzle's raw `Failed query: …\nparams: …` text; it becomes `database query failed`.
 */
export function shortenStoredErrorMessage(message: string | null): string {
  if (!message) return 'unknown error';
  if (message.startsWith('Failed query:')) return 'database query failed';
  return firstLine(message);
}

/** `true` for a stored message that is a server-side failure written before `error_kind` existed. */
export function isLegacyServerErrorMessage(message: string | null): boolean {
  return message?.startsWith('Failed query:') === true;
}

/**
 * The hook-facing warning for one `failed` queue row (`POST /api/v2/logs` → `warnings`; the
 * hook shows it as its `broken-upload-file` recommendation). A server-side failure says so —
 * the hook did nothing wrong and an admin can reprocess the file — instead of blaming the file.
 * Rows written before `error_kind` existed are judged by their stored message.
 */
export function formatFailedUploadWarning(
  fileName: string,
  errorMessage: string | null,
  errorKind: string | null,
): string {
  const short = shortenStoredErrorMessage(errorMessage);
  const serverSide =
    errorKind === 'server' ||
    (errorKind === null && isLegacyServerErrorMessage(errorMessage));
  return serverSide
    ? `Log Hub could not process upload ${fileName} (server-side error, not a hook problem; an admin can reprocess it in Admin › Upload Queue) — ${short}`
    : `Hook uploaded broken file: ${fileName} — ${short}`;
}

export function classifyUploadError(err: unknown): UploadErrorClass {
  const pg = findPgError(err);
  if (pg !== null) {
    const fields = (['detail', 'constraint', 'table', 'column'] as const)
      .filter((key) => typeof pg[key] === 'string' && pg[key] !== '')
      .map((key) => `${key}=${String(pg[key])}`);
    const pgMessage = firstLine(pg.message) || 'database error';
    const where =
      typeof pg.constraint === 'string' && pg.constraint
        ? ` (${pg.constraint})`
        : '';
    return {
      // A data exception (class 22) is the body's fault: a value the column cannot hold.
      kind: isTransientCode(pg.code)
        ? 'transient'
        : pg.code.startsWith('22')
          ? 'file'
          : 'server',
      code: pg.code,
      summary: firstLine(`database error ${pg.code}${where}: ${pgMessage}`),
      logDetail: [`code=${pg.code}`, ...fields].join(' '),
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  const errno =
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
      ? (err as NodeJS.ErrnoException).code!
      : null;
  if (errno !== null) {
    // File-system / network errors of the server (missing staged file, disk, socket).
    return {
      kind: 'server',
      code: errno,
      summary: firstLine(message),
      logDetail: `code=${errno}`,
    };
  }
  if (message.startsWith('Failed query:')) {
    // A Drizzle wrapper whose cause carried no SQLSTATE: still a server-side failure.
    return {
      kind: 'server',
      code: null,
      summary: 'database query failed',
      logDetail: '',
    };
  }
  return {
    kind: 'file',
    code: null,
    summary: firstLine(message),
    logDetail: '',
  };
}
