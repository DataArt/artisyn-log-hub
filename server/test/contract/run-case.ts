// `runCase`: the one comparison routine every contract family shares
// (docs/qaa-overview/scenarios/05 §2.4-2.7). A family spec is just
//
//   it.each(callable(casesOf('F04')))('$id', (c) => runCase(c, ctx));
//
// For one registry row it: reloads world-v1 when the row writes; snapshots the DB; calls the route
// on the shared app (CONTRACT_BASE_URL) as the row's actor; checks the status; then proves the
// answer with the row's independent SQL (read), the snapshot delta (write) or an unchanged schema
// (noDb and every negative row). All mismatches of a row are reported together, with its id,
// route and a response-vs-SQL diff.
//
// No imports from src/**.
import { isDeepStrictEqual, inspect } from 'util';
import * as argon2 from 'argon2';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import {
  WORLD_V1,
  WORLD_V1_PASSWORD,
  WORLD_V1_REFS,
  resetWorldV1,
} from './fixtures/world-v1.sql';
import {
  changedTables,
  contractSchema,
  ident,
  inOracleTransaction,
  primaryKeyColumns,
  q,
  schemaChecksum,
  schemaTables,
  tableRows,
} from './oracle';
import { findCallCase } from './registry';
import type {
  Actor,
  CallCase,
  ContractCase,
  FieldMap,
  ReadSpec,
  SettleSpec,
  SqlArg,
  WriteSpec,
} from './types';

type Json = unknown;
type Row = Record<string, unknown>;

/** Base URL of the app booted by test/contract/setup/global-setup.ts. */
export function contractBaseUrl(): string {
  const url = process.env.CONTRACT_BASE_URL;
  if (!url) {
    throw new Error(
      'CONTRACT_BASE_URL is not set — run the suite with `npm run test:contract` (from server/).',
    );
  }
  return url;
}

// -------------------------------------------------------------------------------------------
// Actors

const COOKIE_ACTORS: Partial<Record<Actor, string>> = {
  admin: WORLD_V1.users.admin.email,
  owner: WORLD_V1.users.owner.email,
  member: WORLD_V1.users.member.email,
  outsider: WORLD_V1.users.outsider.email,
  author: WORLD_V1.users.author.email,
  manager: WORLD_V1.users.manager.email,
};

const KEY_ACTORS: Partial<Record<Actor, string>> = {
  ownerKey: WORLD_V1.apiKeys.ownerKey.key,
  memberKey: WORLD_V1.apiKeys.memberKey.key,
  authorKey: WORLD_V1.apiKeys.authorKey.key,
};

/**
 * Per-spec-file state: one logged-in supertest agent per cookie actor, created on first use with
 * a REAL `POST /api/v1/auth/login` (05 §2.3), never a forged `auth_sessions` row.
 */
export class ContractContext {
  private readonly agents = new Map<Actor, TestAgent>();
  /**
   * Set after a write row: the world no longer is world-v1 (a promoted role, a deleted user), so
   * the next row reloads it first, whatever kind of row it is. Starts out `true`: the spec file
   * that ran before this one may have ended on a write row.
   */
  worldDirty = true;

  constructor(readonly baseUrl: string = contractBaseUrl()) {}

  async agentFor(actor: Actor): Promise<TestAgent> {
    const cached = this.agents.get(actor);
    if (cached) return cached;
    const agent = request.agent(this.baseUrl);
    const email = COOKIE_ACTORS[actor];
    if (email) {
      const res = await agent
        .post('/api/v1/auth/login')
        .send({ email, password: WORLD_V1_PASSWORD });
      if (res.status !== 200) {
        throw new Error(
          `Contract login as ${actor} (${email}) returned ${res.status}: ${res.text}`,
        );
      }
    }
    this.agents.set(actor, agent);
    return agent;
  }

  apiKeyFor(actor: Actor): string | undefined {
    return KEY_ACTORS[actor];
  }

  /** Forgets the actor's agent; the next `agentFor` logs in again. */
  drop(actor: Actor): void {
    this.agents.delete(actor);
  }
}

// -------------------------------------------------------------------------------------------
// Placeholders

const FULL_REF = /^@([A-Za-z][\w]*(?:\.[\w]+)?)$/;

/** Resolves `@ref` strings (deeply) against world-v1. */
export function resolveRefs(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = FULL_REF.exec(value);
    if (!m) return value;
    if (!(m[1] in WORLD_V1_REFS)) {
      throw new Error(
        `Unknown world-v1 reference "${value}" (see WORLD_V1_REFS)`,
      );
    }
    return WORLD_V1_REFS[m[1]];
  }
  if (Array.isArray(value)) return value.map(resolveRefs);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveRefs(v)]),
    );
  }
  return value;
}

const SQL_TOKEN = /@([A-Za-z][\w]*(?:\.[\w]+)?)|\$([A-Za-z_]\w*)/g;

/**
 * Turns `@ref` and `$field` tokens inside SQL text into positional parameters, numbered after
 * `firstIndex - 1` existing ones. `@x.y` that is not a world ref (an email literal) is left as is.
 */
export function compileSql(
  text: string,
  response: Json,
  firstIndex = 1,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const sql = text.replace(
    SQL_TOKEN,
    (whole, ref: string | undefined, field: string | undefined) => {
      if (ref !== undefined) {
        if (!(ref in WORLD_V1_REFS)) return whole;
        params.push(WORLD_V1_REFS[ref]);
      } else if (field !== undefined) {
        if (
          response === null ||
          typeof response !== 'object' ||
          !(field in response)
        ) {
          throw new Error(
            `SQL references $${field}, but the response has no such field`,
          );
        }
        const v = (response as Record<string, unknown>)[field];
        params.push(
          v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
        );
      }
      return `$${firstIndex + params.length - 1}`;
    },
  );
  return { sql, params };
}

function routePath(c: CallCase): { method: string; path: string } {
  const space = c.route.indexOf(' ');
  const method = c.route.slice(0, space);
  const template = c.route.slice(space + 1);
  const params = (resolveRefs(c.params ?? {}) ?? {}) as Record<string, unknown>;
  const path = template.replace(/:([A-Za-z_]\w*)/g, (_m, name: string) => {
    if (!(name in params)) {
      throw new Error(
        `[${c.id}] route parameter :${name} has no value in "params"`,
      );
    }
    return encodeURIComponent(String(params[name]));
  });
  return { method, path };
}

// -------------------------------------------------------------------------------------------
// Calling the route

interface CallResult {
  status: number;
  body: Json;
  text: string;
}

async function callRoute(
  c: CallCase,
  ctx: ContractContext,
): Promise<CallResult> {
  const { method, path } = routePath(c);
  const agent = await ctx.agentFor(c.actor);
  let req: request.Test;
  switch (method) {
    case 'GET':
      req = agent.get(path);
      break;
    case 'POST':
      req = agent.post(path);
      break;
    case 'PUT':
      req = agent.put(path);
      break;
    case 'PATCH':
      req = agent.patch(path);
      break;
    case 'DELETE':
      req = agent.delete(path);
      break;
    default:
      throw new Error(`[${c.id}] unsupported method ${method}`);
  }
  if (c.query) req = req.query(resolveRefs(c.query) as Record<string, unknown>);
  const key = ctx.apiKeyFor(c.actor);
  if (key) req = req.set('X-API-Key', key);
  for (const [name, value] of Object.entries(c.headers ?? {}))
    req = req.set(name, value);
  if (c.body !== undefined) {
    const body = resolveRefs(c.body);
    req = req.send(typeof body === 'string' ? body : (body as object));
  }
  if (c.expect.bodyText !== undefined) {
    // A file download: buffer whatever the content type is, as text.
    req = req.buffer(true).parse((stream, done) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () =>
        done(null, Buffer.concat(chunks).toString('utf8')),
      );
    });
  }
  const res = await req;
  const raw: unknown = res.body;
  const text =
    typeof raw === 'string' && c.expect.bodyText !== undefined
      ? raw
      : (res.text ?? '');
  return { status: res.status, body: raw, text };
}

/** Polls `settle.until` (a boolean SQL expression) until it holds (05 §2.2 "waitFor"). */
async function waitSettled(
  settle: SettleSpec,
  body: Json,
  failures: string[],
): Promise<void> {
  const compiled = compileSql(settle.until, body);
  const deadline = Date.now() + (settle.timeoutMs ?? 10_000);
  for (;;) {
    const rows = await q<{ ok: boolean | null }>(
      `SELECT (${compiled.sql}) AS ok`,
      compiled.params,
    );
    if (rows[0]?.ok === true) return;
    if (Date.now() > deadline) {
      failures.push(`settle: "${settle.until}" never became true`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// -------------------------------------------------------------------------------------------
// Value comparison (05 §2.4)

function normalizeFieldMap(fm: FieldMap): Exclude<FieldMap, string> {
  return typeof fm === 'string' ? { col: fm } : fm;
}

function toIso(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (!(v instanceof Date) && typeof v !== 'string' && typeof v !== 'number')
    return v;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/** The expected value of one field, from the SQL row, normalised for comparison. */
function expectedValue(
  fm: Exclude<FieldMap, string>,
  row: Row,
  actual: unknown,
): unknown {
  if (!(fm.col in row)) {
    throw new Error(`the oracle SQL returned no column "${fm.col}"`);
  }
  const v = row[fm.col];
  switch (fm.as) {
    case 'iso':
    case 'iso?':
      return toIso(v);
    case 'number':
    case 'numeric':
      return v === null ? null : Number(v);
    case 'json':
    case 'raw':
      return v;
    default:
      if (v instanceof Date) return v.toISOString();
      if (
        typeof actual === 'number' &&
        typeof v === 'string' &&
        v.trim() !== '' &&
        !Number.isNaN(Number(v))
      ) {
        return Number(v);
      }
      return v;
  }
}

function actualValue(
  fm: Exclude<FieldMap, string>,
  item: Row,
  key: string,
): unknown {
  const v = item[key];
  if (v === undefined && fm.undefinedIsNull) return null;
  return v;
}

function valuesEqual(
  fm: Exclude<FieldMap, string>,
  expected: unknown,
  actual: unknown,
): boolean {
  if (
    fm.as === 'numeric' &&
    typeof expected === 'number' &&
    typeof actual === 'number'
  ) {
    return Math.abs(expected - actual) <= (fm.tol ?? 1e-8);
  }
  if (fm.as === 'iso?' && expected === null) return actual === null;
  return isDeepStrictEqual(expected, actual);
}

function getPath(value: Json, path: string | undefined): Json {
  if (!path) return value;
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function show(v: unknown): string {
  return inspect(v, { depth: 6, breakLength: 120 });
}

function compareObject(
  read: ReadSpec,
  row: Row,
  item: unknown,
  label: string,
  failures: string[],
): void {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    failures.push(`${label}: expected an object, got ${show(item)}`);
    return;
  }
  const obj = item as Row;
  const fields = read.fields ?? {};
  for (const [key, raw] of Object.entries(fields)) {
    const fm = normalizeFieldMap(raw);
    const act = actualValue(fm, obj, key);
    let exp: unknown;
    try {
      exp = expectedValue(fm, row, act);
    } catch (err) {
      failures.push(`${label}.${key}: ${(err as Error).message}`);
      continue;
    }
    if (!valuesEqual(fm, exp, act)) {
      failures.push(
        `${label}.${key}: response ${show(act)} != SQL ${fm.col} ${show(exp)}`,
      );
    }
  }
  if (read.strict) {
    const allowed = new Set([...Object.keys(fields), ...(read.ignore ?? [])]);
    const extra = Object.keys(obj).filter((k) => !allowed.has(k));
    if (extra.length)
      failures.push(`${label}: unexpected keys ${extra.join(', ')} (strict)`);
  }
}

async function checkRead(
  c: CallCase,
  read: ReadSpec,
  body: Json,
  failures: string[],
): Promise<void> {
  const args = (read.args ?? []).map((a) => resolveRefs(a) as SqlArg);
  const rows = await q<Row>(read.sql, args);
  const actual = getPath(body, read.path);
  const minRows = c.expect.minRows;
  if (minRows !== undefined && rows.length < minRows) {
    failures.push(
      `oracle returned ${rows.length} row(s), the row demands minRows ${minRows} — the fixture does not exercise this route`,
    );
  }

  if (read.shape === 'object') {
    if (rows.length !== 1) {
      failures.push(
        `shape "object" needs exactly one SQL row, got ${rows.length}`,
      );
      return;
    }
    compareObject(read, rows[0], actual, 'response', failures);
    return;
  }

  if (read.shape === 'map') {
    if (!read.mapKey || !read.mapValue) {
      failures.push('shape "map" needs mapKey and mapValue');
      return;
    }
    if (
      actual === null ||
      typeof actual !== 'object' ||
      Array.isArray(actual)
    ) {
      failures.push(`expected a map object, got ${show(actual)}`);
      return;
    }
    const act = actual as Row;
    const fm = normalizeFieldMap(read.mapValue);
    const expectedKeys = rows.map((r) => String(r[read.mapKey as string]));
    const missing = expectedKeys.filter((k) => !(k in act));
    const extra = Object.keys(act).filter((k) => !expectedKeys.includes(k));
    if (missing.length)
      failures.push(
        `map: keys missing from the response: ${missing.join(', ')}`,
      );
    if (extra.length)
      failures.push(`map: keys the SQL does not return: ${extra.join(', ')}`);
    for (const r of rows) {
      const k = String(r[read.mapKey]);
      if (!(k in act)) continue;
      const exp = expectedValue(fm, r, act[k]);
      if (!valuesEqual(fm, exp, act[k]))
        failures.push(
          `map[${k}]: response ${show(act[k])} != SQL ${show(exp)}`,
        );
    }
    return;
  }

  // array
  if (!Array.isArray(actual)) {
    failures.push(
      `expected an array${read.path ? ` at "${read.path}"` : ''}, got ${show(actual)}`,
    );
    return;
  }
  if (actual.length !== rows.length) {
    failures.push(
      `response has ${actual.length} element(s), the SQL ${rows.length}`,
    );
  }
  if (read.scalar !== undefined) {
    const fm = normalizeFieldMap(read.scalar);
    const expected = rows.map((r, i) => expectedValue(fm, r, actual[i]));
    const byText = (a: unknown, b: unknown) => show(a).localeCompare(show(b));
    const got = read.unordered ? [...actual].sort(byText) : actual;
    const want = read.unordered ? [...expected].sort(byText) : expected;
    const n = Math.min(got.length, want.length);
    for (let i = 0; i < n; i += 1) {
      if (!valuesEqual(fm, want[i], got[i]))
        failures.push(
          `[${i}]: response ${show(got[i])} != SQL ${show(want[i])}`,
        );
    }
    return;
  }
  let items: unknown[] = actual;
  let expectedRows = rows;
  if (read.sortBy) {
    const by = read.sortBy;
    const fm = normalizeFieldMap(read.fields?.[by] ?? by);
    const keyOf = (v: unknown) => show(v);
    items = [...actual].sort((a, b) =>
      keyOf((a as Row)?.[by]).localeCompare(keyOf((b as Row)?.[by])),
    );
    expectedRows = [...rows].sort((a, b) =>
      keyOf(expectedValue(fm, a, undefined)).localeCompare(
        keyOf(expectedValue(fm, b, undefined)),
      ),
    );
  }
  const n = Math.min(items.length, expectedRows.length);
  for (let i = 0; i < n; i += 1)
    compareObject(read, expectedRows[i], items[i], `[${i}]`, failures);
}

// -------------------------------------------------------------------------------------------
// Write delta (05 §2.5)

interface TableState {
  pk: string[];
  rows: Map<string, Row>;
}

function rowKey(pk: string[], row: Row): string {
  return pk.length
    ? JSON.stringify(pk.map((col) => row[col]))
    : JSON.stringify(row);
}

async function snapshotTable(
  table: string,
  keys?: string[],
): Promise<TableState> {
  const pk = keys ?? (await primaryKeyColumns(table));
  const rows = await tableRows(table);
  return { pk, rows: new Map(rows.map((r) => [rowKey(pk, r), r])) };
}

/** Rows of `table` matching `where`, keyed like the snapshots; `check` adds a boolean `ok` column. */
async function selectKeys(
  table: string,
  where: string,
  pk: string[],
  response: Json,
  check?: string,
): Promise<{ key: string; row: Row; ok: boolean }[]> {
  const compiled = compileSql(
    check === undefined ? where : `(${check}) ;; ${where}`,
    response,
  );
  const [okSql, whereSql] =
    check === undefined ? ['true', compiled.sql] : compiled.sql.split(' ;; ');
  const res = await q<{ r: Row; ok: boolean | null }>(
    `SELECT to_jsonb(t) AS r, (${okSql}) AS ok FROM ${ident(table)} t WHERE ${whereSql}`,
    compiled.params,
  );
  return res.map((x) => ({
    key: rowKey(pk, x.r),
    row: x.r,
    ok: x.ok === true,
  }));
}

interface PreparedWrite {
  watch: Map<string, TableState>;
  updatedKeys: Map<number, string[]>;
  deletedKeys: Map<number, string[]>;
}

async function prepareWrite(
  write: WriteSpec,
  failures: string[],
): Promise<PreparedWrite> {
  const watch = new Map<string, TableState>();
  for (const t of write.watch)
    watch.set(t, await snapshotTable(t, write.keys?.[t]));
  const updatedKeys = new Map<number, string[]>();
  const deletedKeys = new Map<number, string[]>();
  const pkOf = (t: string) => watch.get(t)?.pk ?? [];
  for (const [i, u] of (write.delta.updated ?? []).entries()) {
    if (!watch.has(u.table))
      failures.push(`updated.${u.table} is not in "watch"`);
    updatedKeys.set(
      i,
      (await selectKeys(u.table, u.where, pkOf(u.table), null)).map(
        (x) => x.key,
      ),
    );
  }
  for (const [i, d] of (write.delta.deleted ?? []).entries()) {
    if (!watch.has(d.table))
      failures.push(`deleted.${d.table} is not in "watch"`);
    deletedKeys.set(
      i,
      (await selectKeys(d.table, d.where, pkOf(d.table), null)).map(
        (x) => x.key,
      ),
    );
  }
  return { watch, updatedKeys, deletedKeys };
}

const ARGON2_CHECK = /^argon2verify\(\s*(\w+)\s*,\s*\$(\w+)\s*\)$/;

async function checkWrite(
  write: WriteSpec,
  prep: PreparedWrite,
  body: Json,
  failures: string[],
): Promise<void> {
  const accounted = new Map<string, Set<string>>();
  const account = (t: string, key: string) => {
    if (!accounted.has(t)) accounted.set(t, new Set());
    accounted.get(t)?.add(key);
  };
  const after = new Map<string, TableState>();
  for (const t of write.watch)
    after.set(t, await snapshotTable(t, write.keys?.[t]));

  for (const ins of write.delta.inserted ?? []) {
    const before = prep.watch.get(ins.table);
    if (!before) {
      failures.push(`inserted.${ins.table} is not in "watch"`);
      continue;
    }
    const matched = (
      await selectKeys(ins.table, ins.where, before.pk, body)
    ).filter((x) => !before.rows.has(x.key));
    const want = ins.count ?? 1;
    if (matched.length !== want) {
      failures.push(
        `inserted ${ins.table} WHERE ${ins.where}: ${matched.length} new row(s), expected ${want}`,
      );
    }
    for (const m of matched) account(ins.table, m.key);
    const newKeys = new Set(matched.map((m) => m.key));
    for (const check of ins.check ?? []) {
      const argon = ARGON2_CHECK.exec(check);
      if (argon) {
        const plain = (body as Record<string, unknown> | null)?.[argon[2]];
        for (const m of matched) {
          const hash = m.row[argon[1]];
          const ok =
            typeof hash === 'string' &&
            typeof plain === 'string' &&
            (await argon2.verify(hash, plain));
          if (!ok) failures.push(`inserted ${ins.table}: ${check} is false`);
        }
        continue;
      }
      const evaluated = await selectKeys(
        ins.table,
        ins.where,
        before.pk,
        body,
        check,
      );
      for (const e of evaluated) {
        if (newKeys.has(e.key) && !e.ok)
          failures.push(`inserted ${ins.table}: check "${check}" is false`);
      }
    }
  }

  for (const [i, upd] of (write.delta.updated ?? []).entries()) {
    const before = prep.watch.get(upd.table);
    const now = after.get(upd.table);
    if (!before || !now) continue;
    const keys = prep.updatedKeys.get(i) ?? [];
    const want = upd.count ?? 1;
    if (keys.length !== want)
      failures.push(
        `updated ${upd.table} WHERE ${upd.where}: matched ${keys.length} row(s) before the call, expected ${want}`,
      );
    const changed = resolveRefs(upd.changed) as Row;
    for (const key of keys) {
      account(upd.table, key);
      const old = before.rows.get(key);
      const cur = now.rows.get(key);
      if (!old || !cur) {
        failures.push(`updated ${upd.table} ${key}: the row disappeared`);
        continue;
      }
      for (const col of Object.keys({ ...old, ...cur })) {
        if (col in changed) {
          if (!isDeepStrictEqual(cur[col], changed[col])) {
            failures.push(
              `updated ${upd.table} ${key}.${col}: now ${show(cur[col])}, expected ${show(changed[col])}`,
            );
          }
        } else if (
          !(upd.anyChange ?? []).includes(col) &&
          !isDeepStrictEqual(old[col], cur[col])
        ) {
          failures.push(
            `updated ${upd.table} ${key}.${col}: changed ${show(old[col])} -> ${show(cur[col])} but is not listed in "changed"`,
          );
        }
      }
    }
  }

  for (const [i, del] of (write.delta.deleted ?? []).entries()) {
    const now = after.get(del.table);
    if (!now) continue;
    const keys = prep.deletedKeys.get(i) ?? [];
    if (del.count !== 'all' && keys.length !== (del.count ?? 1)) {
      failures.push(
        `deleted ${del.table} WHERE ${del.where}: matched ${keys.length} row(s) before the call, expected ${del.count ?? 1}`,
      );
    }
    for (const key of keys) {
      account(del.table, key);
      if (now.rows.has(key))
        failures.push(`deleted ${del.table} ${key}: the row is still there`);
    }
  }

  for (const expr of write.after ?? []) {
    const compiled = compileSql(expr, body);
    const rows = await q<{ ok: boolean | null }>(
      `SELECT (${compiled.sql}) AS ok`,
      compiled.params,
    );
    if (rows[0]?.ok !== true) failures.push(`after: "${expr}" is not true`);
  }

  // Anything else that moved in a watched table is a side effect the row did not declare.
  for (const t of write.watch) {
    const before = prep.watch.get(t);
    const now = after.get(t);
    if (!before || !now) continue;
    const ok = accounted.get(t) ?? new Set<string>();
    for (const [key, row] of now.rows) {
      if (ok.has(key)) continue;
      const old = before.rows.get(key);
      if (!old) failures.push(`${t}: undeclared insert ${show(row)}`);
      else if (!isDeepStrictEqual(old, row))
        failures.push(`${t}: undeclared update of ${key}`);
    }
    for (const key of before.rows.keys()) {
      if (!ok.has(key) && !now.rows.has(key))
        failures.push(`${t}: undeclared delete of ${key}`);
    }
  }
}

// -------------------------------------------------------------------------------------------

/** Rows of a family that actually call a route (excluded rows are not test cases). */
export function callable(cases: ContractCase[]): CallCase[] {
  return cases.filter((c): c is CallCase => c.kind !== 'excluded');
}

/** Reloads world-v1 into the contract schema in one transaction. */
export async function resetWorld(): Promise<void> {
  const schema = contractSchema();
  await inOracleTransaction((client) => resetWorldV1(client, schema));
}

/**
 * Runs one registry row and throws one error listing every mismatch. `ctx` carries the logged-in
 * agents; share one per spec file (`beforeAll`).
 */
export async function runCase(
  c: ContractCase,
  ctx: ContractContext,
): Promise<void> {
  if (c.kind === 'excluded') return;
  const label = `[${c.id}] ${c.route} as ${c.actor}`;
  const oracles = [c.read, c.write, c.noDb].filter(
    (x) => x !== undefined,
  ).length;
  if (oracles > 1)
    throw new Error(`${label}: a row takes at most one of read / write / noDb`);
  if (oracles === 0 && !c.sameExpectedAs && c.expect.status < 400) {
    throw new Error(
      `${label}: a 2xx/3xx row needs read, write, noDb or sameExpectedAs`,
    );
  }

  if (c.resetWorld ?? (c.write !== undefined || ctx.worldDirty)) {
    await resetWorld();
    ctx.worldDirty = false;
  }
  if (c.write !== undefined) ctx.worldDirty = true;
  if (c.freshSession) ctx.drop(c.actor);
  // Log in before any snapshot: the login itself only touches auth_sessions (volatile), but
  // keeping it out of the measured window keeps the window exactly "this one request".
  await ctx.agentFor(c.actor);

  const failures: string[] = [];
  const negative = c.expect.status >= 400;
  const guardSchema = c.noDb === true || negative;
  const tables = guardSchema || c.write ? await schemaTables() : [];
  const outside =
    c.write && c.write.unchangedElse !== false
      ? tables.filter(
          (t) => !c.write?.watch.includes(t) && !c.write?.derived?.includes(t),
        )
      : [];
  const beforeAll = guardSchema ? await schemaChecksum(tables) : undefined;
  const beforeOutside = outside.length
    ? await schemaChecksum(outside)
    : undefined;
  const prep =
    c.write && !negative ? await prepareWrite(c.write, failures) : undefined;

  const res = await callRoute(c, ctx);
  if (c.freshSession) ctx.drop(c.actor);
  if (c.settle && res.status === c.expect.status) {
    await waitSettled(c.settle, res.body, failures);
  }

  if (res.status !== c.expect.status) {
    failures.push(
      `status ${res.status}, expected ${c.expect.status}; body: ${res.text.slice(0, 500)}`,
    );
  } else {
    if (c.expect.bodyText !== undefined && res.text !== c.expect.bodyText) {
      failures.push(
        `body text ${show(res.text.slice(0, 300))}, expected ${show(c.expect.bodyText.slice(0, 300))}`,
      );
    }
    if (c.expect.bodyMatches) {
      const actual = (res.body ?? {}) as Row;
      for (const [k, v] of Object.entries(
        resolveRefs(c.expect.bodyMatches) as Row,
      )) {
        if (!isDeepStrictEqual(actual[k], v))
          failures.push(`body.${k}: ${show(actual[k])}, expected ${show(v)}`);
      }
    }
    if (c.read) await checkRead(c, c.read, res.body, failures);
    if (c.write && prep) await checkWrite(c.write, prep, res.body, failures);
    if (c.sameExpectedAs) {
      const twin = await callRoute(findCallCase(c.sameExpectedAs), ctx);
      if (!isDeepStrictEqual(twin.body, res.body)) {
        failures.push(
          `answer differs from its twin ${c.sameExpectedAs}: ${show(res.body)} vs ${show(twin.body)}`,
        );
      }
    }
  }

  if (beforeAll) {
    const changed = changedTables(beforeAll, await schemaChecksum(tables));
    if (changed.length)
      failures.push(
        `the DB changed although the row expects no write: ${changed.join(', ')}`,
      );
  }
  if (beforeOutside) {
    const changed = changedTables(beforeOutside, await schemaChecksum(outside));
    if (changed.length)
      failures.push(`tables outside "watch" changed: ${changed.join(', ')}`);
  }

  if (failures.length) {
    throw new Error(`${label}\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  }
}
