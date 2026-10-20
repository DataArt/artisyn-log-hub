/**
 * corpus.ts — the session corpus in `tests/corpus/` (impl-plan DD I1–I3,
 * docs/qaa-overview/scenarios/08-session-corpus.md).
 *
 *  - Reading: `listSets()`, `readSetManifest(set)`, `loadCorpusSession(set, entry)` — the gzipped
 *    root transcript, every sub-agent (parent from its `.meta.json`, as the hook derives it) and the
 *    hook telemetry, each as NDJSON text.
 *  - Uploading: `uploadCorpusSession(api, apiKey, session, queue)` sends them through
 *    `POST /api/v2/logs` the way the hook does and waits for the upload queue; `remapCorpusSession`
 *    gives a copy fresh session/agent ids, so the same recording can be uploaded twice on one stand.
 *  - Format: `formatSummary(lines)` collects line types, keys per line type, content-block types,
 *    attachment types and system subtypes; `formatDrift(summary, known)` lists what `known` lacks.
 *    `scripts/corpus/diff-format.mjs` uses the same two functions for the "what's new" report.
 *  - Oracle: `rawOracle(text)` re-derives per-transcript token totals and tool-call ids straight from
 *    the raw lines, without the app's parser.
 *  - Snapshot: `normalizeSnapshot(value)` drops the run-specific fields of an API answer.
 *
 * Loaded by Playwright and, per DD C13, by Node's type stripping (diff-format.mjs), so it uses
 * erasable syntax only and imports local modules with an explicit `.ts` extension.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { Pool } from 'pg';
import { waitForQueueIdle, type QueueStatusCounts } from './queue.ts';

/** `tests/corpus/`. Under Node's ESM type stripping there is no `__dirname`; fall back to the cwd. */
export const CORPUS_ROOT: string =
  typeof __dirname === 'string'
    ? path.resolve(__dirname, '..', '..', 'corpus')
    : path.resolve(process.cwd(), 'tests', 'corpus');

export const SETS_DIR = path.join(CORPUS_ROOT, 'sets');
export const KNOWN_FORMAT_FILE = path.join(CORPUS_ROOT, 'known-format.json');
export const SCENARIOS_FILE = path.join(CORPUS_ROOT, 'scenarios', 'scenarios.json');

/** `2026-10_cc-2.1.280`: one month, one Claude Code version. */
export const SET_NAME_RE = /^\d{4}-\d{2}_cc-\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------------------------
// manifest and scenarios

export interface ScenarioExpect {
  minSubagents?: number;
  maxSubagents?: number;
  /** Each entry is `A|B`: at least one call of one of these tools somewhere in the tree. */
  tools?: string[];
  minChangedFiles?: number;
  maxChangedFiles?: number;
}

export interface CorpusScenario {
  id: string;
  repo: string;
  model: string;
  prompt: string;
  expect: ScenarioExpect;
}

export interface CorpusSessionEntry {
  /** Folder in the set: `<repo>__<scenario>`. */
  dir: string;
  repo: string;
  scenario: string;
  model: string;
  /** Root session id (the Claude Code session UUID). */
  sessionId: string;
  /** Normalised repository URL the hook reports (`https://example.test/big-test/<repo>`). */
  repoUrl: string;
  subagents: number;
  /** True when `hook/artisyn.jsonl.gz` holds the real hook's telemetry of this session. */
  hook: boolean;
}

export interface CorpusManifest {
  set: string;
  generatedAt: string;
  claudeCodeVersion: string;
  hookVersion: string;
  os: string;
  generatorCommit: string;
  models: string[];
  sessions: CorpusSessionEntry[];
  /** Set-relative path (forward slashes) → sha256 of the file's bytes. */
  files: Record<string, string>;
}

export function readScenarios(file: string = SCENARIOS_FILE): CorpusScenario[] {
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { scenarios: CorpusScenario[] }).scenarios;
}

/** Every set folder under `tests/corpus/sets/`, oldest first. */
export function listSets(setsDir: string = SETS_DIR): string[] {
  if (!fs.existsSync(setsDir)) return [];
  return fs
    .readdirSync(setsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SET_NAME_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

export function setDir(set: string, setsDir: string = SETS_DIR): string {
  return path.join(setsDir, set);
}

export function readSetManifest(set: string, setsDir: string = SETS_DIR): CorpusManifest {
  return JSON.parse(fs.readFileSync(path.join(setDir(set, setsDir), 'manifest.json'), 'utf8')) as CorpusManifest;
}

/** A gzipped (or plain) text file, line endings normalised to `\n`. */
export function readMaybeGz(file: string): string {
  const raw = fs.readFileSync(file);
  const text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return text.replace(/\r\n/g, '\n');
}

/** Non-empty lines of an NDJSON text. */
export function ndjsonLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() !== '');
}

// ---------------------------------------------------------------------------------------------
// one recorded session

export interface CorpusSubagent {
  /** Upload id: the transcript's file name without `.jsonl` (`agent-<agentId>`), as the hook sends it. */
  sessionId: string;
  parentSessionId: string;
  body: string;
}

export interface CorpusSession {
  entry: CorpusSessionEntry;
  sessionId: string;
  claude: string;
  subagents: CorpusSubagent[];
  /** The hook telemetry (`artisyn` log), or null when the set has none for this session. */
  artisyn: string | null;
}

function parentFromMeta(metaFile: string, rootSessionId: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { parentAgentId?: unknown };
    if (typeof meta.parentAgentId === 'string' && meta.parentAgentId) return `agent-${meta.parentAgentId}`;
  } catch {
    // no meta: a depth-1 agent of the root (send-logs-hook.js falls back the same way)
  }
  return rootSessionId;
}

export function loadCorpusSession(set: string, entry: CorpusSessionEntry, setsDir: string = SETS_DIR): CorpusSession {
  const dir = path.join(setDir(set, setsDir), entry.dir);
  const subDir = path.join(dir, 'subagents');
  const subagents: CorpusSubagent[] = [];
  if (fs.existsSync(subDir)) {
    for (const name of fs.readdirSync(subDir).filter((n) => n.endsWith('.jsonl.gz')).sort()) {
      const id = name.slice(0, -'.jsonl.gz'.length);
      subagents.push({
        sessionId: id,
        parentSessionId: parentFromMeta(path.join(subDir, `${id}.meta.json`), entry.sessionId),
        body: readMaybeGz(path.join(subDir, name)),
      });
    }
  }
  const hookFile = path.join(dir, 'hook', 'artisyn.jsonl.gz');
  return {
    entry,
    sessionId: entry.sessionId,
    claude: readMaybeGz(path.join(dir, 'session.jsonl.gz')),
    subagents,
    artisyn: fs.existsSync(hookFile) ? readMaybeGz(hookFile) : null,
  };
}

function replaceAll(text: string, pairs: Array<[string, string]>): string {
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

/**
 * A copy of `session` with a fresh root UUID and every agent id suffixed, in every body. Upload ids
 * are global, so a second upload of the same recording (another user, another test) needs this.
 */
export function remapCorpusSession(session: CorpusSession): CorpusSession {
  const suffix = randomBytes(3).toString('hex');
  const pairs: Array<[string, string]> = [[session.sessionId, randomUUID()]];
  for (const sub of session.subagents) {
    const agentId = sub.sessionId.replace(/^agent-/, '');
    pairs.push([agentId, `${agentId}${suffix}`]);
  }
  const map = (s: string) => replaceAll(s, pairs);
  return {
    entry: session.entry,
    sessionId: map(session.sessionId),
    claude: map(session.claude),
    subagents: session.subagents.map((s) => ({
      sessionId: map(s.sessionId),
      parentSessionId: map(s.parentSessionId),
      body: map(s.body),
    })),
    artisyn: session.artisyn === null ? null : map(session.artisyn),
  };
}

// ---------------------------------------------------------------------------------------------
// upload

export interface UploadCorpusOptions {
  queue: { db: Pool; userId: number; timeoutMs?: number };
  /** Send each body gzipped with `Content-Encoding: gzip`, as the hook does for a remote server. */
  gzip?: boolean;
}

/**
 * Uploads one recorded session (hook telemetry, root transcript, every sub-agent) with the hook's
 * API key and waits until the user's queue is idle. Throws on any non-201 answer, a foreign-session
 * warning or a failed queue row.
 */
export async function uploadCorpusSession(
  api: APIRequestContext,
  apiKey: string,
  session: CorpusSession,
  opts: UploadCorpusOptions,
): Promise<QueueStatusCounts> {
  const uploads: Array<{ params: Record<string, string>; body: string; what: string }> = [];
  if (session.artisyn !== null) {
    uploads.push({ params: { sessionId: session.sessionId, type: 'artisyn' }, body: session.artisyn, what: 'hook/artisyn' });
  }
  uploads.push({ params: { sessionId: session.sessionId, type: 'claude' }, body: session.claude, what: 'session' });
  for (const sub of session.subagents) {
    uploads.push({
      params: { sessionId: sub.sessionId, type: 'claude-subagent', parentSessionId: sub.parentSessionId },
      body: sub.body,
      what: `subagents/${sub.sessionId}`,
    });
  }
  for (const upload of uploads) {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-ndjson', 'X-API-Key': apiKey };
    let data: string | Buffer = upload.body;
    if (opts.gzip) {
      headers['Content-Encoding'] = 'gzip';
      data = zlib.gzipSync(Buffer.from(upload.body, 'utf8'));
    }
    const res = await api.post('/api/v2/logs', { params: upload.params, headers, data });
    if (res.status() !== 201) {
      throw new Error(`Uploading ${session.entry.dir}/${upload.what} failed (${res.status()}): ${await res.text()}`);
    }
    const { warnings } = (await res.json()) as { warnings?: string[] };
    if ((warnings ?? []).length > 0) {
      throw new Error(`Uploading ${session.entry.dir}/${upload.what} returned warnings: ${JSON.stringify(warnings)}`);
    }
  }
  return waitForQueueIdle(opts.queue.db, opts.queue.userId, { timeoutMs: opts.queue.timeoutMs ?? 60_000 });
}

// ---------------------------------------------------------------------------------------------
// format summary and drift (S-CORPUS-03, diff-format.mjs)

/** What a set's transcripts contain, as sorted lists (no counts, so it compares across sets). */
export interface FormatSummary {
  /** `type`, or `system:<subtype>` for system lines. */
  lineTypes: string[];
  /** Line type → its top-level keys. */
  keysByType: Record<string, string[]>;
  /** `message.content[].type` of user and assistant lines. */
  contentBlockTypes: string[];
  /** `attachment.type` of attachment lines. */
  attachmentTypes: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lineTypeOf(row: Record<string, unknown>): string {
  const type = typeof row.type === 'string' ? row.type : '<none>';
  return type === 'system' && typeof row.subtype === 'string' ? `system:${row.subtype}` : type;
}

/** Summarises raw transcript lines. A line that is not a JSON object counts as type `<unparsable>`. */
export function formatSummary(lines: Iterable<string>): FormatSummary {
  const types = new Set<string>();
  const keys = new Map<string, Set<string>>();
  const blocks = new Set<string>();
  const attachments = new Set<string>();
  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      types.add('<unparsable>');
      continue;
    }
    if (!isRecord(row)) {
      types.add('<unparsable>');
      continue;
    }
    const type = lineTypeOf(row);
    types.add(type);
    const set = keys.get(type) ?? new Set<string>();
    for (const k of Object.keys(row)) set.add(k);
    keys.set(type, set);
    const message = row.message;
    if (isRecord(message) && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && typeof block.type === 'string') blocks.add(block.type);
      }
    }
    if (isRecord(row.attachment) && typeof row.attachment.type === 'string') attachments.add(row.attachment.type);
  }
  const keysByType: Record<string, string[]> = {};
  for (const type of [...keys.keys()].sort()) keysByType[type] = [...(keys.get(type) ?? [])].sort();
  return {
    lineTypes: [...types].sort(),
    keysByType,
    contentBlockTypes: [...blocks].sort(),
    attachmentTypes: [...attachments].sort(),
  };
}

/** Union of several summaries (e.g. every set already approved). */
export function mergeSummaries(summaries: FormatSummary[]): FormatSummary {
  const union = (lists: string[][]) => [...new Set(lists.flat())].sort();
  const keysByType: Record<string, string[]> = {};
  for (const s of summaries) {
    for (const [type, list] of Object.entries(s.keysByType)) keysByType[type] = union([keysByType[type] ?? [], list]);
  }
  const sortedKeys: Record<string, string[]> = {};
  for (const type of Object.keys(keysByType).sort()) sortedKeys[type] = keysByType[type];
  return {
    lineTypes: union(summaries.map((s) => s.lineTypes)),
    keysByType: sortedKeys,
    contentBlockTypes: union(summaries.map((s) => s.contentBlockTypes)),
    attachmentTypes: union(summaries.map((s) => s.attachmentTypes)),
  };
}

/** Everything in `summary` that `known` lacks, as readable items (`line type "x"`, `key "y" of "x"`…). */
export function formatDrift(summary: FormatSummary, known: FormatSummary): string[] {
  const out: string[] = [];
  const has = (list: string[], v: string) => list.includes(v);
  for (const t of summary.lineTypes) if (!has(known.lineTypes, t)) out.push(`line type "${t}"`);
  for (const [type, list] of Object.entries(summary.keysByType)) {
    const knownKeys = known.keysByType[type] ?? [];
    for (const k of list) if (!has(knownKeys, k)) out.push(`key "${k}" of line type "${type}"`);
  }
  for (const b of summary.contentBlockTypes) if (!has(known.contentBlockTypes, b)) out.push(`content block "${b}"`);
  for (const a of summary.attachmentTypes) if (!has(known.attachmentTypes, a)) out.push(`attachment type "${a}"`);
  return out;
}

export function readKnownFormat(file: string = KNOWN_FORMAT_FILE): FormatSummary {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as FormatSummary;
}

/** Every transcript line of a set (roots and sub-agents; not the hook telemetry). */
export function setTranscriptLines(set: string, setsDir: string = SETS_DIR): string[] {
  const manifest = readSetManifest(set, setsDir);
  const lines: string[] = [];
  for (const entry of manifest.sessions) {
    const s = loadCorpusSession(set, entry, setsDir);
    lines.push(...ndjsonLines(s.claude));
    for (const sub of s.subagents) lines.push(...ndjsonLines(sub.body));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// independent oracle over raw lines (S-CORPUS-02)

export interface RawTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Distinct assistant API responses (by `message.id`). */
  responses: number;
  /** Every `tool_use` id, in order of appearance. */
  toolUseIds: string[];
  /** Tool name → number of distinct calls. */
  tools: Record<string, number>;
  /** `file_path` of every Edit/Write/MultiEdit/NotebookEdit call. */
  editedFiles: string[];
  /** Raw usage values that are negative or not numbers. */
  badUsage: string[];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Per-transcript totals straight from the raw NDJSON, without the app's parser. Claude Code writes
 * one line per content block of a response, each repeating the response's `usage`; the oracle
 * counts a response once (the last line with its `message.id` wins, because streaming may update
 * `output_tokens`).
 */
export function rawOracle(text: string): RawTotals {
  const usageById = new Map<string, Record<string, unknown>>();
  const toolUseIds: string[] = [];
  const tools: Record<string, number> = {};
  const editedFiles: string[] = [];
  const badUsage: string[] = [];
  for (const line of ndjsonLines(text)) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row) || row.type !== 'assistant' || !isRecord(row.message)) continue;
    const message = row.message;
    const id = typeof message.id === 'string' ? message.id : `line-${usageById.size}`;
    if (isRecord(message.usage)) usageById.set(id, message.usage);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        const toolId = typeof block.id === 'string' ? block.id : '';
        toolUseIds.push(toolId);
        const name = typeof block.name === 'string' ? block.name : '<none>';
        tools[name] = (tools[name] ?? 0) + 1;
        if (EDIT_TOOLS.has(name) && isRecord(block.input)) {
          const file = block.input.file_path ?? block.input.notebook_path;
          if (typeof file === 'string') editedFiles.push(file);
        }
      }
    }
  }
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const fields: Array<[keyof typeof totals, string]> = [
    ['input', 'input_tokens'],
    ['output', 'output_tokens'],
    ['cacheRead', 'cache_read_input_tokens'],
    ['cacheWrite', 'cache_creation_input_tokens'],
  ];
  for (const [id, usage] of usageById) {
    for (const [key, field] of fields) {
      const v = usage[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        badUsage.push(`${id}.${field}=${JSON.stringify(v)}`);
        continue;
      }
      totals[key] += v;
    }
  }
  return { ...totals, responses: usageById.size, toolUseIds, tools, editedFiles, badUsage };
}

/** Tool-use ids that occur more than once. */
export function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  return [...dup];
}

// ---------------------------------------------------------------------------------------------
// snapshot (S-CORPUS-01, DD I2)

/** Keys whose values differ between two loads of the same recording (DB ids, upload times, owner). */
const VOLATILE_KEYS = new Set([
  'id',
  'repoId',
  'repositoryId',
  'userId',
  'ownerId',
  'email',
  'userEmail',
  'ownerEmail',
  'createdAt',
  'updatedAt',
  'uploadedAt',
  'lastUploadAt',
  'lastUploadedAt',
  'ingestedAt',
  'processedAt',
]);

/** Deep copy of an API answer without run-specific keys; numbers rounded to 9 decimals. */
export function normalizeSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSnapshot);
  if (typeof value === 'number') return Number.isInteger(value) ? value : Math.round(value * 1e9) / 1e9;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEYS.has(key)) continue;
    out[key] = normalizeSnapshot(value[key]);
  }
  return out;
}
