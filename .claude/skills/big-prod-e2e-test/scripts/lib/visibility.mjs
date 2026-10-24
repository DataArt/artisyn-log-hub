// FR-9b visibility rows V1–V8, scripted Playwright in one fresh context per
// viewer. Personal-view rows are judged only by the left-nav "My Repos" list; team rows expand the
// team in the nav, open the linked repo, look for the session in the team-scoped session list and
// open it on `tab=logs`. V8 (admin) also opens another user's session URL directly (the first of
// S1/S5/S6/S3 its owner can open) and expects a 403 from the logs API and no session content. AC FR-7's "each repo visible to its owner" half comes from
// V1–V3.
import fs from 'node:fs';
import path from 'node:path';
import { createApiClient } from './api.mjs';
import { acceptConsent, login, newUserContext } from './browser.mjs';
import {
  LEGACY_OWNER,
  LEGACY_REPO,
  PROMPT_PREFIX_LEN,
  REPOS,
  STAND_URL,
  STORED_URL,
  resolveRun,
} from './config.mjs';
import { SESSION_STATUS } from './sessions.mjs';
import { SCENARIOS } from '../scenarios.mjs';

const UI_TIMEOUT_MS = 20000;
const LIST_SETTLE_MS = 15000;
const POLL_MS = 250;
// How long V8 watches a directly opened session page for leaked turn content.
const DIRECT_SETTLE_MS = 5000;
// V8's directly opened session: the first of these the owner can open (HTTP 200), one per owner and
// repo, so a product bug that loses one repo's sessions does not stop the check from running.
export const DIRECT_SESSION_CANDIDATES = Object.freeze(['S1', 'S5', 'S6', 'S3']);
const OK_SESSION_STATUSES = new Set(['pass', 'scenario not exercised']);
// SessionListPanel's empty state. In the default "By branch" view the client only requests a
// per-branch session list when `/sessions/branches` returns a branch, so an empty team view
// (a restricted member seeing nothing) never issues a `/sessions?teamId=…` request at all.
const EMPTY_LIST_TEXT = 'No sessions found for this repository';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The V1–V8 matrix. `team`/`repo` only for team views; `see` / `notSee` list repos (personal
 * views) or scenario ids (team views) that must or must not appear; `prompts` are the scenario ids
 * whose prompt must be visible. `directSession` (V8) is the scenario whose session URL the viewer
 * opens directly and must be refused (Design Decision 15).
 */
export const VISIBILITY_ROWS = Object.freeze([
  { id: 'V1', viewer: 'U1', view: 'personal', see: ['node-service', 'ts-webapp', 'java-lib'], notSee: ['js-cli', 'dotnet-api', LEGACY_REPO] },
  { id: 'V2', viewer: 'U2', view: 'personal', see: ['js-cli'], notSee: ['node-service', 'ts-webapp', 'java-lib', 'dotnet-api', LEGACY_REPO] },
  { id: 'V3', viewer: 'U3', view: 'personal', see: ['dotnet-api', LEGACY_REPO], notSee: ['node-service', 'ts-webapp', 'java-lib', 'js-cli'] },
  { id: 'V4', viewer: 'U1', view: 'team', team: 'T-restricted', repo: 'js-cli', see: ['S5', 'S8'], notSee: [], prompts: ['S5', 'S8'] },
  { id: 'V5', viewer: 'U2', view: 'team', team: 'T-restricted', repo: 'node-service', see: [], notSee: ['S1', 'S2'], prompts: [] },
  { id: 'V6', viewer: 'U2', view: 'team', team: 'T-transparent', repo: 'dotnet-api', see: ['S6', 'S7'], notSee: [], prompts: ['S6', 'S7'] },
  { id: 'V7', viewer: 'U3', view: 'team', team: 'T-transparent', repo: 'js-cli', see: ['S5', 'S8'], notSee: [], prompts: ['S5', 'S8'] },
  {
    id: 'V8',
    viewer: 'admin',
    view: 'personal',
    see: [],
    notSee: [...Object.keys(REPOS), LEGACY_REPO],
    directSession: DIRECT_SESSION_CANDIDATES,
  },
].map((r) => Object.freeze(r)));

/** Personal rows that carry the AC FR-7 "each repo visible to its owner" half. */
export const OWNER_VISIBILITY_ROWS = Object.freeze(['V1', 'V2', 'V3']);

/** Whitespace-normalized text, for prompt prefix matching. */
export function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** First PROMPT_PREFIX_LEN chars of a prompt, whitespace-normalized. */
export function promptPrefix(prompt, len = PROMPT_PREFIX_LEN) {
  return normalizeText(prompt).slice(0, len).trim();
}

/** Pure judgement of a personal-view row against the repo URLs listed under "My Repos". */
export function judgePersonal(row, listedUrls) {
  const listed = new Set(listedUrls);
  const missing = row.see.filter((r) => !listed.has(STORED_URL(r)));
  const leaked = row.notSee.filter((r) => listed.has(STORED_URL(r)));
  const parts = [];
  if (missing.length) parts.push(`not shown: ${missing.join(', ')}`);
  if (leaked.length) parts.push(`shown but must not be: ${leaked.join(', ')}`);
  return {
    status: parts.length ? 'fail' : 'pass',
    missing,
    leaked,
    detail: parts.length
      ? parts.join('; ')
      : `My Repos shows ${row.see.join(', ') || 'no test repo'} and none of ${row.notSee.join(', ') || '—'}`,
  };
}

/**
 * Derives AC FR-7's visibility half from the V1–V3 "must see" results: every repo is listed under
 * its owner's My Repos. `rows` are the report rows plus their `missing` list.
 */
export function ownerVisibilityCheck(rows) {
  const problems = [];
  for (const id of OWNER_VISIBILITY_ROWS) {
    const def = VISIBILITY_ROWS.find((r) => r.id === id);
    const row = rows.find((r) => r.id === id);
    if (!row) {
      problems.push(`${id} not evaluated`);
      continue;
    }
    const missing = Array.isArray(row.missing) ? row.missing : row.status === 'pass' ? [] : null;
    if (missing === null) problems.push(`${id} (${def.viewer}) could not be judged: ${row.detail}`);
    else if (missing.length) problems.push(`${def.viewer} does not see own ${missing.join(', ')}`);
  }
  // Every repo, the legacy-hook repo included, must be covered by its owner's row.
  for (const [repo, owner] of Object.entries({ ...REPOS, [LEGACY_REPO]: LEGACY_OWNER })) {
    const def = VISIBILITY_ROWS.find((r) => OWNER_VISIBILITY_ROWS.includes(r.id) && r.viewer === owner);
    if (!def || !def.see.includes(repo)) problems.push(`no owner row covers ${repo}`);
  }
  return {
    id: 'FR-7',
    part: 'owner-visibility',
    status: problems.length ? 'fail' : 'pass',
    detail: problems.length ? problems.join('; ') : 'each repo is listed under its owner\'s My Repos (V1–V3)',
  };
}

/** Scenario id → { status, sessionId (verified one), allSessionIds, prompt }. */
export function indexSessions(sessions) {
  const map = new Map();
  for (const s of sessions || []) {
    if (!s || !s.id) continue;
    const attemptIds = Array.isArray(s.attempts) ? s.attempts.map((a) => a && a.session_id).filter(Boolean) : [];
    const listed = Array.isArray(s.sessionIds) ? s.sessionIds.filter(Boolean) : [];
    const all = [...new Set([...attemptIds, ...listed, ...(s.expected?.session_id ? [s.expected.session_id] : [])])];
    const sessionId = s.expected?.session_id ?? all[all.length - 1] ?? null;
    const scenario = SCENARIOS.find((x) => x.id === s.id);
    map.set(s.id, {
      status: s.status ?? null,
      sessionId,
      allSessionIds: all,
      prompt: s.expected?.prompt ?? scenario?.prompt ?? '',
    });
  }
  return map;
}

function relShot(name) {
  return `visibility/${name}`;
}

function viewLabel(row) {
  return row.view === 'personal' ? 'personal' : `${row.team} / ${row.repo}`;
}

/** The left nav (`AppLeftNav`) — the only `nav` holding the "Add Team" button. */
function leftNav(page) {
  return page.locator('nav', { hasText: 'Add Team' }).first();
}

/** Repo URLs listed in the left nav's "My Repos" section ([] when the section is not rendered). */
async function readMyRepos(page) {
  return page.evaluate(() => {
    const navs = [...document.querySelectorAll('nav')];
    for (const nav of navs) {
      const header = [...nav.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'My Repos');
      if (!header) continue;
      const list = header.nextElementSibling;
      if (!list) return [];
      return [...list.querySelectorAll(':scope > button')].map((b) => (b.textContent || '').trim());
    }
    return [];
  });
}

async function evaluatePersonal(page, row) {
  await page.goto('/#/main');
  await leftNav(page).waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
  const wanted = row.see.map((r) => STORED_URL(r));
  const deadline = Date.now() + LIST_SETTLE_MS;
  let listed = await readMyRepos(page);
  while (Date.now() < deadline && !wanted.every((u) => listed.includes(u))) {
    await sleep(POLL_MS);
    listed = await readMyRepos(page);
  }
  const verdict = judgePersonal(row, listed);
  return { ...verdict, detail: `${verdict.detail} (listed: ${listed.join(', ') || 'none'})`, shotTarget: leftNav(page) };
}

/**
 * The first `candidates` scenario whose owner gets HTTP 200 on its session logs: proof the session
 * is on the server, so the viewer's 403 below means "refused", not "no such session".
 * Resolves { pick: { sid, rid, info } | null, tried: string[] } — `tried` explains each skip.
 */
async function pickDirectSession(candidates, state, sessionIndex, baseURL) {
  const tried = [];
  for (const sid of candidates) {
    const info = sessionIndex.get(sid);
    const repo = SCENARIOS.find((s) => s.id === sid)?.repo;
    const rid = state.repos?.[repo]?.repoId ?? null;
    const owner = state.users?.[REPOS[repo]];
    if (!info?.sessionId) tried.push(`${sid}: no session id`);
    else if (rid == null) tried.push(`${sid}: ${repo} has no repo id`);
    else if (!owner?.email || !owner?.password) tried.push(`${sid}: no credentials for owner ${REPOS[repo]}`);
    else {
      try {
        const api = createApiClient(baseURL);
        await api.login(owner.email, owner.password);
        const { status } = await api.getSessionLogs(rid, info.sessionId);
        if (status === 200) return { pick: { sid, rid, info }, tried };
        tried.push(`${sid}: owner ${REPOS[repo]} got HTTP ${status}`);
      } catch (err) {
        tried.push(`${sid}: owner check failed: ${err.message}`);
      }
    }
  }
  return { pick: null, tried };
}

/**
 * V8 second half (Design Decision 15): picks a session the owner can open (`def.directSession`
 * candidates), then as `def.viewer` (admin) (a) its logs API answers 403, and (b) its URL, opened
 * directly, shows none of its first prompt. Resolves { problems, detail }.
 */
export async function evaluateDirectSession(page, def, state, sessionIndex, baseURL) {
  const problems = [];
  const user = state.users?.[def.viewer];
  if (!user || !user.email || !user.password) {
    return { problems: [`no credentials for ${def.viewer} in run state`], detail: '' };
  }
  const { pick, tried } = await pickDirectSession(def.directSession, state, sessionIndex, baseURL);
  if (!pick) {
    return { problems: [`no direct-URL candidate is on the server (${tried.join('; ')})`], detail: '' };
  }
  const { sid, rid, info } = pick;

  // (a) API: the admin has no access to another user's private repo.
  let apiStatus = null;
  try {
    const api = createApiClient(baseURL);
    await api.login(user.email, user.password);
    ({ status: apiStatus } = await api.getSessionLogs(rid, info.sessionId));
    if (apiStatus !== 403) {
      problems.push(`${sid} logs API as ${def.viewer} returned HTTP ${apiStatus}, expected 403`);
    }
  } catch (err) {
    problems.push(`${def.viewer} API check failed: ${err.message}`);
  }

  // (b) UI: the direct URL renders none of the session's turn content.
  const prefix = promptPrefix(info.prompt);
  if (!prefix) {
    problems.push(`${sid} has no prompt to look for`);
  } else {
    await page.goto(`/#/repos/${encodeURIComponent(rid)}?session=${encodeURIComponent(info.sessionId)}&tab=logs`);
    await leftNav(page).waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS }).catch(() => {});
    const deadline = Date.now() + DIRECT_SETTLE_MS;
    let leaked = await logsShowPrompt(page, prefix);
    while (!leaked && Date.now() < deadline) {
      await sleep(POLL_MS);
      leaked = await logsShowPrompt(page, prefix);
    }
    if (leaked) problems.push(`${sid} opened directly shows its first prompt "${prefix}"`);
  }
  return {
    problems,
    detail: problems.length
      ? ''
      : `direct ${sid} URL: owner HTTP 200, ${def.viewer} logs API HTTP ${apiStatus}, no session content shown` +
        `${tried.length ? ` (skipped ${tried.join('; ')})` : ''}`,
  };
}

/** The team's header row in the nav: a div holding the expand toggle and the team-name button. */
function teamNavRow(page, teamName) {
  return leftNav(page).locator(
    `xpath=.//div[button[.//span[normalize-space(.)=${xpathLiteral(teamName)}]]]`,
  ).first();
}

function xpathLiteral(s) {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.replace(/'/g, "',\"'\",'")}')`;
}

function isSessionsListResponse(res, teamId) {
  try {
    const u = new URL(res.url());
    return (
      res.request().method() === 'GET' &&
      /^\/api\/v1\/repositories\/\d+\/sessions$/.test(u.pathname) &&
      u.searchParams.get('teamId') === String(teamId)
    );
  } catch {
    return false;
  }
}

/** True when a prompt-turn trigger on the logs tab (outside the session list) contains `prefix`. */
async function logsShowPrompt(page, prefix) {
  return page.evaluate((needle) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const buttons = [...document.querySelectorAll('button')].filter((b) => !b.closest('[data-testid="session-item"]'));
    return buttons.some((b) => norm(b.textContent).includes(needle));
  }, prefix);
}

async function evaluateTeam(page, row, state, sessionIndex) {
  const team = state.teams?.[row.team];
  if (!team || team.id == null) throw new Error(`team ${row.team} has no id in run state`);
  const storedUrl = state.repos?.[row.repo]?.storedUrl ?? STORED_URL(row.repo);

  // Open the team page so the nav is loaded, then expand the team in the nav.
  await page.goto(`/#/teams/${team.id}`);
  await leftNav(page).waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
  const navRow = teamNavRow(page, row.team);
  try {
    await navRow.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
  } catch {
    throw new Error(`team ${row.team} is not listed in the left nav`);
  }
  const expand = navRow.getByRole('button', { name: 'Expand', exact: true });
  if ((await expand.count()) > 0) await expand.first().click();

  const repoButton = navRow
    .locator(`xpath=following-sibling::div[1]/button[normalize-space(.)=${xpathLiteral(storedUrl)}]`)
    .first();
  try {
    await repoButton.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
  } catch {
    throw new Error(`repo ${storedUrl} is not listed under team ${row.team} in the left nav`);
  }

  const listResponse = page.waitForResponse((res) => isSessionsListResponse(res, team.id), { timeout: UI_TIMEOUT_MS });
  listResponse.catch(() => {});
  const emptyState = page
    .getByText(EMPTY_LIST_TEXT, { exact: true })
    .waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS })
    .then(() => 'empty');
  emptyState.catch(() => {});
  await repoButton.click();
  let outcome;
  try {
    outcome = await Promise.any([listResponse, emptyState]);
  } catch {
    throw new Error(`no team-scoped session list was loaded for ${row.repo} in ${row.team}`);
  }
  const m = new URL(page.url()).hash.match(/^#\/teams\/(\d+)\/repos\/(\d+)/);
  if (!m) throw new Error(`clicking ${storedUrl} did not open the team repo (at ${page.url()})`);
  const repoId = Number(m[2]);
  let listed = [];
  if (outcome !== 'empty') {
    if (!outcome.ok()) throw new Error(`team session list returned HTTP ${outcome.status()}`);
    listed = await outcome.json().catch(() => null);
    if (!Array.isArray(listed)) throw new Error('team session list is not an array');
  }
  const listedIds = new Set(listed.map((s) => s && s.sessionId).filter(Boolean));
  await page.getByTestId('session-item').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const itemCount = await page.getByTestId('session-item').count();

  const problems = [];
  const notes = [];

  for (const sid of row.notSee) {
    const info = sessionIndex.get(sid);
    const ids = info?.allSessionIds ?? [];
    if (ids.length === 0) {
      notes.push(`${sid} has no session id to look for`);
      continue;
    }
    const leaked = ids.filter((id) => listedIds.has(id));
    if (leaked.length) problems.push(`${sid} session(s) ${leaked.join(', ')} listed but must not be`);
  }

  for (const sid of row.see) {
    const info = sessionIndex.get(sid);
    if (!info || !info.sessionId) {
      problems.push(`${sid} has no session id to look for`);
      continue;
    }
    if (!listedIds.has(info.sessionId)) {
      problems.push(`${sid} session ${info.sessionId} is not in the session list (${listedIds.size} listed, ${itemCount} rows)`);
      continue;
    }
    if (itemCount === 0) {
      problems.push(`${sid} session is in the list data but no session row is rendered`);
      continue;
    }
    if ((row.prompts || []).includes(sid)) {
      const prefix = promptPrefix(info.prompt);
      await page.goto(`/#/teams/${team.id}/repos/${repoId}?session=${encodeURIComponent(info.sessionId)}&tab=logs`);
      const deadline = Date.now() + UI_TIMEOUT_MS;
      let shown = await logsShowPrompt(page, prefix);
      while (!shown && Date.now() < deadline) {
        await sleep(POLL_MS);
        shown = await logsShowPrompt(page, prefix);
      }
      if (!shown) problems.push(`${sid} opened, but the first user message does not show "${prefix}"`);
    }
  }

  const status = problems.length ? 'fail' : 'pass';
  let detail;
  if (problems.length) detail = problems.join('; ');
  else {
    const parts = [];
    if (row.see.length) parts.push(`sees ${row.see.join(', ')}`);
    if (row.prompts?.length) parts.push(`prompt visible for ${row.prompts.join(', ')}`);
    if (row.notSee.length) parts.push(`does not see ${row.notSee.join(', ')}`);
    detail = `${parts.join('; ')} (${listedIds.size} session(s) listed)`;
  }
  if (notes.length) detail += `; note: ${notes.join('; ')}`;
  // Evidence is the viewport: the opened session's logs tab, or the session list.
  return { status, detail, shotTarget: null };
}

async function screenshot(target, page, file, fullPage) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (target) await target.screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: Boolean(fullPage) });
    return true;
  } catch {
    try {
      await page.screenshot({ path: file, fullPage: Boolean(fullPage) });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Pure: why a row could not see anything it expected to — the ids in its `see` list when EVERY one
 * of them is blocked: a session (team view) whose status is "not ingested" or whose repo has no
 * repo id, a repo (personal view) with no repo id. null when `see` is empty or anything in it was
 * not blocked. The row keeps its own status; this only explains a failure.
 */
export function blockedBy(row, state, sessionIndex) {
  const see = row.see ?? [];
  if (see.length === 0) return null;
  const noRepoId = (repo) => (state?.repos?.[repo]?.repoId ?? null) == null;
  const blocked = see.filter((id) => {
    if (row.view === 'personal') return noRepoId(id);
    const repo = SCENARIOS.find((s) => s.id === id)?.repo;
    return sessionIndex.get(id)?.status === SESSION_STATUS.notIngested || (repo != null && noRepoId(repo));
  });
  return blocked.length === see.length ? blocked : null;
}

/** Pure: `detail` prefixed with "blocked by <ids> (not ingested) — " when the failed row is blocked. */
export function withBlockedBy(detail, status, blocked) {
  if (status === 'pass' || !blocked || blocked.length === 0) return detail;
  return `blocked by ${blocked.join(', ')} (not ingested) — ${detail}`;
}

/** Notes rows whose referenced sessions did not end `pass` / `scenario not exercised`. */
function sessionNotes(row, sessionIndex) {
  if (row.view === 'personal') return [];
  const notes = [];
  for (const sid of [...row.see, ...row.notSee]) {
    const info = sessionIndex.get(sid);
    if (!info) notes.push(`${sid} did not run`);
    else if (!OK_SESSION_STATUSES.has(info.status)) notes.push(`${sid} is "${info.status}"`);
  }
  return notes;
}

/**
 * Evaluates V1–V8. `browser` is a launched chromium; `state` is the run state (users with
 * passwords, repos, teams with ids); `sessions` are the scenario results (each with `id`,
 * `status`, `attempts[]` and `expected`).
 * opts (optional): { visibilityDir, baseURL, log }
 *
 * Every row saves `_report/visibility/<row>.png` as evidence; a failing row also saves a full-page
 * `<row>-fail.png`. Resolves { rows, acCheck } where `rows` are report rows and `acCheck` is the
 * AC FR-7 owner-visibility half (see ownerVisibilityCheck).
 */
export async function runVisibility(browser, state, sessions, opts = {}) {
  const visibilityDir = opts.visibilityDir ?? resolveRun(state.stamp).visibilityDir;
  const baseURL = opts.baseURL ?? state.standUrl ?? STAND_URL;
  const log = opts.log ?? (() => {});
  const sessionIndex = indexSessions(sessions);
  fs.mkdirSync(visibilityDir, { recursive: true });

  const contexts = new Map();
  const pageFor = async (viewer) => {
    if (contexts.has(viewer)) {
      const cached = contexts.get(viewer);
      if (cached.error) throw cached.error;
      return cached;
    }
    const user = state.users?.[viewer];
    if (!user || !user.email || !user.password) throw new Error(`no credentials for ${viewer} in run state`);
    const entry = await newUserContext(browser, { baseURL });
    contexts.set(viewer, entry);
    try {
      await login(entry.page, { email: user.email, password: user.password });
      await acceptConsent(entry.page);
    } catch (err) {
      // Remembered, so the viewer's later rows fail fast with the same reason.
      entry.error = new Error(`${viewer} could not log in: ${err.message}`);
      throw entry.error;
    }
    return entry;
  };

  const rows = [];
  try {
    for (const def of VISIBILITY_ROWS) {
      const shotName = `${def.id}.png`;
      const failName = `${def.id}-fail.png`;
      const row = {
        id: def.id,
        viewer: def.viewer,
        view: viewLabel(def),
        shouldSee: def.view === 'personal' ? def.see.map((r) => STORED_URL(r)) : [...def.see],
        shouldNotSee: def.view === 'personal' ? def.notSee.map((r) => STORED_URL(r)) : [...def.notSee],
        prompts: def.prompts && def.prompts.length ? [...def.prompts] : null,
        status: 'fail',
        detail: '',
        screenshot: null,
        failScreenshot: null,
      };
      let page = null;
      let shotTarget = null;
      try {
        ({ page } = await pageFor(def.viewer));
        const result =
          def.view === 'personal' ? await evaluatePersonal(page, def) : await evaluateTeam(page, def, state, sessionIndex);
        row.status = result.status;
        row.detail = result.detail;
        if (def.view === 'personal') row.missing = result.missing;
        shotTarget = result.shotTarget ?? null;
        if (def.directSession) {
          const direct = await evaluateDirectSession(page, def, state, sessionIndex, baseURL);
          if (direct.problems.length) {
            row.status = 'fail';
            row.detail = `${row.detail}; ${direct.problems.join('; ')}`;
          } else {
            row.detail = `${row.detail}; ${direct.detail}`;
          }
          // Evidence is the viewport: the directly opened session URL.
          shotTarget = null;
        }
      } catch (err) {
        row.status = 'fail';
        row.detail = err.message;
        if (def.view === 'personal') row.missing = null;
        page = page ?? contexts.get(def.viewer)?.page ?? null;
      }

      const notes = sessionNotes(def, sessionIndex);
      if (notes.length) row.detail = `${row.detail}${row.detail ? '; ' : ''}session note: ${notes.join('; ')}`;
      row.detail = withBlockedBy(row.detail, row.status, blockedBy(def, state, sessionIndex));

      if (page) {
        if (await screenshot(shotTarget, page, path.join(visibilityDir, shotName), false)) row.screenshot = relShot(shotName);
        if (row.status !== 'pass' && (await screenshot(null, page, path.join(visibilityDir, failName), true))) {
          row.failScreenshot = relShot(failName);
        }
      }
      log(`${def.id} (${def.viewer}, ${row.view}): ${row.status} — ${row.detail}`);
      rows.push(row);
    }
  } finally {
    for (const { context } of contexts.values()) {
      await context.close().catch(() => {});
    }
  }

  const acCheck = ownerVisibilityCheck(rows);
  for (const r of rows) delete r.missing;
  return { rows, acCheck };
}
