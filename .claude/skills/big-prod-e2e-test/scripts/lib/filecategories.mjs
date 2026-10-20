// File categories check `FC` (phase P9b). The repo owner replaces the repo's file
// categories through the UI (Repository settings → "File Categories", `FileCategoriesEditor.tsx`,
// personal view → the user-scoped override), then the API must return exactly that config (AC
// FR-FC1) and FC_SCENARIO's session must carry read stats under both new categories (AC FR-FC2).
// Saving triggers the server's recomputeForRepo(), so running after ingestion is fine.
import fs from 'node:fs';
import path from 'node:path';
import { acceptConsent, login, newUserContext } from './browser.mjs';
import { createApiClient } from './api.mjs';
import { FC_CATEGORIES, FC_STATS_TIMEOUT_MS, STAND_URL } from './config.mjs';

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

/** Pure: problems for one session's `fileStatsByCategory` (each wanted category needs files ≥ 1). */
export function judgeFileStats(stats, wanted = FC_CATEGORIES) {
  const problems = [];
  for (const c of wanted) {
    const files = Number(stats?.[c.name]?.files) || 0;
    if (files < 1) problems.push(`category "${c.name}" has ${files} file read(s), expected ≥ 1`);
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
 * `sessionId` = FC_SCENARIO's verified session id. opts: { browser, fcDir, baseURL, log }.
 * Resolves { case, ac: [{ id, ok, detail }] } — never throws.
 */
export async function runFileCategories({ browser, owner, repoId, sessionId, fcDir, baseURL = STAND_URL, log = () => {} }) {
  const wanted = FC_CATEGORIES;
  const problems = [];
  const evidence = [];
  const ac = [];
  const wantedText = wanted.map((c) => `${c.name} → ${c.patterns.join(', ')}`).join('; ');

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
      statsProblems = s ? judgeFileStats(stats) : [`session ${sessionId} is not in the analytics timeline`];
      if (statsProblems.length === 0 || Date.now() + POLL_MS > deadline) break;
      await sleep(POLL_MS);
    }
    if (statsProblems.length && stats) statsProblems.push(`observed fileStatsByCategory ${JSON.stringify(stats)}`);
    ac.push({
      id: 'FR-FC2',
      ok: statsProblems.length === 0,
      detail: statsProblems.length ? statsProblems.join('; ') : `session ${sessionId} fileStatsByCategory ${JSON.stringify(stats)}`,
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
        checked: `owner saved ${wantedText} in Settings → File Categories; the API returns it; session ${sessionId} has reads under both categories ${JSON.stringify(stats)}.`,
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
