// Registry row format of the API <-> DB contract suite
// (docs/qaa-overview/scenarios/05 §2.4-2.7, lines 382-432).
//
// A registry row is DATA: who calls which route on which fixture, which independent SQL proves the
// answer, and how each response field maps onto a column. The comparison code is one shared
// function, `runCase` (run-case.ts).
//
// Placeholders, resolved by runCase:
//   - `@name.field` — a world-v1 value (`@owner.id`, `@R1.id`, `@s01.sessionId`, `@ownerKey.key`;
//     the full list is WORLD_V1_REFS in fixtures/world-v1.sql.ts). Allowed in `params`, `query`,
//     `body` (a string that is exactly one ref), `read.args`, and inside `where`/`check` SQL text.
//   - `$field` — a top-level field of the JSON response body, inside `where`/`check` SQL text of a
//     write row (`slug = left($key, 6)`). `$1`, `$2`, ... stay ordinary positional parameters.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `METHOD /path/:param` exactly as the Nest router declares it — the meta-test's key. */
export type RouteKey = `${HttpMethod} /${string}`;

/**
 * Who sends the request (05 §2.6). Cookie actors log in once per spec file with the world
 * password; key actors send `X-API-Key`; `anon` sends neither. `pending` cannot log in (its email
 * is unconfirmed), so it only ever appears in bodies/params, never as an actor.
 */
export type Actor =
  | 'admin'
  | 'owner'
  | 'member'
  | 'outsider'
  | 'author'
  | 'manager'
  | 'trainer'
  | 'ownerKey'
  | 'memberKey'
  | 'authorKey'
  | 'anon';

/** The deterministic data set a row runs on. Only one exists so far. */
export type FixtureName = 'world-v1';

/** A positional SQL argument: a literal, or a `@ref` resolved against the world. */
export type SqlArg = string | number | boolean | null;

/**
 * How one response field is derived from one SQL column (05 §2.4):
 *  - a bare string: the column name, compared after the default normalisation (Date -> ISO
 *    string; a numeric string from pg -> number when the response holds a number);
 *  - `as: 'iso'` / `'iso?'`: timestamp as an ISO string with `Z` and milliseconds (`?` = nullable);
 *  - `as: 'number'`: `Number(col)` (bigint / count come back from pg as strings);
 *  - `as: 'numeric'`: float compare with `|a - b| <= tol` (default 1e-8);
 *  - `as: 'json'`: deep equality, key order ignored;
 *  - `as: 'raw'`: no normalisation at all;
 *  - `undefinedIsNull`: a key missing from the response counts as `null`.
 */
export type FieldMap =
  | string
  | {
      col: string;
      as?: 'iso' | 'iso?' | 'number' | 'numeric' | 'json' | 'raw';
      tol?: number;
      undefinedIsNull?: boolean;
    };

/** Read contract: the response (or `path` inside it) equals what `sql` returns. */
export interface ReadSpec {
  sql: string;
  args?: SqlArg[];
  /**
   * `array`: response is an array, one element per SQL row; `object`: SQL returns exactly one row;
   * `map`: response is `{ [keyCol]: valueCol }` built from all rows.
   */
  shape: 'array' | 'object' | 'map';
  /** Dotted path of the compared value inside the response body (`entries`, `data.items`). */
  path?: string;
  /** Response field -> column. Not used by `map`. */
  fields?: Record<string, FieldMap>;
  /** `array` of plain values (`string[]`), not objects: every element equals this column. */
  scalar?: FieldMap;
  /** With `scalar`: the endpoint has no ORDER BY, compare both sides as sorted lists. */
  unordered?: boolean;
  /** `map` only: the key and value columns. */
  mapKey?: string;
  mapValue?: FieldMap;
  /**
   * `array` only. Absent: order matters (the SQL carries the same ORDER BY as the endpoint).
   * A field name: both sides are sorted by it before comparing.
   */
  sortBy?: string;
  /** The response object must have exactly the mapped keys (minus `ignore`) — catches leaked hashes. */
  strict?: boolean;
  /** Keys that are present but non-deterministic (`pingMs`, `uptime`): never compared. */
  ignore?: string[];
}

/** One expected inserted row group: rows matching `where` that did not exist before the call. */
export interface InsertedExpect {
  table: string;
  where: string;
  /** Default 1. */
  count?: number;
  /** Boolean SQL expressions over the inserted row; `argon2verify(col, $field)` is special-cased. */
  check?: string[];
}

/** Rows matching `where` (evaluated BEFORE the call) whose listed columns changed to `changed`. */
export interface UpdatedExpect {
  table: string;
  where: string;
  /** Column -> expected new value (`@ref` / `$field` strings are resolved). */
  changed: Record<string, unknown>;
  /** Columns that may change to any value (`updated_at`); every other column must stay put. */
  anyChange?: string[];
  /** Default 1. */
  count?: number;
}

/** Rows matching `where` (evaluated BEFORE the call) that must be gone afterwards. */
export interface DeletedExpect {
  table: string;
  where: string;
  /** Default 1; `'all'` = every matching row, however many. */
  count?: number | 'all';
}

/** Write contract (05 §2.5): snapshot `watch` before/after and compare the delta. */
export interface WriteSpec {
  watch: string[];
  delta: {
    inserted?: InsertedExpect[];
    updated?: UpdatedExpect[];
    deleted?: DeletedExpect[];
  };
  /** Every table outside `watch` (and `derived`) must be byte-for-byte unchanged (default true). */
  unchangedElse?: boolean;
  /**
   * Row identity for a watched table WITHOUT a primary key (`repo_config`, `session_file_stats`).
   * Without it a row is keyed by its whole content, so an UPDATE reads as delete + insert.
   */
  keys?: Record<string, string[]>;
  /**
   * Tables the call recomputes as a side effect (per-session stats after a settings change).
   * They may change; their contents are the algorithm tests' business, not this row's. Every
   * other table outside `watch` still has to stay unchanged.
   */
  derived?: string[];
  /**
   * Boolean SQL expressions evaluated once after the call (`@ref` / `$field` allowed), for a
   * changed value that cannot be spelled out upfront: a fresh hash, `now()` timestamps
   * (`(SELECT email_confirmed_at IS NOT NULL FROM users WHERE id = @pending.id)`).
   * Write `$` inside SQL string literals as `chr(36)`: `$word` is always a response field.
   */
  after?: string[];
}

export interface ExpectSpec {
  status: number;
  /** The compared value must hold at least this many rows (05 §2.4 "answer not empty"). */
  minRows?: number;
  /**
   * A partial body match: every listed top-level key must deep-equal its value. For fields the
   * oracle cannot see (error codes) and for hand-computed golden constants (05 §2.2).
   */
  bodyMatches?: Record<string, unknown>;
  /** The raw response body, byte for byte (a file download). */
  bodyText?: string;
}

/**
 * Wait for an asynchronous effect (a background job the call started) before the "after"
 * snapshot is taken: `until` is a boolean SQL expression (`@ref` / `$field` allowed), polled every
 * 50 ms until true or `timeoutMs` (default 10 s) runs out — then the row fails.
 */
export interface SettleSpec {
  until: string;
  timeoutMs?: number;
}

interface CaseBase {
  /** `F04-list`; unique across the registry. */
  id: string;
  route: RouteKey;
}

/**
 * A route that has no contract check by definition (05 §3: e.g. the Azure callback needs real
 * Microsoft). Counts as "covered" for the meta-test, but `reason` is mandatory.
 */
export interface ExcludedCase extends CaseBase {
  kind: 'excluded';
  reason: string;
}

/** A row that calls the route. Exactly one of `read` / `write` / `noDb` describes the oracle. */
export interface CallCase extends CaseBase {
  kind?: 'call';
  actor: Actor;
  fixture?: FixtureName;
  /** Values for the route's `:params` (`@ref` allowed). */
  params?: Record<string, SqlArg>;
  query?: Record<string, SqlArg | SqlArg[]>;
  body?: unknown;
  headers?: Record<string, string>;
  expect: ExpectSpec;
  read?: ReadSpec;
  write?: WriteSpec;
  /**
   * No DB contract (file/env/static endpoints, negative rows): the whole-schema checksum before
   * and after the call must be equal. Negative rows (status >= 400) get this check implicitly.
   */
  noDb?: true;
  /** A report twin that shares its expectation with another row (05 §F21); compared answer-to-answer. */
  sameExpectedAs?: string;
  /** Reload world-v1 before this row (write families: default true for `write` rows). */
  resetWorld?: boolean;
  /**
   * The row ends the caller's own session (logout, delete-account) or needs a session of its
   * own: the actor logs in afresh for this row and the agent is discarded afterwards, so later
   * rows of the same spec file get a new, valid session.
   */
  freshSession?: true;
  /** See `SettleSpec`. */
  settle?: SettleSpec;
}

export type ContractCase = ExcludedCase | CallCase;

/** One family file's export (`registry/f<NN>-<family>.ts`). */
export interface ContractFamily {
  /** `F04` */
  id: string;
  /** `api-keys` */
  name: string;
  cases: ContractCase[];
}
