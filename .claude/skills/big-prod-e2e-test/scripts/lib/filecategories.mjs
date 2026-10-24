// File categories check `FC` (phase P9b). The repo owner replaces the repo's file
// categories through the UI (Repository settings → "File Categories", `FileCategoriesEditor.tsx`,
// personal view → the user-scoped override), then the API must return exactly that config (AC
// FR-FC1) and FC_SCENARIO's session must carry exactly the read stats its own transcript implies
// under the new categories (AC FR-FC2): per category the number of Read calls and the size of their
// tool results — what the reads put into the context, not the file size on disk
// (expectedFileStats below). Saving triggers the server's recomputeForRepo(), so running after
// ingestion is fine.
import fs from 'node:fs';
import path from 'node:path';
import { acceptConsent, login, newUserContext } from './browser.mjs';
import { createApiClient } from './api.mjs';
import { FC_CATEGORIES, FC_STATS_TIMEOUT_MS, STAND_URL } from './config.mjs';
import { parseJsonl } from './evidence.mjs';

const UI_TIMEOUT_MS = 20000;
const POLL_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pure: problems comparing a RepoConfig's fileCategories with the wanted list ([] = equal). */
export function compareCategories(actual, wanted = FC_CATEGORIES) {
  const got = Array.isArray(actual) ? actual : [];
  const norm = (list) => list.map((c) => ({ name: c?.name, patterns: [...(c?.patterns ?? [])] }));
  const a = JSON.stringify(norm(got));
  const w = JSON.stringify(norm(wanted));
  return a === w ? [] : [`fileCategories are ${a}, expected ${w}`];
}

// ---- expected stats: a mirror of the server's session_file_stats rule ----------------------------
// Mirrors server/src/logs/claude-extractor.ts extractFileStatsByCategory() (:1294) — what
// session-file-stats-writer.ts writeSessionFileStats() (:73) runs on ingest and on the settings-save
// recompute — over ONE session node's own transcript: the main one (subagent transcripts are their
// own session rows, and the timeline reads the main session's rows only).
//  - files: +1 per assistant `tool_use` named `Read` with a string `input.file_path`, keyed by its
//    id. No dedup: reading a file twice counts twice; a failed read (is_error) still counts.
//  - bytes: for every user `tool_result` whose `tool_use_id` is a known Read,
//    computeToolResultBytes() (:1358): string content → its `.length`; an array → the sum of
//    `.length` of every `{type:'text'}` block's text (image blocks add nothing), no separator.
//    `.length` is UTF-16 code units, not UTF-8 bytes. Error results count too.
//  - category: classifyFile() (:95) — the first category with a regexp that tests the path wins,
//    invalid patterns are skipped, otherwise "code" — over normaliseReadPath() (:85): the longest
//    repo root stripped case-insensitively on a "/" boundary (change-surface/path-normalise.ts
//    stripRepoRootPreservingCase() :135, stripLongestRoot() :87, cleanSegments() :108); a path
//    outside every root stays absolute with "/" separators; no usable root → the
//    KNOWN_TOP_LEVEL_DIRS guess of normaliseFilePath() (:48).

const KNOWN_TOP_LEVEL_DIRS = Object.freeze(['server', 'client', 'doc', 'hook', '.claude', 'tests', 'dist', '.playwright-work-folder']);

const toPosix = (p) => String(p).replace(/\\/g, '/');

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Pure: usable repo roots — slash-normalised, trailing "/" dropped, empties and a bare "/" removed. */
export function usableRepoRoots(roots) {
  return (roots ?? [])
    .map((r) => {
      if (typeof r !== 'string') return '';
      const p = toPosix(r).trim();
      if (p === '/') return '';
      return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
    })
    .filter((r) => r.length > 0);
}

/** Pure: the server's normaliseReadPath() — a Read `file_path` made repo-relative for classification. */
export function normaliseReadPath(absPath, repoRoots) {
  const roots = usableRepoRoots(repoRoots);
  const posix = toPosix(absPath ?? '');
  if (roots.length === 0) {
    for (const dir of KNOWN_TOP_LEVEL_DIRS) {
      const idx = posix.indexOf(`/${dir}/`);
      if (idx !== -1) return posix.slice(idx + 1);
    }
    return posix.replace(/^\//, '');
  }
  const lower = posix.toLowerCase();
  let bestLen = -1;
  let best = null;
  for (const root of roots) {
    const prefix = `${root.toLowerCase()}/`;
    if (!lower.startsWith(prefix)) continue;
    const rest = posix.slice(prefix.length);
    if (rest.length === 0) continue;
    if (root.length > bestLen) {
      bestLen = root.length;
      best = rest;
    }
  }
  const segments = best === null ? [] : best.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  return segments.length ? segments.join('/') : posix;
}

/** Pure: the server's classifyFile() — the first matching category, else "code". */
export function classifyFile(relativePath, categories = FC_CATEGORIES) {
  for (const c of categories) {
    for (const pattern of c.patterns ?? []) {
      let re;
      try {
        re = new RegExp(pattern);
      } catch {
        continue;
      }
      if (re.test(relativePath)) return c.name;
    }
  }
  return 'code';
}

/** Pure: the server's computeToolResultBytes() — the length of a tool_result's text content. */
export function toolResultBytes(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const b of content) {
    if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') total += b.text.length;
  }
  return total;
}

/**
 * Pure: the expected `fileStatsByCategory` ({ [category]: { files, bytes } }, the API's shape) of
 * one session from its main transcript (JSONL text, lines or parsed events), its repo roots and
 * the categories. The rule is the server's, see above.
 */
export function expectedFileStats(transcript, repoRoots, categories = FC_CATEGORIES) {
  const result = {};
  const reads = new Map();
  const entry = (cat) => (result[cat] ??= { files: 0, bytes: 0 });
  for (const rec of parseJsonl(transcript)) {
    const content = isRecord(rec.message) ? rec.message.content : null;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isRecord(b)) continue;
      if (rec.type === 'assistant' && b.type === 'tool_use' && b.name === 'Read') {
        if (typeof b.id !== 'string' || !isRecord(b.input) || typeof b.input.file_path !== 'string') continue;
        const cat = classifyFile(normaliseReadPath(b.input.file_path, repoRoots), categories);
        reads.set(b.id, cat);
        entry(cat).files += 1;
      } else if (rec.type === 'user' && b.type === 'tool_result' && reads.has(b.tool_use_id)) {
        entry(reads.get(b.tool_use_id)).bytes += toolResultBytes(b.content);
      }
    }
  }
  return result;
}

/** The expected stats from a transcript file; null when there is no file or it cannot be read. */
export function expectedFileStatsFromFile(file, repoRoots, categories = FC_CATEGORIES) {
  if (!file) return null;
  try {
    return expectedFileStats(fs.readFileSync(file, 'utf8'), repoRoots, categories);
  } catch {
    return null;
  }
}

/**
 * Pure: problems for one session's `fileStatsByCategory` ([] = ok). Each wanted category needs
 * files ≥ 1, and every category in `expected` or `stats` must equal `expected` ({files, bytes}).
 * `expected` null (no readable transcript) is a problem, never a pass.
 */
export function judgeFileStats(stats, expected, wanted = FC_CATEGORIES) {
  const problems = [];
  const num = (v) => Number(v) || 0;
  for (const c of wanted) {
    const files = num(stats?.[c.name]?.files);
    if (files < 1) problems.push(`category "${c.name}" has ${files} file read(s), expected ≥ 1`);
  }
  if (!expected) {
    problems.push('no expected stats: the session transcript could not be read');
    return problems;
  }
  const names = [...new Set([...Object.keys(expected), ...Object.keys(stats ?? {})])].sort();
  for (const name of names) {
    const got = { files: num(stats?.[name]?.files), bytes: num(stats?.[name]?.bytes) };
    const want = { files: num(expected[name]?.files), bytes: num(expected[name]?.bytes) };
    if (got.files !== want.files || got.bytes !== want.bytes) {
      problems.push(
        `category "${name}" has ${got.files} file(s) / ${got.bytes} B, the transcript gives ${want.files} / ${want.bytes} B`,
      );
    }
  }
  return problems;
}

/** `YYYY-MM-DD` (UTC) of `d`. */
function day(d) {
  return d.toISOString().slice(0, 10);
}

/** The session's TimelineSession from the personal analytics timeline (yesterday … tomorrow). */
async function timelineSession(api, repoId, sessionId) {
  const now = Date.now();
  const q = `startDate=${day(new Date(now - DAY_MS))}&endDate=${day(new Date(now + DAY_MS))}`;
  const rows = await api.getJson(`/api/v1/repositories/${repoId}/analytics/timeline?${q}`);
  const list = Array.isArray(rows) ? rows : Array.isArray(rows?.sessions) ? rows.sessions : [];
  return list.find((s) => s && s.sessionId === sessionId) ?? null;
}

async function shot(page, file, fullPage = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    await page.screenshot({ path: file, fullPage });
    return true;
  } catch {
    return false;
  }
}

/** Replaces the editor's rows with FC_CATEGORIES and saves; throws when the save is not confirmed. */
async function configureInUi(page, repoId, wanted) {
  await page.goto(`/#/repos/${repoId}?mtab=settings&stab=file-categories`);
  const addButton = page.getByRole('button', { name: 'Add category' });
  try {
    await addButton.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
  } catch {
    throw new Error('the File Categories editor did not load ("Add category" is not shown)');
  }
  // Remove whatever rows exist (an earlier override), then add one row per wanted category.
  const deleteButtons = page.locator('button[title="Delete category"]');
  while ((await deleteButtons.count()) > 0) await deleteButtons.first().click();
  for (let i = 0; i < wanted.length; i++) await addButton.click();
  const names = page.getByPlaceholder('Category name');
  const patterns = page.getByPlaceholder('Comma-separated patterns');
  if ((await names.count()) !== wanted.length) {
    throw new Error(`expected ${wanted.length} category rows after adding, found ${await names.count()}`);
  }
  for (let i = 0; i < wanted.length; i++) {
    await names.nth(i).fill(wanted[i].name);
    await patterns.nth(i).fill(wanted[i].patterns.join(', '));
  }

  const save = page.getByRole('button', { name: 'Save', exact: true });
  if (!(await save.isEnabled())) {
    const errors = await page.locator('p.text-destructive').allTextContents().catch(() => []);
    throw new Error(`Save is disabled after filling the categories${errors.length ? `: ${errors.join('; ')}` : ''}`);
  }
  const saved = page.waitForResponse(
    (res) => res.request().method() === 'PUT' && /\/api\/v1\/repositories\/\d+\/settings\/user$/.test(new URL(res.url()).pathname),
    { timeout: UI_TIMEOUT_MS },
  );
  await save.click();
  const res = await saved.catch(() => null);
  if (!res) throw new Error('no PUT …/settings/user request after pressing Save');
  if (!res.ok()) throw new Error(`saving the categories returned HTTP ${res.status()}`);
  await page.getByText('Unsaved changes').waitFor({ state: 'hidden', timeout: UI_TIMEOUT_MS }).catch(() => {});
  // The confirmed UI state: the saved rows are shown back with the wanted values.
  for (let i = 0; i < wanted.length; i++) {
    const v = await names.nth(i).inputValue();
    if (v !== wanted[i].name) throw new Error(`after saving, row ${i + 1} shows "${v}", expected "${wanted[i].name}"`);
  }
}

/**
 * Runs the FC check. `owner` = { email, password }; `repoId` = the owner's repository id;
 * `sessionId` = FC_SCENARIO's verified session id; `transcriptFile` = that session's local main
 * transcript and `repoRoots` = the repo root(s) its Read paths are relative to — the source of the
 * expected per-category stats (expectedFileStats). opts: { browser, fcDir, baseURL, log }.
 * Resolves { case, ac: [{ id, ok, detail }] } — never throws.
 */
export async function runFileCategories({
  browser, owner, repoId, sessionId, transcriptFile, repoRoots = [], fcDir, baseURL = STAND_URL, log = () => {},
}) {
  const wanted = FC_CATEGORIES;
  const problems = [];
  const evidence = [];
  const ac = [];
  const wantedText = wanted.map((c) => `${c.name} → ${c.patterns.join(', ')}`).join('; ');
  const expected = expectedFileStatsFromFile(transcriptFile, repoRoots, wanted);
  log(`expected stats from ${transcriptFile ?? 'no transcript'}: ${JSON.stringify(expected)}`);

  let context = null;
  try {
    if (repoId == null) throw new Error('the repository id is unknown (the repo was never ingested)');
    if (!sessionId) throw new Error('no verified session id to check the read stats of');

    const entry = await newUserContext(browser, { baseURL });
    context = entry.context;
    const page = entry.page;
    await login(page, owner);
    await acceptConsent(page);

    let uiError = null;
    try {
      await configureInUi(page, repoId, wanted);
      log(`categories saved through the UI: ${wantedText}`);
    } catch (err) {
      uiError = err.message;
      problems.push(`UI: ${err.message}`);
    }
    if (await shot(page, path.join(fcDir, 'settings.png'))) evidence.push({ label: 'file-categories settings', path: 'FC/settings.png' });

    const api = createApiClient(baseURL);
    await api.login(owner.email, owner.password);
    const settings = await api.getJson(`/api/v1/repositories/${repoId}/settings`);
    const cfgProblems = compareCategories(settings?.userConfig?.fileCategories ?? settings?.effectiveConfig?.fileCategories);
    ac.push({
      id: 'FR-FC1',
      ok: !uiError && cfgProblems.length === 0,
      detail: uiError ? `UI save failed: ${uiError}` : cfgProblems.length ? cfgProblems.join('; ') : `settings return ${wantedText}`,
    });
    problems.push(...cfgProblems);

    let statsProblems = ['not checked'];
    let stats = null;
    const deadline = Date.now() + FC_STATS_TIMEOUT_MS;
    for (;;) {
      const s = await timelineSession(api, repoId, sessionId);
      stats = s?.fileStatsByCategory ?? null;
      statsProblems = s ? judgeFileStats(stats, expected) : [`session ${sessionId} is not in the analytics timeline`];
      if (statsProblems.length === 0 || Date.now() + POLL_MS > deadline) break;
      await sleep(POLL_MS);
    }
    if (statsProblems.length && stats) statsProblems.push(`observed fileStatsByCategory ${JSON.stringify(stats)}`);
    ac.push({
      id: 'FR-FC2',
      ok: statsProblems.length === 0,
      detail: statsProblems.length
        ? statsProblems.join('; ')
        : `session ${sessionId} fileStatsByCategory ${JSON.stringify(stats)} = the transcript's Read calls and tool-result sizes`,
    });
    problems.push(...statsProblems);

    await page.goto(`/#/repos/${repoId}?mtab=analytics&av=files`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(1500);
    if (await shot(page, path.join(fcDir, 'analytics-files.png'), true)) {
      evidence.push({ label: 'analytics files by category', path: 'FC/analytics-files.png' });
    }

    const status = problems.length ? 'fail' : 'pass';
    return {
      case: {
        id: 'FC',
        title: 'file categories configured in the UI and applied to read stats',
        status,
        detail: status === 'pass' ? `${wantedText}; ${JSON.stringify(stats)}` : problems.join('; '),
        checked: `owner saved ${wantedText} in Settings → File Categories; the API returns it; session ${sessionId} has reads under both categories ${JSON.stringify(stats)}, equal per category (files, bytes) to the Read calls and tool-result text lengths of its transcript ${JSON.stringify(expected)}.`,
        problems,
        evidence,
      },
      ac,
    };
  } catch (err) {
    problems.push(err.message);
    for (const id of ['FR-FC1', 'FR-FC2']) {
      if (!ac.some((a) => a.id === id)) ac.push({ id, ok: false, detail: `not evaluated: ${err.message}` });
    }
    return {
      case: { id: 'FC', title: 'file categories configured in the UI and applied to read stats', status: 'fail', detail: err.message, problems, evidence },
      ac,
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
