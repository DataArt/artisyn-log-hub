#!/usr/bin/env node
// Records the Log Hub demo media for the site home carousel and the README tour GIF
// (task 2026-11-03-app-demo-gif): the tour GIF, still PNGs, short GIF clips, their first frames,
// thumbnails and the manifest items.json, all under site/assets/demo/.
//
// Manual tool: run by hand against an already running Log Hub (`npm run record:demo -- <mode>`).
// It is not part of build:site, the build or any health check.
//
// Read-only: the script never starts a server and only issues POST /api/v1/auth/identify (auth
// mode `none`), GET /api/v1/teams (team names for presentation mode) and GET navigation in a
// headless Chromium. It never writes anything to the app.
//
// Usage: node scripts/site/record-demo.mjs <tour|items|all> [--only <id>[,<id>]]
//   tour    the README / carousel tour GIF (catalog id `app-tour`)
//   items   the carousel stills and clips
//   all     both
//   --only  restrict the run to these catalog ids (each must belong to the chosen mode)
//
// Env (all required, no defaults; never written to tracked files):
//   LOGHUB_URL      base URL of the running Log Hub (http or https)
//   LOGHUB_EMAIL    e-mail of the demo repository's owner (identify-only login)
//   LOGHUB_REPO     id of the demo repository
//   SESSION_COST    a costly session with English prompts
//   SESSION_AGENTS  a session with a workflow and sub-agents
//
// Output guard: the output folder is fixed — site/assets/demo/ and its thumbs/ (resolved from this
// script's location) — and created when missing. The script writes only the file names derived from
// the scene catalog plus items.json, never deletes anything, and prints a warning listing any other
// file it finds there (stale media left for a human to remove). Its only other write is the
// thumbnail renderer page tmp/record-demo/thumb.html (gitignored tmp/).
//
// Budgets (a violation fails the item and its files are not written): tour GIF <= 5,000,000 bytes
// and 22–28 s, clip GIF <= 3,000,000 bytes and 5–8 s, still <= 600,000 bytes; every catalog file
// in site/assets/demo/ together <= 25,000,000 bytes (checked after writing).
//
// Clean-frame guard: after every scene open and every clip action the visible text must contain no
// Cyrillic, no "Loading" placeholder, no local absolute path and no e-mail other than the neutral
// dev@example.com. Presentation mode also rewrites every team name of the identified user (free
// text, often a person's name) to "Team A", "Team B", … A failed guard fails that scene; every
// scene error is collected and printed at the end.
//
// ESM exemption from the nodejs-script CJS/sync rule: Playwright is async-only and gifenc ships as
// ESM (precedent: scripts/site/build-site.mjs). Everything else follows the rule — sync file I/O,
// path.join, diagnostics on stderr, explicit exit codes. The Chromium browser is the one
// `npx playwright install chromium` already provides for the scenario suite.
//
// Exit codes: 0 every scene written, 1 a scene failed (all scene errors printed), 2 bad arguments
// or environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'site', 'assets', 'demo');
const THUMBS_DIR = path.join(OUT_DIR, 'thumbs');
const MANIFEST = 'items.json';
// Scratch folder for the thumbnail renderer page (gitignored tmp/, never under site/).
const TMP_DIR = path.join(REPO_ROOT, 'tmp', 'record-demo');
// Paths in items.json are relative to the site root.
const SITE_PREFIX = 'assets/demo/';

const TOUR_ID = 'app-tour';
const MODES = ['tour', 'items', 'all'];

const BASE_W = 1280;
const BASE_H = 800;
const MAX_FIT = 1.5;
const NEUTRAL_EMAIL = 'dev@example.com';

// Output geometry (Design Decisions 6–7): stills 2560x1600 (DPR 2), GIFs 960x600 (DPR 0.75).
const STILL_W = 2560;
const STILL_H = 1600;
const GIF_W = 960;
const GIF_H = 600;
const THUMB_W = 256;
const THUMB_H = 160;
const THUMB_QUALITY = 80;
const MAX_FPS = 10;

// Budgets (Design Decision 10): a violation fails the item (its files are not written).
const TOUR_MAX_BYTES = 5_000_000;
const TOUR_MIN_MS = 22_000;
const TOUR_MAX_MS = 28_000;
const CLIP_MAX_BYTES = 3_000_000;
const CLIP_MIN_MS = 5_000;
const CLIP_MAX_MS = 8_000;
const STILL_MAX_BYTES = 600_000;
const TOTAL_BUDGET = 25_000_000;

const TOUR_ALT = 'Log Hub tour: repositories, sessions by cost, session summary, context growth, call tree, '
  + 'Session Map replay, change surface, cost by branch';

// ---------------------------------------------------------------------------------------------
// Arguments and environment

class UsageError extends Error {}

function parseArgs(argv) {
  const mode = argv[0];
  if (!MODES.includes(mode)) {
    throw new UsageError(`mode must be one of ${MODES.join('|')} (got ${mode === undefined ? 'nothing' : `"${mode}"`})`);
  }
  let only = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    let value;
    if (a === '--only') value = argv[++i];
    else if (a.startsWith('--only=')) value = a.slice('--only='.length);
    else throw new UsageError(`unknown argument "${a}"`);
    if (!value) throw new UsageError('--only needs a comma-separated list of catalog ids');
    only = [...(only ?? []), ...value.split(',').map((s) => s.trim()).filter(Boolean)];
    if (only.length === 0) throw new UsageError('--only needs a comma-separated list of catalog ids');
  }
  return { mode, only };
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readEnv(env) {
  const need = (name, check, what) => {
    const v = (env[name] ?? '').trim();
    if (!v) throw new UsageError(`${name} is not set (see the header of scripts/site/record-demo.mjs)`);
    if (!check(v)) throw new UsageError(`${name} is malformed: expected ${what}`);
    return v;
  };
  const isHttpUrl = (v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  };
  return {
    base: need('LOGHUB_URL', isHttpUrl, 'an http(s) URL').replace(/\/+$/, ''),
    email: need('LOGHUB_EMAIL', (v) => EMAIL_RE.test(v), 'an e-mail address'),
    repo: need('LOGHUB_REPO', (v) => ID_RE.test(v), 'a repository id'),
    sCost: need('SESSION_COST', (v) => ID_RE.test(v), 'a session id'),
    sAgents: need('SESSION_AGENTS', (v) => ID_RE.test(v), 'a session id'),
  };
}

// ---------------------------------------------------------------------------------------------
// Scene catalog (order = carousel order). `kind` is tour | still | clip.
//
// A scene opens `hash` (relative to LOGHUB_URL). GIF scenes (tour segments and clips) record for
// `hold` ms; their `actions` run at `at` ms into the hold. Recording pauses while an action runs
// and the page settles, so the GIF cuts straight from the frame before the action to the settled
// result (no loading or hover frame) and its play time equals the hold.
//
// Action kinds (`label` names the action in error messages):
//   click       { testId } | { roles: [...], name } (exact accessible name) | { text } | { css } — first match
//   sessionTab  { id }  a session tab by its id, opened from "More ▾" when it is not in the row
//   select      { trigger: RegExp, option }  open the combobox whose text matches, pick the option label
//   scroll      scroll the biggest scrollable content pane (not one starting in the left quarter,
//               i.e. the session list) by up to one pane height
//   wait        { testId } | { css }  wait until the target is visible (no click)
// A target that is not found fails the item with its id; nothing is skipped silently.

/** Every analytics view label (client/src/viewer/pages/repository/analytics/analytics-state.ts VIEW_OPTIONS). */
const VIEW_LABELS = ['Work Time', 'Cost', 'Files & Tools', 'Vision', 'MCP Invocations', 'Productivity', 'Log Lines',
  'Cache Read Ratio', 'Change Surface', 'Tool Analytics', 'Token Breakdown', 'Productivity Counters', 'Active Sessions'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VIEW_TRIGGER = new RegExp(`^(${VIEW_LABELS.map(escapeRe).join('|')})$`);
const GROUP_TRIGGER = /^(No grouping|Group by .+)$/;

const clickName = (name) => ({ do: 'click', roles: ['radio', 'button', 'tab'], name, label: `click "${name}"` });
const clickTestId = (testId) => ({ do: 'click', testId, label: `click ${testId}` });
const sessionTab = (id) => ({ do: 'sessionTab', id, label: `session tab ${id}` });
const pickView = (option) => ({ do: 'select', trigger: VIEW_TRIGGER, option, label: `view "${option}"` });
const pickGroup = (option) => ({ do: 'select', trigger: GROUP_TRIGGER, option, label: `group "${option}"` });
const at = (ms, action) => ({ ...action, at: ms });

const MAP_PLAY = 'session-map-play';
const SUMMARY_FIRST_OPEN = '[data-testid="summary-next-cards"] > div:not([data-dimmed]) [data-testid$="-open"]';
const CALL_TREE_COLLAPSED ='[data-testid="session-chart-call-tree"] tr.cursor-pointer:has(svg.transition-transform:not(.rotate-90))';

function buildCatalog(cfg) {
  const R = `#/repos/${cfg.repo}`;
  const sess = (id, tab) => `${R}?session=${id}${tab ? `&tab=${tab}` : ''}`;
  const S = cfg.sCost;
  const A = cfg.sAgents;
  const costRanked = `${R}?mtab=analytics&ar=1m&av=cost&al=horizontal`;
  const costByBranch = `${R}?mtab=analytics&ar=1m&ag=branch&av=cost`;

  // Design Decision 12: 8 scenes, plain cuts, holds total 25 s.
  const tour = {
    id: TOUR_ID,
    kind: 'tour',
    caption: 'A 25-second tour of Log Hub',
    where: 'Repositories, sessions and analytics',
    alt: TOUR_ALT,
    segments: [
      { id: 'tour-repos', hash: '#/', hold: 3000 },
      { id: 'tour-sessions-by-cost', hash: costRanked, hold: 3000 },
      { id: 'tour-summary', hash: sess(S), hold: 3000 },
      { id: 'tour-context-growth', hash: sess(S, 'context-growth'), hold: 3000 },
      { id: 'tour-call-tree', hash: sess(A, 'call-tree'), hold: 3000 },
      { id: 'tour-session-map', hash: sess(A, 'session-map'), hold: 4000,
        actions: [at(0, { do: 'wait', testId: MAP_PLAY, label: 'Play button' }), at(300, clickTestId(MAP_PLAY))] },
      { id: 'tour-change-surface', hash: sess(S, 'change-surface'), hold: 3000 },
      { id: 'tour-cost-by-branch', hash: costByBranch, hold: 3000 },
    ],
  };

  // Design Decision 13: 21 stills.
  const still = (id, hash, caption, where) => ({ id, kind: 'still', hash, caption, where });
  const stills = [
    still('repos', '#/', 'Repositories at a glance', 'Home'),
    still('sessions', R, 'Sessions grouped by branch', 'Repository → Sessions'),
    still('summary', sess(S), 'Summary tiles and where to look next', 'Session → Summary'),
    still('usage', sess(S, 'usage'), 'Token and cost usage of one session', 'Session → Usage'),
    still('dashboard', sess(S, 'dashboard'), 'Session dashboard', 'Session → Dashboard'),
    still('context-growth', sess(S, 'context-growth'), 'Context growth turn by turn', 'Session → Context Growth'),
    still('context-usage', sess(S, 'context-usage'), 'What fills the context window', 'Session → Context Usage'),
    still('sysctx', sess(S, 'sysctx'), 'Startup system context anatomy', 'Session → System context'),
    still('harness-usage', sess(A, 'harness-usage'), 'Harness elements per session', 'Session → Harness usage'),
    still('agent-tree', sess(A, 'agent-tree'), 'Agent tree with cost per agent', 'Session → Agent Tree'),
    still('call-tree', sess(A, 'call-tree'), 'Call tree of the session', 'Session → Call Tree'),
    still('timeline', sess(A, 'timeline'), 'Timeline of turns and agents', 'Session → Timeline'),
    still('tool-heatmap', sess(A, 'tool-heatmap'), 'Tool heatmap', 'Session → Tool Heatmap'),
    still('session-map', sess(A, 'session-map'), 'Session map of a workflow run', 'Session → Session Map'),
    still('change-surface', sess(S, 'change-surface'), 'Files and folders the session touched', 'Session → Change surface'),
    still('session-tools', sess(A, 'tools'), 'MCP and CLI tool calls of one session', 'Session → Tools'),
    still('analytics-cost-ranked', costRanked, 'Cost per session, ranked', 'Repository → Analytics → Cost'),
    still('analytics-cost-branch', costByBranch, 'Cost by branch', 'Repository → Analytics → Cost'),
    still('analytics-cache', `${R}?mtab=analytics&ar=1m&av=cache-read-ratio`, 'Cache read ratio over time', 'Repository → Analytics'),
    still('analytics-productivity', `${R}?mtab=analytics&ar=1m&av=productivity`, 'Productivity per session', 'Repository → Analytics'),
    still('repo-tools', `${R}?mtab=tools`, 'Tool and MCP analytics for the repo', 'Repository → Tools'),
  ];

  // Design Decision 13: 10 clips, 5–8 s each.
  const clip = (id, hash, hold, actions, caption, where) => ({ id, kind: 'clip', hash, hold, actions, caption, where });
  const clips = [
    clip('clip-map-replay', sess(A, 'session-map'), 7000,
      [at(0, { do: 'wait', testId: MAP_PLAY, label: 'Play button' }), at(0, clickName('60×')), at(500, clickTestId(MAP_PLAY))],
      'Replay a workflow run', 'Session → Session Map'),
    clip('clip-map-replay-fast', sess(A, 'session-map'), 6000,
      [at(0, { do: 'wait', testId: MAP_PLAY, label: 'Play button' }), at(0, clickName('300×')), at(500, clickTestId(MAP_PLAY))],
      'Replay at 300×', 'Session → Session Map'),
    clip('clip-session-tabs', sess(S), 7000,
      [at(1000, sessionTab('usage')), at(3000, sessionTab('context-growth')), at(5000, sessionTab('call-tree'))],
      'Switching session views', 'Session → tabs'),
    clip('clip-summary-jump', sess(S), 6000,
      [at(2000, { do: 'click', css: SUMMARY_FIRST_OPEN, label: 'first "Where to look next" card' })],
      'From summary to the answer', 'Session → Summary'),
    clip('clip-analytics-range', `${R}?mtab=analytics&av=cost`, 6000,
      [at(1500, clickName('1w')), at(3500, clickName('1m'))],
      'Changing the analytics range', 'Repository → Analytics'),
    clip('clip-analytics-group', `${R}?mtab=analytics&ar=1m&av=cost`, 6000,
      // "Group by user" exists only in a team context (AnalyticsControls.tsx), never on a
      // repository's own Analytics tab; the second pick is the repo's attribute grouping.
      [at(1500, pickGroup('Group by branch')), at(3500, pickGroup('Group by Workflow Stages'))],
      'Grouping cost by branch and workflow stage', 'Repository → Analytics'),
    clip('clip-analytics-metrics', `${R}?mtab=analytics&ar=1m`, 8000,
      [at(1000, pickView('Cost')), at(3500, pickView('Cache Read Ratio')), at(6000, pickView('Productivity'))],
      'Thirteen metrics, one chart', 'Repository → Analytics'),
    clip('clip-call-tree', sess(A, 'call-tree'), 6000,
      [at(1500, { do: 'click', css: CALL_TREE_COLLAPSED, label: 'expand collapsed row 1' }),
        at(3500, { do: 'click', css: CALL_TREE_COLLAPSED, label: 'expand collapsed row 2' })],
      'Drilling into the call tree', 'Session → Call Tree'),
    // Replaces the planned Logs-tab scroll: the Logs tab prints the raw agent prompts, which carry
    // the developer's absolute paths (AC-2), and a one-prompt transcript does not overflow anyway.
    clip('clip-context-agents', sess(S, 'context-usage'), 7000,
      [at(1000, clickName('Agent 1')), at(3000, clickName('Agent 2')), at(5000, clickName('Agent 3'))],
      'What each agent loads into its context', 'Session → Context Usage'),
    clip('clip-repo-tabs', R, 7000,
      [at(1000, clickTestId('tab-repo-analytics')), at(3000, clickTestId('tab-repo-tools')), at(5000, clickTestId('tab-repo-sessions'))],
      'Repository views', 'Repository → tabs'),
  ];

  return [tour, ...stills, ...clips];
}

function selectScenes(catalog, mode, only) {
  const inMode = catalog.filter((s) => mode === 'all' || (mode === 'tour' ? s.kind === 'tour' : s.kind !== 'tour'));
  if (!only) return inMode;
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const modeIds = new Set(inMode.map((s) => s.id));
  for (const id of only) {
    if (!byId.has(id)) throw new UsageError(`--only: unknown catalog id "${id}"`);
    if (!modeIds.has(id)) throw new UsageError(`--only: "${id}" is not part of mode ${mode}`);
  }
  const wanted = new Set(only);
  return inMode.filter((s) => wanted.has(s.id));
}

// ---------------------------------------------------------------------------------------------
// Output guard

/** Every path (relative to site/assets/demo/, `/`-separated) the catalog may write. */
function allowedOutputs(catalog) {
  const names = new Set([MANIFEST]);
  for (const s of catalog) {
    if (s.kind === 'tour' || s.kind === 'clip') names.add(`${s.id}.gif`);
    names.add(`${s.id}.png`);
    names.add(`thumbs/${s.id}.jpg`);
  }
  return names;
}

function prepareOutput(catalog) {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  const allowed = allowedOutputs(catalog);
  const foreign = [];
  for (const e of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
    if (e.isDirectory() && e.name === 'thumbs') continue;
    if (!(e.isFile() && allowed.has(e.name))) foreign.push(e.isDirectory() ? `${e.name}/` : e.name);
  }
  for (const e of fs.readdirSync(THUMBS_DIR, { withFileTypes: true })) {
    if (!(e.isFile() && allowed.has(`thumbs/${e.name}`))) foreign.push(`thumbs/${e.name}${e.isDirectory() ? '/' : ''}`);
  }
  if (foreign.length) {
    process.stderr.write(`Warning: files in site/assets/demo/ that are not in the catalog (left as is, remove them by hand):\n`);
    for (const f of foreign) process.stderr.write(`  ${f}\n`);
  }
  return allowed;
}

/** Absolute path of a catalog output; refuses any name outside the allow-list. */
function outputPath(allowed, rel) {
  if (!allowed.has(rel)) throw new Error(`refusing to write "${rel}": not a catalog output`);
  return path.join(OUT_DIR, ...rel.split('/'));
}

// ---------------------------------------------------------------------------------------------
// Scene errors (collected per scene id, printed at the end)

const sceneErrors = new Map();

function fail(sceneId, message) {
  if (!sceneErrors.has(sceneId)) sceneErrors.set(sceneId, []);
  sceneErrors.get(sceneId).push(message);
}

// ---------------------------------------------------------------------------------------------
// Browser: presentation mode, open, fit

// "Presentation mode", injected before the app boots:
//  - left nav collapsed and the top bar hidden (it carries the identity e-mail and "Edit email");
//  - every e-mail in the DOM rewritten to a neutral one (the session header shows the user).
const PRESENTATION = `
  try { localStorage.setItem('artisyn:leftNavCollapsed', 'true');
        localStorage.setItem('artisyn:sessionListWidth', '300'); } catch {}
  const EMAIL_RE = /[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/g;
  const NEUTRAL = '${NEUTRAL_EMAIL}';
  // Write only when the text actually changes, or the observer would re-trigger itself forever.
  const fix = (n) => {
    const v = n.nodeValue;
    const next = v && v.replace(EMAIL_RE, (m) => (m === NEUTRAL ? m : NEUTRAL));
    if (next !== v) n.nodeValue = next;
  };
  const scrub = (root) => {
    if (root.nodeType === 3) return fix(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fix(n);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') fix(m.target);
      else m.addedNodes.forEach(scrub);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
  addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style');
    // MainNav is the first child of the shell column; the left nav wrapper is the first child of the row below it.
    s.textContent = '#root > div > :first-child { display: none !important; }' +
      '#root > div > div:nth-child(2) > :first-child { display: none !important; }' +
      '* { caret-color: transparent !important; }';
    document.head.append(s);
  });
`;

/**
 * Team names are free text and often a person's name (a personal team), so the init script also
 * rewrites every text node that is exactly a team name of the identified user to a neutral
 * "Team N". Exact whole-node matches only: a short name never touches other words.
 */
function teamScrubScript(names) {
  const map = Object.fromEntries(names.map((n, i) => [n, `Team ${String.fromCharCode(65 + (i % 26))}`]));
  return `
  const TEAMS = ${JSON.stringify(map)};
  const fixTeam = (n) => {
    const v = n.nodeValue;
    const key = v && v.trim();
    if (key && Object.prototype.hasOwnProperty.call(TEAMS, key)) n.nodeValue = v.replace(key, TEAMS[key]);
  };
  const scrubTeams = (root) => {
    if (root.nodeType === 3) return fixTeam(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fixTeam(n);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') fixTeam(m.target);
      else m.addedNodes.forEach(scrubTeams);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
`;
}

async function newPage(browser, cfg, opts) {
  const ctx = await browser.newContext({ colorScheme: 'light', ...opts });
  await ctx.addInitScript(PRESENTATION);
  const r = await ctx.request.post(`${cfg.base}/api/v1/auth/identify`, { data: { email: cfg.email } });
  if (!r.ok()) {
    await ctx.close();
    throw new Error(`identify failed: HTTP ${r.status()}`);
  }
  const teams = await ctx.request.get(`${cfg.base}/api/v1/teams`);
  if (!teams.ok()) {
    await ctx.close();
    throw new Error(`GET /api/v1/teams failed: HTTP ${teams.status()}`);
  }
  const list = await teams.json();
  const names = Array.isArray(list) ? list.map((t) => t && t.name).filter((n) => typeof n === 'string' && n.trim()) : [];
  // The init scripts run on every page created afterwards, so this one still precedes the app boot.
  if (names.length) await ctx.addInitScript(teamScrubScript(names.map((n) => n.trim())));
  return { ctx, page: await ctx.newPage() };
}

/** Wait until no "Loading…" placeholder is on screen (charts load after networkidle). */
async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => !/Loading\.\.\.|Loading…/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/** Park the mouse at the bottom-right corner so no hover card or tooltip is left in the frame. */
async function parkMouse(page) {
  const vp = page.viewportSize();
  await page.mouse.move(vp.width - 1, vp.height - 1);
  await page.waitForTimeout(400);
}

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const LOADING_RE = /Loading/;
const ANY_EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// A developer-machine path (AC-2): a Windows drive path (D:\x, D:/x), a Git-Bash drive path
// (/d/x/) or a home directory (/Users/x, /home/x). Repo-relative paths never match.
const LOCAL_PATH_RE = /(?:^|[\s"'(=:])(?:[A-Za-z]:[\\/][^\s\\/]|\/[a-z]\/[^\s/]+\/|\/(?:Users|home)\/[^\s/]+)/m;

/**
 * Clean-frame guard: the visible text must hold no Cyrillic, no "Loading" placeholder and no
 * e-mail other than the neutral one. Records every problem against the scene id; returns true
 * when the frame is clean. `where` names the step (open, or the clip action) in the message.
 */
async function checkCleanFrame(page, sceneId, where) {
  const text = await page.evaluate(() => document.body.innerText);
  let clean = true;
  const cyr = text.match(CYRILLIC_RE);
  if (cyr) {
    const at = text.indexOf(cyr[0]);
    fail(sceneId, `${where}: non-English text on screen: "${text.slice(Math.max(0, at - 20), at + 40).replace(/\s+/g, ' ')}"`);
    clean = false;
  }
  if (LOADING_RE.test(text)) {
    fail(sceneId, `${where}: a "Loading" placeholder is still on screen`);
    clean = false;
  }
  const localPath = text.match(LOCAL_PATH_RE);
  if (localPath) {
    fail(sceneId, `${where}: a local absolute path on screen: "${localPath[0].trim().slice(0, 40)}"`);
    clean = false;
  }
  const emails = [...new Set((text.match(ANY_EMAIL_RE) ?? []).filter((m) => m !== NEUTRAL_EMAIL))];
  if (emails.length) {
    // The address itself is not printed: it may be a real user's e-mail.
    fail(sceneId, `${where}: ${emails.length} e-mail address(es) other than ${NEUTRAL_EMAIL} on screen`);
    clean = false;
  }
  return clean;
}

/**
 * Open a scene's hash, settle, fold the `master` branch group (its sessions have non-English
 * prompts in the demo repo), park the mouse and run the clean-frame guard.
 */
async function open(page, cfg, scene) {
  await page.goto(`${cfg.base}/${scene.hash}`);
  await settle(page);
  if (await page.getByText('/adlc-demo:scratch take file').isVisible().catch(() => false)) {
    await page.getByText('master', { exact: true }).first().click();
    await settle(page);
  }
  await parkMouse(page);
  return checkCleanFrame(page, scene.id, 'open');
}

/** Run after every clip action: park the mouse, then run the clean-frame guard. */
async function afterAction(page, scene, actionLabel) {
  await parkMouse(page);
  return checkCleanFrame(page, scene.id, `after "${actionLabel}"`);
}

/** How many times taller than its box the most overflowing big scroll pane is (1 = everything fits). */
function overflow(page) {
  return page.evaluate(() => Math.max(1, ...[...document.querySelectorAll('body *')]
    .filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.clientHeight > 200 && e.clientWidth > 200)
    .map((e) => e.scrollHeight / e.clientHeight)));
}

/**
 * Open a scene so it fills the 16:10 frame with nothing cut mid-element: if a pane overflows, the
 * viewport grows by the same factor in both directions (up to MAX_FIT) and deviceScaleFactor
 * shrinks by it, so the output stays outW x outH pixels. A pane still longer than that gets a short
 * fade to white at its bottom edge instead of a hard cut. `clean` is the clean-frame guard result
 * of the final open.
 */
async function openFitted(browser, cfg, scene, outW) {
  const dpr = outW / BASE_W;
  let { ctx, page } = await newPage(browser, cfg, { viewport: { width: BASE_W, height: BASE_H }, deviceScaleFactor: dpr });
  let k = 1;
  let clean;
  try {
    clean = await open(page, cfg, scene);
    const need = await overflow(page);
    if (need > 1.02) {
      k = Math.min(MAX_FIT, need);
      await ctx.close();
      ({ ctx, page } = await newPage(browser, cfg, {
        viewport: { width: Math.round(BASE_W * k), height: Math.round(BASE_H * k) }, deviceScaleFactor: dpr / k }));
      // The first open's guard result is superseded by this one (same scene, final geometry).
      sceneErrors.delete(scene.id);
      clean = await open(page, cfg, scene);
    }
  } catch (e) {
    await ctx.close();
    throw e;
  }
  const faded = await page.evaluate(() => {
    let n = 0;
    for (const e of document.querySelectorAll('body *')) {
      if (!/(auto|scroll)/.test(getComputedStyle(e).overflowY) || e.clientHeight <= 200 || e.scrollHeight <= e.clientHeight + 4) continue;
      e.style.maskImage = e.style.webkitMaskImage = 'linear-gradient(to bottom, #000 calc(100% - 72px), transparent)';
      n++;
    }
    return n;
  });
  return { ctx, page, k, faded, clean };
}

// ---------------------------------------------------------------------------------------------
// Clip actions

const TARGET_TIMEOUT = 5000;

/** The first visible match of an action's target; throws (failing the item) when there is none. */
async function findTarget(page, a) {
  let loc;
  if (a.testId) loc = page.getByTestId(a.testId);
  else if (a.roles && a.name) {
    loc = a.roles.map((role) => page.getByRole(role, { name: a.name, exact: true })).reduce((acc, l) => acc.or(l));
  } else if (a.text) loc = page.getByText(a.text, { exact: true });
  else if (a.css) loc = page.locator(a.css);
  else throw new Error(`action "${a.label}": no target given`);
  const first = loc.first();
  const found = await first.waitFor({ state: 'visible', timeout: TARGET_TIMEOUT }).then(() => true, () => false);
  if (!found) throw new Error(`action "${a.label}": target not found`);
  return first;
}

/** The session tab `id`: its trigger when it is in the row, else the "More ▾" menu entry. */
async function revealSessionTab(page, a) {
  const trigger = page.getByTestId(`tab-session-${a.id}`).first();
  if (await trigger.isVisible().catch(() => false)) return trigger;
  const more = page.getByTestId('session-tabs-more').first();
  if (!(await more.isVisible().catch(() => false))) throw new Error(`action "${a.label}": tab not in the row and no "More"`);
  await more.click();
  const shown = await trigger.waitFor({ state: 'visible', timeout: TARGET_TIMEOUT }).then(() => true, () => false);
  if (!shown) {
    await page.keyboard.press('Escape');
    throw new Error(`action "${a.label}": tab not in the row and not in "More"`);
  }
  return trigger;
}

/** Light settle after an action: no network burst, no "Loading" placeholder, a short paint delay. */
async function settleAfterAction(page) {
  const noLoading = () => page.waitForFunction(() => !/Loading/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  // A tab switch can render its "Loading…" placeholder a moment after the click (lazy chunk,
  // then the data request), so give it a beat before the checks and re-check after the paint delay.
  await page.waitForTimeout(300);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await noLoading();
  await page.waitForTimeout(300);
  await noLoading();
}

/** Run one action, then settle, park the mouse and run the clean-frame guard. Throws on a missing target. */
async function runAction(page, guardId, a) {
  switch (a.do) {
    case 'click':
      await (await findTarget(page, a)).click();
      break;
    case 'sessionTab':
      await (await revealSessionTab(page, a)).click();
      break;
    case 'select': {
      const trigger = page.getByRole('combobox').filter({ hasText: a.trigger }).first();
      const found = await trigger.waitFor({ state: 'visible', timeout: TARGET_TIMEOUT }).then(() => true, () => false);
      if (!found) throw new Error(`action "${a.label}": select not found`);
      await trigger.click();
      const option = page.getByRole('option').filter({ has: page.getByText(a.option, { exact: true }) }).first();
      const shown = await option.waitFor({ state: 'visible', timeout: TARGET_TIMEOUT }).then(() => true, () => false);
      if (!shown) {
        await page.keyboard.press('Escape');
        throw new Error(`action "${a.label}": option not found`);
      }
      await option.click();
      break;
    }
    case 'scroll': {
      const scrolled = await page.evaluate(() => {
        let best = null;
        // Panes starting in the left quarter are the session list / nav, never the content.
        const minLeft = window.innerWidth / 4;
        for (const e of document.querySelectorAll('body *')) {
          if (!/(auto|scroll)/.test(getComputedStyle(e).overflowY) || e.scrollHeight <= e.clientHeight + 4) continue;
          if (e.getBoundingClientRect().left < minLeft) continue;
          if (!best || e.clientWidth * e.clientHeight > best.clientWidth * best.clientHeight) best = e;
        }
        if (!best) return false;
        best.scrollBy({ top: Math.min(best.clientHeight, best.scrollHeight - best.clientHeight), behavior: 'instant' });
        return true;
      });
      if (!scrolled) throw new Error(`action "${a.label}": no scrollable pane`);
      break;
    }
    case 'wait':
      await findTarget(page, a);
      break;
    default:
      throw new Error(`action "${a.label}": unknown kind "${a.do}"`);
  }
  await settleAfterAction(page);
  await afterAction(page, { id: guardId }, a.label);
}

// ---------------------------------------------------------------------------------------------
// GIF: recording, encoding, duration

/**
 * Record one opened scene for `hold` ms: a screenshot loop with the actions run at their `at`
 * times. The clock stops while an action runs, so the GIF time equals the hold. Returns the kept
 * frames `{ buf, t, until }` (ms on the scene clock): at most MAX_FPS, byte-identical consecutive
 * frames merged, the first frame at 0 and the last one lasting to the end of the hold.
 */
async function recordSegment(page, guardId, hold, actions = []) {
  const pending = [...actions].sort((x, y) => x.at - y.at);
  for (const a of pending) {
    if (!(a.at >= 0 && a.at < hold)) throw new Error(`action "${a.label}" at ${a.at} ms is outside the ${hold} ms hold`);
  }
  const start = Date.now();
  let paused = 0;
  const now = () => Date.now() - start - paused;
  const kept = [];
  while (now() < hold) {
    if (pending.length && now() >= pending[0].at) {
      const a = pending.shift();
      const a0 = Date.now();
      await runAction(page, guardId, a);
      paused += Date.now() - a0;
      continue;
    }
    const t = kept.length ? now() : 0;
    const buf = await page.screenshot({ type: 'png' });
    const prev = kept.at(-1);
    if (prev && (t - prev.t < 1000 / MAX_FPS || buf.equals(prev.buf))) continue;
    if (t >= hold) break;
    if (prev) prev.until = t;
    kept.push({ buf, t });
  }
  if (pending.length) throw new Error(`action "${pending[0].label}" never ran (hold too short)`);
  kept.at(-1).until = hold;
  return kept;
}

/** Decode a PNG to RGBA at exactly w x h (a fit rounding pixel is cropped or padded with white). */
function rgbaAt(buf, w, h) {
  const png = PNG.sync.read(buf);
  if (png.width === w && png.height === h) return png.data;
  const out = Buffer.alloc(w * h * 4, 0xff);
  const cw = Math.min(w, png.width);
  for (let y = 0; y < Math.min(h, png.height); y++) {
    png.data.copy(out, y * w * 4, y * png.width * 4, (y * png.width + cw) * 4);
  }
  return out;
}

/** A PNG buffer at exactly w x h: the buffer itself when it already is, else re-encoded via rgbaAt. */
function pngAt(buf, w, h) {
  const png = PNG.sync.read(buf);
  if (png.width === w && png.height === h) return buf;
  const out = new PNG({ width: w, height: h });
  out.data = rgbaAt(buf, w, h);
  return PNG.sync.write(out);
}

/** GIF89a of the kept frames: one 256-color palette per frame, delay = frame time, loop forever. */
function encodeGif(frames) {
  const gif = GIFEncoder();
  // GIF delays are centiseconds: round each frame's end on the cumulative clock, so per-frame
  // rounding never adds up and the total play time equals the recorded time (to 10 ms).
  const cs = (ms) => Math.round(ms / 10);
  frames.forEach((f, i) => {
    const data = rgbaAt(f.buf, GIF_W, GIF_H);
    const palette = quantize(data, 256);
    const opts = { palette, delay: (cs(f.until) - cs(f.t)) * 10 };
    if (i === 0) opts.repeat = 0;
    gif.writeFrame(applyPalette(data, palette), GIF_W, GIF_H, opts);
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

/**
 * Total play time of a GIF in ms: the sum of its frame delays (Graphic Control Extensions,
 * centiseconds). Walks the block structure, so image data that happens to contain the GCE bytes
 * is never counted.
 */
function gifDurationMs(b) {
  let i = 13;
  if (b[10] & 0x80) i += 3 * (2 << (b[10] & 7));
  let cs = 0;
  const skipSubBlocks = () => {
    while (i < b.length && b[i] !== 0) i += b[i] + 1;
    i++;
  };
  while (i < b.length) {
    const tag = b[i];
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      if (b[i + 1] === 0xf9) cs += b.readUInt16LE(i + 4);
      i += 2;
      skipSubBlocks();
    } else if (tag === 0x2c) {
      const flags = b[i + 9];
      i += 10;
      if (flags & 0x80) i += 3 * (2 << (flags & 7));
      i++; // LZW minimum code size
      skipSubBlocks();
    } else {
      throw new Error(`malformed GIF: unexpected block 0x${tag.toString(16)} at ${i}`);
    }
  }
  return cs * 10;
}

/** Open and record each segment, fitted at the GIF size; returns all kept frames and per-segment fit info. */
async function recordGif(browser, cfg, segments) {
  const frames = [];
  const fits = [];
  for (const seg of segments) {
    const { ctx, page, k, faded } = await openFitted(browser, cfg, seg, GIF_W);
    try {
      frames.push(...await recordSegment(page, seg.id, seg.hold, seg.actions));
    } catch (e) {
      // Name the tour segment in the item's error; a clip's only segment is the clip itself.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(segments.length > 1 ? `${seg.id}: ${msg}` : msg);
    } finally {
      await ctx.close();
    }
    fits.push({ id: seg.id, k, faded });
  }
  return { frames, fits };
}

// ---------------------------------------------------------------------------------------------
// Thumbnails (Design Decision 8)

/** A 256x160 page on a file:// URL that renders one image fitted on white, like the carousel stage. */
async function openThumbPage(browser) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, 'thumb.html');
  fs.writeFileSync(file, '<!doctype html><body style="margin:0;background:#fff">'
    + `<img style="display:block;width:${THUMB_W}px;height:${THUMB_H}px;object-fit:contain"></body>`);
  const page = await browser.newPage({ viewport: { width: THUMB_W, height: THUMB_H }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(file).href);
  return page;
}

/** JPEG q80 thumbnail of a PNG buffer (the still, or a GIF's first frame). */
async function renderThumb(thumbPage, pngBuf) {
  const src = `data:image/png;base64,${pngBuf.toString('base64')}`;
  await thumbPage.locator('img').evaluate((img, s) => {
    img.src = s;
    return img.decode();
  }, src);
  return thumbPage.screenshot({ type: 'jpeg', quality: THUMB_QUALITY });
}

// ---------------------------------------------------------------------------------------------
// Recorders: each returns { files: [[rel, buffer]], entry, lines } or records a failure and returns null.
// Files are written only when every check of the item passed.

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const mb = (n) => `${(n / 1_000_000).toFixed(2)} MB`;
const fitText = (fits) => {
  const ks = fits.map((f) => f.k);
  const lo = Math.min(...ks).toFixed(2);
  const hi = Math.max(...ks).toFixed(2);
  return lo === hi ? `fit x${lo}` : `fit x${lo}–x${hi}`;
};

/** True when no error was recorded for any of these ids (open/action guards, etc.). */
const allClean = (ids) => ids.every((id) => !sceneErrors.has(id));

async function recordStill({ browser, cfg, scene, thumbPage }) {
  const { ctx, page, k, faded } = await openFitted(browser, cfg, scene, STILL_W);
  let buf;
  try {
    buf = await page.screenshot({ type: 'png' });
  } finally {
    await ctx.close();
  }
  if (!allClean([scene.id])) return null;
  buf = pngAt(buf, STILL_W, STILL_H);
  if (buf.length > STILL_MAX_BYTES) {
    fail(scene.id, `still is ${kb(buf.length)}, over the ${kb(STILL_MAX_BYTES)} budget`);
    return null;
  }
  const thumb = await renderThumb(thumbPage, buf);
  return {
    files: [[`${scene.id}.png`, buf], [`thumbs/${scene.id}.jpg`, thumb]],
    entry: {
      id: scene.id, kind: 'still', src: `${SITE_PREFIX}${scene.id}.png`, thumb: `${SITE_PREFIX}thumbs/${scene.id}.jpg`,
      caption: scene.caption, where: scene.where, alt: scene.caption,
    },
    lines: [`${scene.id}.png  fit x${k.toFixed(2)}  faded panes ${faded}  ${kb(buf.length)}`],
  };
}

async function recordGifItem({ browser, cfg, scene, thumbPage }) {
  const isTour = scene.kind === 'tour';
  const segments = isTour ? scene.segments : [{ id: scene.id, hash: scene.hash, hold: scene.hold, actions: scene.actions }];
  const { frames, fits } = await recordGif(browser, cfg, segments);
  if (!allClean([scene.id, ...segments.map((s) => s.id)])) {
    if (!sceneErrors.has(scene.id)) fail(scene.id, 'a scene failed its clean-frame guard (see its own lines)');
    return null;
  }
  const gif = encodeGif(frames);
  const duration = gifDurationMs(gif);
  const [maxBytes, minMs, maxMs] = isTour ? [TOUR_MAX_BYTES, TOUR_MIN_MS, TOUR_MAX_MS] : [CLIP_MAX_BYTES, CLIP_MIN_MS, CLIP_MAX_MS];
  let ok = true;
  if (gif.length > maxBytes) {
    fail(scene.id, `GIF is ${mb(gif.length)}, over the ${mb(maxBytes)} budget`);
    ok = false;
  }
  if (duration < minMs || duration > maxMs) {
    fail(scene.id, `GIF plays ${(duration / 1000).toFixed(1)} s, outside ${minMs / 1000}–${maxMs / 1000} s`);
    ok = false;
  }
  if (!ok) return null;
  const first = pngAt(frames[0].buf, GIF_W, GIF_H);
  const thumb = await renderThumb(thumbPage, first);
  const lines = [`${scene.id}.gif  ${(duration / 1000).toFixed(1)} s  ${frames.length} frames  ${fitText(fits)}  `
    + `faded panes ${Math.max(...fits.map((f) => f.faded))}  ${mb(gif.length)}`,
  `${scene.id}.png  first frame  ${kb(first.length)}`];
  if (isTour) for (const f of fits) lines.push(`  ${f.id}  fit x${f.k.toFixed(2)}  faded panes ${f.faded}`);
  return {
    files: [[`${scene.id}.gif`, gif], [`${scene.id}.png`, first], [`thumbs/${scene.id}.jpg`, thumb]],
    entry: {
      id: scene.id, kind: scene.kind, src: `${SITE_PREFIX}${scene.id}.gif`, still: `${SITE_PREFIX}${scene.id}.png`,
      thumb: `${SITE_PREFIX}thumbs/${scene.id}.jpg`, duration, caption: scene.caption, where: scene.where,
      alt: isTour ? scene.alt : scene.caption,
    },
    lines,
  };
}

const RECORDERS = { tour: recordGifItem, clip: recordGifItem, still: recordStill };

/** Record every scene; writes the files of each item that passed. Returns the manifest entries by id. */
async function capture(scenes, cfg, allowed) {
  const entries = new Map();
  const browser = await chromium.launch();
  try {
    const thumbPage = await openThumbPage(browser);
    for (const scene of scenes) {
      const recorder = RECORDERS[scene.kind];
      if (!recorder) {
        fail(scene.id, `no recorder for kind "${scene.kind}"`);
        continue;
      }
      let result;
      try {
        result = await recorder({ browser, cfg, scene, thumbPage });
      } catch (e) {
        fail(scene.id, e instanceof Error ? e.message : String(e));
        continue;
      }
      if (!result) continue;
      for (const [rel, buf] of result.files) fs.writeFileSync(outputPath(allowed, rel), buf);
      for (const line of result.lines) process.stdout.write(`${line}\n`);
      const thumbRel = `thumbs/${scene.id}.jpg`;
      process.stdout.write(`${thumbRel}  ${kb(result.files.find(([rel]) => rel === thumbRel)[1].length)}\n`);
      entries.set(scene.id, result.entry);
    }
  } finally {
    await browser.close();
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Manifest and total budget

/** The existing items.json entries by id ({} when missing or unreadable — a warning, not an error). */
function readManifest() {
  const file = path.join(OUT_DIR, MANIFEST);
  if (!fs.existsSync(file)) return new Map();
  try {
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(items)) throw new Error('not an array');
    return new Map(items.filter((it) => it && typeof it.id === 'string').map((it) => [it.id, it]));
  } catch (e) {
    process.stderr.write(`Warning: ${MANIFEST} is unreadable (${e instanceof Error ? e.message : e}); rewriting it from this run only\n`);
    return new Map();
  }
}

/**
 * items.json in catalog order: this run's entries replace their ids, every other catalog id keeps
 * its entry from the existing file (so --only, a single mode or a failed item keeps the rest).
 */
function writeManifest(catalog, fresh, allowed) {
  const old = readManifest();
  const items = catalog.map((s) => fresh.get(s.id) ?? old.get(s.id)).filter(Boolean);
  fs.writeFileSync(outputPath(allowed, MANIFEST), `${JSON.stringify(items, null, 2)}\n`);
  process.stdout.write(`${MANIFEST}  ${items.length} items\n`);
}

/** Size of every catalog file present in site/assets/demo/ (foreign files excluded). */
function catalogBytes(allowed) {
  let total = 0;
  for (const rel of allowed) {
    const file = path.join(OUT_DIR, ...rel.split('/'));
    if (fs.existsSync(file)) total += fs.statSync(file).size;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Main

async function main() {
  let args;
  let cfg;
  let catalog;
  let scenes;
  try {
    args = parseArgs(process.argv.slice(2));
    cfg = readEnv(process.env);
    catalog = buildCatalog(cfg);
    scenes = selectScenes(catalog, args.mode, args.only);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`record-demo: ${e.message}\n`);
      process.stderr.write('Usage: node scripts/site/record-demo.mjs <tour|items|all> [--only <id>[,<id>]]\n');
      return 2;
    }
    throw e;
  }

  const allowed = prepareOutput(catalog);
  const entries = await capture(scenes, cfg, allowed);
  writeManifest(catalog, entries, allowed);

  const total = catalogBytes(allowed);
  process.stdout.write(`total site/assets/demo/: ${mb(total)} (budget ${mb(TOTAL_BUDGET)})\n`);
  if (total > TOTAL_BUDGET) fail('total', `site/assets/demo/ holds ${mb(total)}, over the ${mb(TOTAL_BUDGET)} budget`);

  if (sceneErrors.size) {
    process.stderr.write(`record-demo: ${sceneErrors.size} scene(s) failed:\n`);
    for (const [id, msgs] of sceneErrors) {
      for (const m of msgs) process.stderr.write(`  ${id}: ${m}\n`);
    }
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`record-demo: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  },
);
