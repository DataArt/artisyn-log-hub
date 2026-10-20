/**
 * golden.ts — loads the golden sessions in `tests/golden/` onto a stand (impl-plan DD D1–D2).
 *
 *  - `uploadGolden(api, apiKey, fixtureId, opts)` sends every file of one fixture through
 *    `POST /api/v2/logs` with `X-API-Key`, the way the hook does: per root its `artisyn` and
 *    `claude` logs, then each sub-agent as `claude-subagent` with `parentSessionId` (and
 *    `workflowRunId` for workflow agents). It then waits for the user's upload queue to go idle
 *    (`waitForQueueIdle`, DD C12) so callers can assert straight away.
 *  - `loadExpected(fixtureId)` reads the fixture's `expected.json` (DD D3), `loadRepoGoldExpected()`
 *    the REPO-GOLD totals; `shiftGoldenTime(iso, deltaDays)` maps their fixture-relative times
 *    onto a loaded copy.
 *  - `materializeGolden(fixtureId, opts)` returns the bodies exactly as they would be uploaded,
 *    without any network — for checks that only need the rewritten text.
 *
 * Rewriting before upload:
 *  - `{{RUN}}` → the run id (every session and agent id carries it, so the same fixture can be
 *    uploaded several times on one stand);
 *  - `{{REPO}}` → the repository URL;
 *  - every quoted ISO timestamp is shifted by whole days so the fixtures' anchor `A`
 *    (Monday 2026-01-05) becomes `base`. The default `base` is the Monday two weeks before the
 *    current week: W1 and W2 then both lie in the past and inside a "last 30 days" range. (DD D2
 *    words it as "last week's Monday", which would put W2 Wednesday/Thursday sessions in the
 *    future early in a week; `scenarios/03` §2.1 uses two weeks back, which is what this does.)
 *
 * Loaded by Playwright and, per DD C13, directly by Node's type stripping, so it uses erasable
 * syntax only and imports local modules with an explicit `.ts` extension.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { Pool } from 'pg';
import { waitForQueueIdle, type QueueStatusCounts } from './queue.ts';

/** `tests/golden/`. Under Node's ESM type stripping there is no `__dirname`; fall back to the cwd. */
export const GOLDEN_ROOT: string =
  typeof __dirname === 'string'
    ? path.resolve(__dirname, '..', '..', 'golden')
    : path.resolve(process.cwd(), 'tests', 'golden');

/** The fixtures' date anchor `A`: Monday 2026-01-05, 00:00 UTC. */
export const GOLDEN_ANCHOR = new Date('2026-01-05T00:00:00.000Z');

export const GOLDEN_FIXTURE_IDS = [
  'gs-01',
  'gs-02',
  'gs-03',
  'gs-04',
  'gs-05',
  'gs-06',
  'gs-07',
  'gs-08',
  'gs-09',
] as const;

export type GoldenFixtureId = (typeof GOLDEN_FIXTURE_IDS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_IN_QUOTES = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)"/g;

/** One entry of a fixture's `upload.json`. */
export interface GoldenSubagentManifest {
  key: string;
  sessionId: string;
  file: string;
  parentSessionId: string;
  workflowRunId?: string;
}

export interface GoldenRootManifest {
  key: string;
  sessionId: string;
  artisyn: string;
  claude: string;
  subagents: GoldenSubagentManifest[];
}

export interface GoldenManifest {
  fixture: string;
  generatedBy?: string;
  roots: GoldenRootManifest[];
}

/** A token bundle in `expected.json`. `inputFast`/`outputFast` are the fast-mode share of `input`/`output`. */
export interface GoldenTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  inputFast: number;
  outputFast: number;
  webSearch: number;
}

export interface GoldenLines {
  written: number;
  added: number;
  removed: number;
  editWriteCalls: number;
}

/** One transcript of a root's tree: `root` itself or a sub-agent keyed as in `upload.json`. */
export interface GoldenNodeExpected {
  key: string;
  parent?: string;
  /** Workflow name for a workflow agent (a node launched by a `Workflow` tool call). */
  workflow?: string;
  model: string;
  tokens: GoldenTokens;
  costUsd: number | null;
  lines?: GoldenLines & { filesEditedWritten: number };
}

export interface GoldenToolExpected {
  calls: number;
  successes: number;
  failures: number;
  unresolved: number;
  failureRate?: number;
}

export interface GoldenChangeSurfaceExpected {
  changedFiles: number;
  foldersTouched: number;
  topLevelModules: number;
  singleFileFolders: number;
  linesAdded: number;
  linesRemoved: number;
  outsideRepoFiles: number;
  concentration: number | null;
  band: 'focused' | 'mixed' | 'scattered' | null;
  /** Repo-relative folder → changed files in it. */
  folders?: Record<string, number>;
  /** Lines of the files outside the repository (counted apart from `linesAdded`/`linesRemoved`). */
  outsideRepoLinesAdded?: number;
  outsideRepoLinesRemoved?: number;
  /** Summary change-surface detectors that fire (`spread`, `modules`, `single-file-folders`). */
  detectors?: string[];
  commonAncestor?: string;
}

/**
 * One root in a fixture's `expected.json`: numbers from DD D3, the remaining fields from
 * `scenarios/03` §2.3. `start`/`end` are fixture-relative (anchor `A`, before the loader's shift);
 * `costUsd` and `tokens.tree` cover the root and every sub-agent, `ownCostUsd`/`tokens.own` the root.
 * Fixture-specific extras (per-prompt rows, GS-03's turn table, GS-05's harness rows…) are kept as
 * they are and typed `unknown` here.
 */
export interface GoldenRootExpected {
  key: string;
  branch: string;
  week: 'W1' | 'W2';
  start: string;
  end: string;
  durationMs: number;
  model: string;
  claudeVersion: string;
  prompts: number;
  workTimeMs: number;
  costUsd: number | null;
  ownCostUsd: number | null;
  costUnavailableReason: string | null;
  nodes: GoldenNodeExpected[];
  tokens: { own: GoldenTokens; tree: GoldenTokens };
  cacheRatio: { own: number | null; tree: number | null };
  tools: Record<string, GoldenToolExpected>;
  commits: number;
  pullRequests: number;
  lines: GoldenLines & { writtenOwn: number };
  changeSurface: GoldenChangeSurfaceExpected;
  [extra: string]: unknown;
}

/** A fixture's `expected.json`. */
export interface GoldenExpected {
  fixture: string;
  roots: GoldenRootExpected[];
}

/** `tests/golden/repo-gold.expected.json` — the REPO-GOLD totals (DD D3, `scenarios/03` §2.4). */
export interface RepoGoldExpected {
  range: { start: string; end: string };
  rootSessions: number;
  sessionsWithDescendants: number;
  costUsd: number;
  costByBranch: Record<string, number>;
  sessionsByBranch: Record<string, number>;
  workTimeMsByBranch: Record<string, number>;
  linesWrittenByBranch: Record<string, number>;
  costByWeek: { W1: number; W2: number };
  sessionsByWeek: { W1: number; W2: number };
  costByRootModel: Record<string, { sessions: number; costUsd: number | null }>;
  excludedSessionCount: number;
  excludedModels: string[];
  topSessionsByCost: { key: string; costUsd: number }[];
  tokens: {
    tree: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite5m: number; cacheWrite1h: number };
    root: { cacheRead: number; cacheWrite: number; cacheWrite5m: number; cacheWrite1h: number };
  };
  cacheRatio: { root: number; withDescendants: number; meanOfSessionRatiosTrap: number };
  undefinedRatioSessions: number;
  cacheCreationCausesRootThreshold25000: { compaction: number; fileReread: number; unattributed: number };
  workTimeMs: number;
  avgSessionLengthMs: number;
  /** Fixture-relative `YYYY-MM-DD` → merged work minutes; every day of the range is present. */
  workTimeMinutesByDay: Record<string, number>;
  lines: GoldenLines & { diffCoveredCalls: number };
  commits: number;
  pullRequests: number;
  tools: Record<string, GoldenToolExpected & { failureRate: number }>;
  toolCalls: number;
  avgCostPerSessionUsd: number;
  avgCostPerLineUsd: number;
  avgLinesPerHour: number;
}

export interface GoldenOptions {
  /** Monday 00:00 UTC that the anchor `A` maps to. Default: the Monday two weeks before this week's. */
  base?: Date;
  /** Replaces `{{RUN}}`. Default: 8 random hex characters. Share it to load several fixtures into one repo. */
  runId?: string;
  /** Replaces `{{REPO}}`. Default: `https://git.arrakis.test/golden/repo-gold-<runId>.git`. */
  repoUrl?: string;
}

export interface UploadGoldenOptions extends GoldenOptions {
  /** Where to wait for the upload queue: the `db` fixture's pool and the API key owner's id. */
  queue: { db: Pool; userId: number; timeoutMs?: number };
}

/** One HTTP upload, already rewritten. */
export interface GoldenUpload {
  sessionId: string;
  type: 'artisyn' | 'claude' | 'claude-subagent';
  parentSessionId?: string;
  workflowRunId?: string;
  /** Path relative to the fixture folder. */
  file: string;
  body: string;
}

export interface MaterializedGolden {
  fixtureId: GoldenFixtureId;
  /** Absolute path of the fixture folder. */
  dir: string;
  runId: string;
  repoUrl: string;
  base: Date;
  deltaDays: number;
  roots: { key: string; sessionId: string; subagents: { key: string; sessionId: string; parentSessionId: string }[] }[];
  /** Every root and sub-agent session id, roots first. */
  sessionIds: string[];
  uploads: GoldenUpload[];
}

export interface UploadedGolden extends Omit<MaterializedGolden, 'uploads'> {
  /** Upload-queue status counts once the queue went idle. */
  queue: QueueStatusCounts;
}

/** A fresh run id for `{{RUN}}`. */
export function goldenRunId(): string {
  return randomBytes(4).toString('hex');
}

/** Monday 00:00 UTC of the week two weeks before the week of `now`. */
export function defaultGoldenBase(now: Date = new Date()): Date {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return new Date(midnight - (sinceMonday + 14) * DAY_MS);
}

/** `gs-04`, `GS-04`, `gs04` or the folder name `gs-04-cache-5m-1h` → `gs-04`. */
export function normalizeGoldenId(fixtureId: string): GoldenFixtureId {
  const match = /^gs-?(\d{2})/i.exec(fixtureId.trim());
  const id = match ? `gs-${match[1]}` : '';
  const known = GOLDEN_FIXTURE_IDS.find((f) => f === id);
  if (!known) {
    throw new Error(`Unknown golden fixture "${fixtureId}" (known: ${GOLDEN_FIXTURE_IDS.join(', ')})`);
  }
  return known;
}

/** Absolute path of the fixture's folder (`tests/golden/gs-NN-<slug>/`). */
export function goldenDir(fixtureId: string): string {
  const id = normalizeGoldenId(fixtureId);
  const folder = fs
    .readdirSync(GOLDEN_ROOT, { withFileTypes: true })
    .find((e) => e.isDirectory() && e.name.startsWith(`${id}-`));
  if (!folder) throw new Error(`No folder for golden fixture ${id} under ${GOLDEN_ROOT}`);
  return path.join(GOLDEN_ROOT, folder.name);
}

export function readGoldenManifest(fixtureId: string): GoldenManifest {
  return JSON.parse(fs.readFileSync(path.join(goldenDir(fixtureId), 'upload.json'), 'utf8')) as GoldenManifest;
}

/** Reads the fixture's `expected.json`. */
export function loadExpected(fixtureId: string): GoldenExpected {
  const file = path.join(goldenDir(fixtureId), 'expected.json');
  if (!fs.existsSync(file)) {
    throw new Error(`${path.relative(process.cwd(), file)} does not exist yet`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as GoldenExpected;
}

/** Reads `tests/golden/repo-gold.expected.json`. */
export function loadRepoGoldExpected(): RepoGoldExpected {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_ROOT, 'repo-gold.expected.json'), 'utf8')) as RepoGoldExpected;
}

/** A fixture-relative timestamp (anchor `A`) moved to the loaded copy's dates. */
export function shiftGoldenTime(iso: string, deltaDays: number): Date {
  return new Date(Date.parse(iso) + deltaDays * DAY_MS);
}

function wholeDays(from: Date, to: Date): number {
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (!Number.isInteger(days)) {
    throw new Error(`golden base ${to.toISOString()} is not a whole number of days from ${from.toISOString()}`);
  }
  return days;
}

function rewrite(text: string, runId: string, repoUrl: string, deltaMs: number): string {
  const shifted = text.replace(ISO_IN_QUOTES, (_whole, iso: string) => `"${new Date(Date.parse(iso) + deltaMs).toISOString()}"`);
  return shifted.split('{{RUN}}').join(runId).split('{{REPO}}').join(repoUrl);
}

/** Reads one NDJSON file, normalises line endings (git may check it out with CRLF) and rewrites it. */
function readBody(dir: string, file: string, runId: string, repoUrl: string, deltaMs: number): string {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  return rewrite(lines.join('\n'), runId, repoUrl, deltaMs) + '\n';
}

/** Builds every upload of a fixture, rewritten, without sending anything. */
export function materializeGolden(fixtureId: string, opts: GoldenOptions = {}): MaterializedGolden {
  const id = normalizeGoldenId(fixtureId);
  const dir = goldenDir(id);
  const manifest = readGoldenManifest(id);
  const runId = opts.runId ?? goldenRunId();
  if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new Error(`golden runId "${runId}" must be [A-Za-z0-9-]`);
  const repoUrl = opts.repoUrl ?? `https://git.arrakis.test/golden/repo-gold-${runId}.git`;
  const base = opts.base ?? defaultGoldenBase();
  if (base.getUTCDay() !== 1 || base.getTime() % DAY_MS !== 0) {
    throw new Error(`golden base must be a Monday 00:00 UTC, got ${base.toISOString()}`);
  }
  const deltaDays = wholeDays(GOLDEN_ANCHOR, base);
  const deltaMs = deltaDays * DAY_MS;
  const sub = (s: string) => rewrite(s, runId, repoUrl, deltaMs);

  const uploads: GoldenUpload[] = [];
  const roots: MaterializedGolden['roots'] = [];
  for (const root of manifest.roots) {
    const rootSessionId = sub(root.sessionId);
    uploads.push({ sessionId: rootSessionId, type: 'artisyn', file: root.artisyn, body: readBody(dir, root.artisyn, runId, repoUrl, deltaMs) });
    uploads.push({ sessionId: rootSessionId, type: 'claude', file: root.claude, body: readBody(dir, root.claude, runId, repoUrl, deltaMs) });
    const subagents: MaterializedGolden['roots'][number]['subagents'] = [];
    for (const agent of root.subagents) {
      const upload: GoldenUpload = {
        sessionId: sub(agent.sessionId),
        type: 'claude-subagent',
        parentSessionId: sub(agent.parentSessionId),
        file: agent.file,
        body: readBody(dir, agent.file, runId, repoUrl, deltaMs),
      };
      if (agent.workflowRunId !== undefined) upload.workflowRunId = sub(agent.workflowRunId);
      uploads.push(upload);
      subagents.push({ key: agent.key, sessionId: upload.sessionId, parentSessionId: upload.parentSessionId ?? rootSessionId });
    }
    roots.push({ key: root.key, sessionId: rootSessionId, subagents });
  }

  return {
    fixtureId: id,
    dir,
    runId,
    repoUrl,
    base,
    deltaDays,
    roots,
    sessionIds: [...roots.map((r) => r.sessionId), ...roots.flatMap((r) => r.subagents.map((s) => s.sessionId))],
    uploads,
  };
}

/**
 * Uploads one golden fixture with the hook's API key and waits until the user's upload queue
 * is idle. Throws on any non-201 answer, on a foreign-session warning, and on a failed queue row.
 */
export async function uploadGolden(
  api: APIRequestContext,
  apiKey: string,
  fixtureId: string,
  opts: UploadGoldenOptions,
): Promise<UploadedGolden> {
  const { uploads, ...golden } = materializeGolden(fixtureId, opts);
  for (const upload of uploads) {
    const params: Record<string, string> = { sessionId: upload.sessionId, type: upload.type };
    if (upload.parentSessionId !== undefined) params.parentSessionId = upload.parentSessionId;
    if (upload.workflowRunId !== undefined) params.workflowRunId = upload.workflowRunId;
    const res = await api.post('/api/v2/logs', {
      params,
      headers: { 'Content-Type': 'text/plain', 'X-API-Key': apiKey },
      data: upload.body,
    });
    if (res.status() !== 201) {
      throw new Error(
        `Uploading ${golden.fixtureId}/${upload.file} as ${upload.type} failed (${res.status()}): ${await res.text()}`,
      );
    }
    const { warnings } = (await res.json()) as { warnings?: string[] };
    const foreign = (warnings ?? []).find((w) => w.includes(upload.sessionId));
    if (foreign) throw new Error(`Uploading ${golden.fixtureId}/${upload.file} was refused: ${foreign}`);
  }
  const queue = await waitForQueueIdle(opts.queue.db, opts.queue.userId, { timeoutMs: opts.queue.timeoutMs ?? 30_000 });
  return { ...golden, queue };
}
