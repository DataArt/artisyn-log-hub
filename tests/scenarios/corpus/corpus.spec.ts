// S-CORPUS-01…05. The session corpus in tests/corpus/ (impl-plan DD I1–I3,
// docs/qaa-overview/scenarios/08-session-corpus.md): real `claude -p` recordings of every set,
// replayed into the mode-A stand. The sets are local only (gitignored, `npm run corpus:bootstrap`);
// without one every test here is skipped. Project `corpus` of playwright.scenarios.config.ts; run.mjs runs
// it on the mode-A stand next to `mode-a` (`--only scenarios,corpus`).
//
// Every upload goes through `remapCorpusSession`, so the same recording can be loaded by every test
// of the file on one stand; the snapshot maps the fresh ids back to the recorded ones.
//
// Snapshot (DD I2): per session `<set>/<repo>__<scenario>/expected.json` holds the stand's
// normalised answers — repository `summary`, the session-list row (`stats`: tokens, cost, tree) and
// the session `change-surface`. `CORPUS_APPROVE=1 npm run test:scenarios -- --mode a --only corpus`
// rewrites them; the diff is reviewed by a human (tests/corpus/README.md).
import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import type { Pool } from 'pg';
import { test, expect, type ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  duplicateIds,
  formatDrift,
  formatSummary,
  listSets,
  loadCorpusSession,
  mergeSummaries,
  ndjsonLines,
  rawOracle,
  readKnownFormat,
  readScenarios,
  readSetManifest,
  remapCorpusSession,
  setDir,
  setTranscriptLines,
  normalizeSnapshot,
  uploadCorpusSession,
  type CorpusSession,
  type CorpusSessionEntry,
} from '../helpers/corpus';
import { storedBody } from '../helpers/ingest';
import { openSession, summaryTile, usd4 } from '../helpers/session-view';

const APPROVE = process.env.CORPUS_APPROVE === '1';
const SETS = listSets();

interface CostBreakdown {
  mainCost: number | null;
  subagentCost: number;
  utilityCost: number;
  calculatedCost: number | null;
}

interface SessionRow {
  sessionId: string;
  totalCost: number | null;
  costBreakdown?: CostBreakdown;
  [key: string]: unknown;
}

interface Loaded {
  entry: CorpusSessionEntry;
  repoId: number;
  /** Remapped root id, as stored on the stand. */
  sessionId: string;
  /** Remapped → recorded id pairs (root UUID and agent ids). */
  back: Array<[string, string]>;
}

async function getJson<T>(user: ScenarioUser, url: string): Promise<T> {
  const res = await user.api.get(url);
  expect(res.status(), `GET ${url}`).toBe(200);
  return (await res.json()) as T;
}

/** Uploads every session of `set` for `owner` and resolves each one's repository on the stand. */
async function loadSet(
  api: APIRequestContext,
  db: Pool,
  owner: ScenarioUser,
  set: string,
  opts: { gzip?: boolean } = {},
): Promise<Loaded[]> {
  const key = await createApiKey(owner.api);
  const manifest = readSetManifest(set);
  const out: Loaded[] = [];
  for (const entry of manifest.sessions) {
    const original = loadCorpusSession(set, entry);
    const session = remapCorpusSession(original);
    await uploadOrThrow(api, key.key, session, db, owner.id, opts.gzip ?? false);
    const back: Array<[string, string]> = [[session.sessionId, original.sessionId]];
    session.subagents.forEach((s, i) => {
      back.push([s.sessionId.replace(/^agent-/, ''), original.subagents[i].sessionId.replace(/^agent-/, '')]);
    });
    const repos = await getJson<Array<{ id: number; repoUrl: string }>>(owner, '/api/v1/repositories');
    const repo = repos.find((r) => r.repoUrl.replace(/\.git$/, '') === entry.repoUrl.replace(/\.git$/, ''));
    if (!repo) throw new Error(`${set}/${entry.dir}: repository ${entry.repoUrl} is not listed for ${owner.email}`);
    out.push({ entry, repoId: repo.id, sessionId: session.sessionId, back });
  }
  return out;
}

async function uploadOrThrow(api: APIRequestContext, apiKey: string, session: CorpusSession, db: Pool, userId: number, gzip: boolean) {
  const counts = await uploadCorpusSession(api, apiKey, session, { queue: { db, userId }, gzip });
  expect(counts.failed ?? 0, `${session.entry.dir}: failed queue rows`).toBe(0);
}

async function sessionRow(owner: ScenarioUser, l: Loaded): Promise<SessionRow> {
  const rows = await getJson<SessionRow[]>(owner, `/api/v1/repositories/${l.repoId}/sessions`);
  const row = rows.find((r) => r.sessionId === l.sessionId);
  if (!row) throw new Error(`${l.entry.dir}: root session ${l.sessionId} is not in the session list`);
  return row;
}

/** The stand's normalised answers for one loaded session, with the recorded ids put back. */
async function snapshot(owner: ScenarioUser, l: Loaded): Promise<unknown> {
  const base = `/api/v1/repositories/${l.repoId}`;
  const raw = {
    summary: await getJson<unknown>(owner, `${base}/summary`),
    stats: await sessionRow(owner, l),
    changeSurface: await getJson<unknown>(owner, `${base}/sessions/${encodeURIComponent(l.sessionId)}/change-surface`),
  };
  let text = JSON.stringify(raw);
  for (const [from, to] of l.back) text = text.split(from).join(to);
  return normalizeSnapshot(JSON.parse(text));
}

/** Every finite number under a key that names tokens, with its path. */
function tokenValues(value: unknown, at = ''): Array<[string, number]> {
  if (Array.isArray(value)) return value.flatMap((v, i) => tokenValues(v, `${at}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  const out: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && /tokens/i.test(k)) out.push([`${at}.${k}`, v]);
    else out.push(...tokenValues(v, `${at}.${k}`));
  }
  return out;
}

test.describe('session corpus', () => {
  // tests/corpus/sets/ is gitignored, so a fresh clone has no set: skip, never fail on that.
  test.skip(SETS.length === 0, 'tests/corpus/sets/ holds no set — record one with `npm run corpus:bootstrap`');

  test('@S-CORPUS-01 replay: every recorded session loads and matches its approved snapshot', async ({ api, db, users, page }) => {
    test.setTimeout(60_000 + SETS.length * 120_000);
    for (const set of SETS) {
      const owner = await users.user('user', { label: 'corpus01' });
      const loaded = await test.step(`${set}: upload every session through POST /api/v2/logs`, () => loadSet(api, db, owner, set));
      for (const l of loaded) {
        await test.step(`${set}/${l.entry.dir}: summary, stats, change-surface = expected.json`, async () => {
          const actual = await snapshot(owner, l);
          const file = path.join(setDir(set), l.entry.dir, 'expected.json');
          if (APPROVE) {
            fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
            return;
          }
          if (!fs.existsSync(file)) {
            throw new Error(`${path.relative(process.cwd(), file)} is missing — approve the snapshot with CORPUS_APPROVE=1 (tests/corpus/README.md)`);
          }
          expect(actual).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
        });
      }
      const withAgents = loaded.filter((l) => l.entry.subagents > 0);
      for (const l of withAgents) {
        await test.step(`${set}/${l.entry.dir}: the session pane shows the tree cost`, async () => {
          const row = await sessionRow(owner, l);
          await openSession(page, owner, l.repoId, l.sessionId);
          await expect(summaryTile(page, 'Cost')).toContainText(usd4(row.totalCost ?? 0));
          await expect(summaryTile(page, 'Delegation')).toBeVisible();
        });
      }
    }
  });

  test('@S-CORPUS-02 invariants: independent oracle over the raw lines and the stand answers', async ({ api, db, users }) => {
    test.setTimeout(60_000 + SETS.length * 120_000);
    for (const set of SETS) {
      const manifest = readSetManifest(set);
      await test.step(`${set}: raw usage is non-negative, tool-call ids are unique, every sub-agent has a parent`, () => {
        for (const entry of manifest.sessions) {
          const s = loadCorpusSession(set, entry);
          const agentIds = new Set(s.subagents.map((a) => a.sessionId));
          for (const [what, body] of [['session', s.claude], ...s.subagents.map((a) => [a.sessionId, a.body])]) {
            const o = rawOracle(body);
            expect(o.badUsage, `${entry.dir}/${what}: bad usage`).toEqual([]);
            expect(duplicateIds(o.toolUseIds), `${entry.dir}/${what}: duplicate tool_use ids`).toEqual([]);
          }
          for (const a of s.subagents) {
            expect(a.parentSessionId === s.sessionId || agentIds.has(a.parentSessionId), `${entry.dir}/${a.sessionId}: parent`).toBe(true);
          }
          expect(s.subagents.length, `${entry.dir}: manifest sub-agent count`).toBe(entry.subagents);
        }
      });
      const owner = await users.user('user', { label: 'corpus02' });
      const loaded = await loadSet(api, db, owner, set);
      for (const l of loaded) {
        await test.step(`${set}/${l.entry.dir}: tree cost = root + sub-agents + utility; tokens >= 0`, async () => {
          const row = await sessionRow(owner, l);
          for (const [at, v] of tokenValues(row)) expect(v, `${l.entry.dir}${at}`).toBeGreaterThanOrEqual(0);
          const b = row.costBreakdown;
          expect(b, `${l.entry.dir}: costBreakdown`).toBeTruthy();
          if (!b || b.mainCost === null) throw new Error(`${l.entry.dir}: no computed cost (unknown model?)`);
          expect(b.calculatedCost ?? NaN).toBeCloseTo(b.mainCost + b.subagentCost + b.utilityCost, 9);
          if (l.entry.subagents === 0) expect(b.subagentCost).toBe(0);
          else expect(b.subagentCost).toBeGreaterThan(0);
          expect(row.totalCost ?? NaN).toBeCloseTo(b.calculatedCost ?? NaN, 9);
        });
      }
    }
  });

  test('@S-CORPUS-03 format drift: every line type, key, content block and attachment is approved', () => {
    const known = readKnownFormat();
    const all = mergeSummaries(SETS.map((set) => formatSummary(setTranscriptLines(set))));
    expect(
      formatDrift(all, known),
      'new in the logs — review tmp/corpus/<set>/whats-new.md, then node scripts/corpus/diff-format.mjs <set> --approve',
    ).toEqual([]);
  });

  test('@S-CORPUS-04 scenario structure holds on every Claude Code version', () => {
    const scenarios = readScenarios();
    for (const set of SETS) {
      for (const entry of readSetManifest(set).sessions) {
        const scenario = scenarios.find((s) => s.id === entry.scenario);
        if (!scenario) throw new Error(`${set}/${entry.dir}: scenario "${entry.scenario}" is not in scenarios.json`);
        const s = loadCorpusSession(set, entry);
        const bodies = [s.claude, ...s.subagents.map((a) => a.body)];
        const oracles = bodies.map(rawOracle);
        const tools = new Set(oracles.flatMap((o) => Object.keys(o.tools)));
        const edited = new Set(oracles.flatMap((o) => o.editedFiles));
        const e = scenario.expect;
        const where = `${set}/${entry.dir}`;
        if (e.minSubagents !== undefined) expect(s.subagents.length, `${where}: sub-agents`).toBeGreaterThanOrEqual(e.minSubagents);
        if (e.maxSubagents !== undefined) expect(s.subagents.length, `${where}: sub-agents`).toBeLessThanOrEqual(e.maxSubagents);
        for (const alt of e.tools ?? []) {
          expect(alt.split('|').some((t) => tools.has(t)), `${where}: one of ${alt} called (got ${[...tools].join(', ')})`).toBe(true);
        }
        if (e.minChangedFiles !== undefined) expect(edited.size, `${where}: changed files`).toBeGreaterThanOrEqual(e.minChangedFiles);
        if (e.maxChangedFiles !== undefined) expect(edited.size, `${where}: changed files`).toBeLessThanOrEqual(e.maxChangedFiles);
        expect(ndjsonLines(s.claude).length, `${where}: root transcript lines`).toBeGreaterThan(0);
      }
    }
  });

  test('@S-CORPUS-05 recorded hook telemetry goes through the hook upload path (gzip) against the current server', async ({
    api,
    db,
    users,
  }) => {
    test.setTimeout(60_000 + SETS.length * 120_000);
    for (const set of SETS) {
      const manifest = readSetManifest(set);
      const withHook = manifest.sessions.filter((e) => e.hook);
      if (withHook.length === 0) continue;
      const owner = await users.user('user', { label: 'corpus05' });
      const loaded = await test.step(`${set}: gzip uploads of hook telemetry + transcripts`, () => loadSet(api, db, owner, set, { gzip: true }));
      for (const l of loaded.filter((x) => x.entry.hook)) {
        await test.step(`${set}/${l.entry.dir}: the artisyn log is stored and the session has its prompts`, async () => {
          const body = await storedBody(db, l.sessionId, 'artisyn');
          expect(body?.length ?? 0, `${l.entry.dir}: stored artisyn lines`).toBeGreaterThan(0);
          const row = await sessionRow(owner, l);
          expect(row.sessionId).toBe(l.sessionId);
        });
      }
    }
  });
});
