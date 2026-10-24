// FR-9 UI verifier: a nested `claude -p` driving the Playwright MCP server
// checks one ingested session against its expected params and writes a verdict JSON
// (API changes → "Verifier verdict"), which is validated here.
import fs from 'node:fs';
import path from 'node:path';
import {
  PLAYWRIGHT_MCP_PKG,
  PROMPTS_DIR,
  STAND_URL,
  TIMEOUTS,
  USERS,
  VERIFIER_MODEL,
  VERIFIER_TOOL_BUDGET_BASE,
} from './config.mjs';
import { runAsync } from './proc.mjs';

function check(fields, shots, calls, expect) {
  return Object.freeze({
    fields: Object.freeze(fields),
    shots: Object.freeze(shots),
    calls,
    // Keys of the session's expected params sent to the verifier for this check (EXPECTED_JSON).
    expect: Object.freeze(expect),
  });
}

/**
 * Verifier checks (Design Decision 5): each id maps to its verdict fields, its mandatory evidence
 * screenshots (relative to the scenario's shot dir), its tool-call budget and its prompt fragment
 * `prompts/checks/<id>.md`. A scenario lists the ones it runs in `verifyChecks`.
 */
export const CHECKS = Object.freeze(
  Object.fromEntries(
    Object.entries({
      model: check(['model'], ['summary.png'], 3, ['model']),
      harness: check(
        ['skills', 'rules', 'workflows', 'subagents', 'mcp'],
        ['harness-usage.png'],
        8,
        ['skills', 'rules', 'workflows', 'subagents', 'mcp'],
      ),
      prompt: check(['prompt'], ['logs.png'], 3, ['prompt']),
      // Judged by the orchestrator (judgeCost) — the verifier only reports the telemetry total.
      cost: check(['cost'], ['cost.png'], 4, []),
      bashTab: check(['bash'], ['bash.png'], 5, ['bash']),
      contextGrowth: check(['contextGrowth'], ['context-growth.png'], 5, []),
      agentsTable: check(['agentsTable'], ['agents-table.png', 'agent-modal.png'], 6, ['agents']),
      systemContext: check(['systemContext'], ['sysctx.png'], 7, ['sysctx']),
      denied: check(['denied'], ['denied.png'], 4, ['denied']),
      // Judged by the orchestrator (judgeWorkTime) — the verifier only reports the durations.
      workTime: check(['workTime'], ['work-time.png'], 3, []),
      bashPaths: check(['bashPaths'], ['bash-paths.png'], 4, ['bashPaths']),
    }).map(([id, c]) => [id, Object.freeze({ ...c, fragment: `checks/${id}.md` })]),
  ),
);

/** The checks every SCENARIOS session runs unless it lists its own. */
export const DEFAULT_CHECKS = Object.freeze(['model', 'harness', 'prompt', 'cost']);

/** The only verdict fields that may carry the status `skipped`. */
export const SKIPPABLE_FIELDS = Object.freeze(['cost']);

/** The expected-params key each verdict field is compared with (for the report's mismatches). */
const FIELD_EXPECTED_KEY = Object.freeze({
  bash: 'bash',
  cost: 'costUsd',
  contextGrowth: null,
  agentsTable: 'agents',
  systemContext: 'sysctx',
  denied: 'denied',
  workTime: 'workTime',
  bashPaths: 'bashPaths',
});

const STATUSES = new Set(['pass', 'fail']);

function checkDefs(checks) {
  if (!Array.isArray(checks) || checks.length === 0) throw new Error('verifier checks must be a non-empty list');
  return checks.map((id) => {
    const def = CHECKS[id];
    if (!def) throw new Error(`unknown verifier check "${id}"`);
    return def;
  });
}

/** Verdict field keys of the given checks, in check order, without duplicates. */
export function fieldsFor(checks) {
  return [...new Set(checkDefs(checks).flatMap((c) => c.fields))];
}

/** Mandatory evidence screenshot files of the given checks, in check order, without duplicates. */
export function shotsFor(checks) {
  return [...new Set(checkDefs(checks).flatMap((c) => c.shots))];
}

/** Login calls + every check's calls + one call per mandatory screenshot + 2 for the verdict. */
export function verifierCallBudget(checks) {
  const defs = checkDefs(checks);
  const calls = defs.reduce((sum, c) => sum + c.calls, 0);
  return VERIFIER_TOOL_BUDGET_BASE + calls + shotsFor(checks).length + 2;
}

/**
 * The template variable of a screenshot file: the three original views keep `SHOT_SUMMARY`,
 * `SHOT_HARNESS` and `SHOT_LOGS`; every other shot is `SHOT_` + its stem in UPPER_SNAKE.
 */
export function shotVarName(file) {
  if (file === 'harness-usage.png') return 'SHOT_HARNESS';
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  return `SHOT_${stem.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
}

/** `{ SHOT_<NAME>: <absolute path> }` for every mandatory screenshot of the given checks. */
export function shotVars(checks, shotDir) {
  return Object.fromEntries(shotsFor(checks).map((f) => [shotVarName(f), path.join(shotDir, f)]));
}

/** The subset of `expected` the verifier needs for the given checks (EXPECTED_JSON). */
export function expectedForChecks(checks, expected) {
  const keys = [...new Set(checkDefs(checks).flatMap((c) => c.expect))];
  return Object.fromEntries(keys.map((k) => [k, k === 'mcp' ? (expected?.mcp ?? []) : (expected?.[k] ?? null)]));
}

export const VERIFY_TEMPLATE_FILE = path.join(PROMPTS_DIR, 'verify-session.md');

const FRAGMENT_SECTIONS = Object.freeze(['Step', 'Judge', 'Fields']);

/**
 * Splits a check fragment into its `## Step`, `## Judge` and `## Fields` sections (trimmed
 * text). Throws when a section is missing or empty.
 */
export function parseFragment(text, name = 'fragment') {
  const src = String(text).replace(/\r\n/g, '\n');
  const out = {};
  const re = /^##[ \t]+(\S.*?)[ \t]*$/gm;
  const heads = [...src.matchAll(re)];
  heads.forEach((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : src.length;
    out[m[1]] = src.slice(m.index + m[0].length, end).trim();
  });
  for (const s of FRAGMENT_SECTIONS) {
    if (!out[s]) throw new Error(`${name}: section "## ${s}" is missing or empty`);
  }
  return { step: out.Step, judge: out.Judge, fields: out.Fields };
}

function readFragment(id) {
  const file = path.join(PROMPTS_DIR, CHECKS[id].fragment);
  return parseFragment(fs.readFileSync(file, 'utf8'), CHECKS[id].fragment);
}

/** `N. <first line>` with the following lines indented under the number. */
function numberStep(n, text) {
  const [first, ...rest] = text.split('\n');
  return [`${n}. ${first}`, ...rest.map((l) => (l.trim() ? `   ${l}` : ''))].join('\n');
}

/**
 * Builds the verifier prompt for the given checks: numbers each fragment's step after the login
 * step (1), joins the judge rules and the verdict-example field lines into `{{STEPS}}`,
 * `{{JUDGE}}` and `{{VERDICT_FIELDS}}` of `verify-session.md`, then fills every `{{KEY}}` from
 * `vars` (fillTemplate — throws on a missing value or a leftover placeholder).
 */
export function composeVerifyPrompt(checks, vars, template = fs.readFileSync(VERIFY_TEMPLATE_FILE, 'utf8')) {
  checkDefs(checks);
  const frags = checks.map((id) => readFragment(id));
  const steps = frags.map((f, i) => numberStep(i + 2, f.step)).join('\n');
  const judge = frags.map((f) => f.judge).join('\n');
  const fieldLines = frags.flatMap((f) =>
    f.fields
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim())
      .map((l) => l.replace(/,\s*$/, '')),
  );
  const verdictFields = fieldLines.map((l) => `    ${l.trim()}`).join(',\n');
  const tpl = template
    .replace(/\r\n/g, '\n')
    .replace('{{STEPS}}', () => steps)
    .replace('{{JUDGE}}', () => judge)
    .replace('{{VERDICT_FIELDS}}', () => verdictFields);
  return fillTemplate(tpl, vars);
}

const COST_RE = /\$\s*(\d+(?:\.\d+)?)/;

/**
 * FR-5 (Design Decision 9): compares the UI "Telemetry total" text with the stream's
 * `total_cost_usd`. Skipped when either side is missing or unparseable; passes iff
 * |Δ| < max(0.05, 1 % of the telemetry total). Returns { status, note, telemetry }.
 */
export function judgeCost(observedText, costUsd) {
  const m = typeof observedText === 'string' ? observedText.match(COST_RE) : null;
  const telemetry = m ? Number(m[1]) : null;
  if (costUsd == null || !Number.isFinite(Number(costUsd))) {
    return { status: 'skipped', note: 'no stream total_cost_usd to compare', telemetry };
  }
  if (telemetry == null || !Number.isFinite(telemetry)) {
    return { status: 'skipped', note: `no parseable "Telemetry total" in ${JSON.stringify(observedText ?? null)}`, telemetry: null };
  }
  // Rounded to 1e-8 so binary float noise (10.1 − 10 = 0.0999…96) cannot flip a boundary row.
  const round = (x) => Math.round(x * 1e8) / 1e8;
  const delta = round(Math.abs(telemetry - Number(costUsd)));
  const tolerance = round(Math.max(0.05, 0.01 * telemetry));
  const pass = delta < tolerance;
  return {
    status: pass ? 'pass' : 'fail',
    note: `telemetry $${telemetry.toFixed(4)} vs stream $${Number(costUsd).toFixed(4)}: |Δ| ${delta.toFixed(4)} ${pass ? '<' : '≥'} ${tolerance.toFixed(4)}`,
    telemetry,
  };
}

/** Seconds of the first `h:mm:ss` (or `m:ss`) duration in `text`, or null. */
export function parseDurationSeconds(text) {
  if (typeof text !== 'string') return null;
  const hms = text.match(/(\d+):(\d{2}):(\d{2})/);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  const ms = text.match(/(\d+):(\d{2})/);
  if (ms) return Number(ms[1]) * 60 + Number(ms[2]);
  return null;
}

/**
 * FR-7 (Design Decision 10): the turn-1 header duration (`h:mm:ss`, floored) must be at least
 * `minSeconds`. Returns { status, note, seconds }.
 */
export function judgeWorkTime(observed, minSeconds) {
  const seconds = parseDurationSeconds(observed);
  if (minSeconds == null || !Number.isFinite(Number(minSeconds))) {
    return { status: 'fail', note: 'no expected work-time window (no task notification or no later assistant entry)', seconds };
  }
  if (seconds == null) {
    return { status: 'fail', note: `no h:mm:ss duration in ${JSON.stringify(observed ?? null)}`, seconds: null };
  }
  const pass = seconds >= Number(minSeconds);
  return { status: pass ? 'pass' : 'fail', note: `turn-1 ${seconds}s ${pass ? '≥' : '<'} min ${minSeconds}s`, seconds };
}

/**
 * Overwrites the verifier's `cost` / `workTime` statuses and notes with the scripted judgements
 * (judgeCost / judgeWorkTime) and recomputes `overall` (fail iff any field fails). Mutates and
 * returns `verdict`; fields the verdict does not carry are left alone. Idempotent.
 */
export function applyScriptedJudgements(verdict, expected) {
  const fields = verdict?.fields;
  if (!fields || typeof fields !== 'object') return verdict;
  if (fields.cost && typeof fields.cost === 'object') {
    const j = judgeCost(fields.cost.observed, expected?.costUsd ?? null);
    fields.cost.status = j.status;
    fields.cost.note = j.note;
  }
  if (fields.workTime && typeof fields.workTime === 'object') {
    const j = judgeWorkTime(fields.workTime.observed, expected?.workTime?.minSeconds ?? null);
    fields.workTime.status = j.status;
    fields.workTime.note = j.note;
  }
  verdict.overall = Object.values(fields).some((f) => f?.status === 'fail') ? 'fail' : 'pass';
  return verdict;
}

export const VERIFY_STATUS = Object.freeze({
  pass: 'pass',
  fail: 'fail',
  verifierError: 'fail: verifier error',
  notExercised: 'scenario not exercised',
});

const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * Replaces every `{{KEY}}` in `tpl` with `vars[KEY]`. Throws when the template names a key that
 * `vars` does not provide, or when any `{{…}}` is left in the result.
 */
export function fillTemplate(tpl, vars) {
  if (typeof tpl !== 'string') throw new Error('fillTemplate: template must be a string');
  const values = vars || {};
  const missing = new Set();
  const out = tpl.replace(PLACEHOLDER_RE, (whole, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key) || values[key] == null) {
      missing.add(key);
      return whole;
    }
    return String(values[key]);
  });
  if (missing.size) {
    throw new Error(`fillTemplate: no value for ${[...missing].map((k) => `{{${k}}}`).join(', ')}`);
  }
  const leftover = out.match(/\{\{[^{}]*\}\}/g);
  if (leftover) {
    throw new Error(`fillTemplate: unfilled placeholders left: ${[...new Set(leftover)].join(', ')}`);
  }
  return out;
}

/**
 * Writes `_verify/mcp-<S#>.json` for the Playwright MCP server, saving screenshots into
 * `_report/<S#>`. Returns { file, shotDir }.
 */
export function writeMcpConfig(runPaths, sid) {
  const shotDir = runPaths.reportSessionDir(sid);
  const file = runPaths.mcpConfig(sid);
  const config = {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: ['--yes', PLAYWRIGHT_MCP_PKG, '--isolated', '--headless', '--output-dir', shotDir],
      },
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return { file, shotDir };
}

function isRelativeShot(p) {
  if (typeof p !== 'string' || p.trim() === '') return false;
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) return false;
  return !p.split(/[\\/]/).includes('..');
}

/**
 * Validates a verdict object against API changes → "Verifier verdict" (Design Decision 7):
 * `fields` must carry exactly `fieldKeys` (default: the DEFAULT_CHECKS fields), each with status
 * pass|fail (`skipped` only for SKIPPABLE_FIELDS); `overall` is fail iff some field failed.
 * Returns { ok, errors } — never throws.
 */
export function validateVerdict(json, fieldKeys = fieldsFor(DEFAULT_CHECKS)) {
  const errors = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, errors: ['verdict is not a JSON object'] };
  }
  if (typeof json.session !== 'string' || json.session.trim() === '') errors.push('"session" is missing');
  if (!STATUSES.has(json.overall)) errors.push(`"overall" must be pass|fail, got ${JSON.stringify(json.overall)}`);
  const fields = json.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    errors.push('"fields" is missing');
    return { ok: false, errors };
  }
  for (const key of fieldKeys) {
    const f = fields[key];
    if (!f || typeof f !== 'object') {
      errors.push(`fields.${key} is missing`);
      continue;
    }
    const skippable = SKIPPABLE_FIELDS.includes(key);
    if (!(STATUSES.has(f.status) || (skippable && f.status === 'skipped'))) {
      errors.push(`fields.${key}.status must be ${skippable ? 'pass|fail|skipped' : 'pass|fail'}, got ${JSON.stringify(f.status)}`);
    }
    if (f.observed === undefined) errors.push(`fields.${key}.observed is missing`);
    if (!isRelativeShot(f.screenshot)) {
      errors.push(`fields.${key}.screenshot must be a non-empty relative path, got ${JSON.stringify(f.screenshot)}`);
    }
  }
  for (const key of Object.keys(fields)) {
    if (!fieldKeys.includes(key)) errors.push(`fields.${key} is not expected for this scenario`);
  }
  if (errors.length === 0) {
    const anyFail = fieldKeys.some((k) => fields[k].status === 'fail');
    if (json.overall === 'pass' && anyFail) errors.push('"overall" is pass but a field failed');
    if (json.overall === 'fail' && !anyFail) errors.push('"overall" is fail but no field failed');
  }
  return { ok: errors.length === 0, errors };
}

/** `<STAND_URL>/#/repos/<rid>?session=<sid>` (the template appends `&tab=…`). */
export function sessionUrl(repoId, sessionId, standUrl = STAND_URL) {
  return `${standUrl}/#/repos/${encodeURIComponent(repoId)}?session=${encodeURIComponent(sessionId)}`;
}

function resolveOwner(owner) {
  if (typeof owner === 'string') {
    const u = USERS[owner];
    if (u) return { email: u.email, password: u.password };
    const byEmail = Object.values(USERS).find((x) => x.email === owner);
    if (byEmail) return { email: byEmail.email, password: byEmail.password };
    throw new Error(`verifySession: unknown owner "${owner}"`);
  }
  if (owner && owner.email && owner.password) return { email: owner.email, password: owner.password };
  throw new Error('verifySession: owner needs an email and a password');
}

function quote(p) {
  return `"${p}"`;
}

/** `claude -p` argv for the verifier (the prompt goes on stdin). */
export function verifierArgs(mcpFile, reportDir, model = VERIFIER_MODEL) {
  return [
    '-p',
    '--model',
    model,
    '--permission-mode',
    'bypassPermissions',
    '--mcp-config',
    quote(mcpFile),
    '--strict-mcp-config',
    '--add-dir',
    quote(reportDir),
    '--output-format',
    'json',
  ];
}

/**
 * Locates a verdict screenshot: `<reportDir>/<rel>` when it exists, otherwise a file with the same
 * basename anywhere under the scenario's shot dir (the MCP server may nest its output). Returns the
 * path relative to `reportDir` with forward slashes, or null.
 */
export function resolveShot(reportDir, shotDir, rel) {
  if (isRelativeShot(rel) && fs.existsSync(path.join(reportDir, rel))) return rel.replace(/\\/g, '/');
  const base = path.basename(String(rel || ''));
  if (!base) return null;
  const stack = [shotDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === base) return path.relative(reportDir, full).split(path.sep).join('/');
    }
  }
  return null;
}

const SHOT_FILE_RE = /\.(png|jpe?g)$/i;

function strayShots(verifyDir) {
  try {
    return fs
      .readdirSync(verifyDir, { withFileTypes: true })
      .filter((e) => e.isFile() && SHOT_FILE_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Removes screenshots a previous verifier left in the shared `_verify/` cwd. */
export function clearStrayShots(verifyDir) {
  for (const name of strayShots(verifyDir)) fs.rmSync(path.join(verifyDir, name), { force: true });
}

/**
 * The Playwright MCP server resolves a bare screenshot filename against its cwd (`_verify/`), not
 * `--output-dir`. Moves any such screenshot into the scenario's shot dir (without overwriting a
 * file already there) and returns the moved file names. Verifiers run one at a time, so every
 * image in `_verify/` belongs to the verifier that just finished.
 */
export function collectStrayShots(verifyDir, shotDir) {
  const moved = [];
  for (const name of strayShots(verifyDir)) {
    const src = path.join(verifyDir, name);
    const dest = path.join(shotDir, name);
    if (fs.existsSync(dest)) {
      fs.rmSync(src, { force: true });
      continue;
    }
    fs.mkdirSync(shotDir, { recursive: true });
    fs.renameSync(src, dest);
    moved.push(name);
  }
  return moved;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function verifierMeta(stdoutFile) {
  try {
    const j = readJson(stdoutFile);
    return {
      isError: Boolean(j.is_error),
      numTurns: j.num_turns ?? null,
      costUsd: j.total_cost_usd ?? null,
      durationMs: j.duration_ms ?? null,
      result: typeof j.result === 'string' ? j.result.slice(0, 500) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Final session status (API changes → "Session result"): `pass` only when the verdict `overall`
 * is pass and the isolation check passed. A scenario that was never exercised keeps that status
 * (its verdict is still recorded); a verifier error wins over everything else.
 */
export function settleSessionStatus(priorStatus, verify, isolation) {
  if (verify.status === VERIFY_STATUS.verifierError) return VERIFY_STATUS.verifierError;
  if (priorStatus === VERIFY_STATUS.notExercised) return VERIFY_STATUS.notExercised;
  const isolationOk = !isolation || isolation.status === 'pass';
  return verify.status === VERIFY_STATUS.pass && isolationOk ? VERIFY_STATUS.pass : VERIFY_STATUS.fail;
}

/**
 * Runs the verifier for one session and validates its verdict.
 *
 * scenario — a SCENARIOS entry (its `verifyChecks` pick the fields, screenshots and prompt
 * fragments; DEFAULT_CHECKS when absent); expected — the FR-8 expected params (with `session_id`);
 * repoId — the owner's repository id; owner — a USERS key, an email, or { email, password }.
 * opts (optional): { claudeCmd, timeoutMs, standUrl, isolation, priorStatus, log }
 *
 * Resolves { status, verdict, evidence, mismatches, error, meta }, where `status` is `pass`,
 * `fail` or `fail: verifier error` — or the settled session status when `opts.isolation` /
 * `opts.priorStatus` is given (see settleSessionStatus).
 */
export async function verifySession(scenario, expected, repoId, owner, runPaths, env, opts = {}) {
  const sid = scenario.id;
  const claudeCmd = opts.claudeCmd ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.verifierMs;
  const standUrl = opts.standUrl ?? STAND_URL;
  const log = opts.log ?? (() => {});
  const reportDir = runPaths.reportDir;
  const verdictPath = runPaths.verdictFile(sid);
  const shotRel = sid;

  const out = { status: VERIFY_STATUS.verifierError, verdict: null, evidence: [], mismatches: [], error: null, meta: null };
  const finish = () => {
    if (opts.isolation !== undefined || opts.priorStatus !== undefined) {
      out.status = settleSessionStatus(opts.priorStatus, out, opts.isolation);
    }
    return out;
  };

  try {
    if (!expected || !expected.session_id) throw new Error('no expected params / session_id to verify');
    if (repoId == null) throw new Error('no repository id for the session');
    const checks = scenario.verifyChecks?.length ? [...scenario.verifyChecks] : [...DEFAULT_CHECKS];
    const fieldKeys = fieldsFor(checks);
    const creds = resolveOwner(owner);
    const { file: mcpFile, shotDir } = writeMcpConfig(runPaths, sid);
    fs.rmSync(verdictPath, { force: true });
    fs.mkdirSync(runPaths.verifyDir, { recursive: true });

    const prompt = composeVerifyPrompt(checks, {
      TOOL_BUDGET: verifierCallBudget(checks),
      SCENARIO_ID: sid,
      STAND_URL: standUrl,
      EMAIL: creds.email,
      PASSWORD: creds.password,
      SESSION_URL: sessionUrl(repoId, expected.session_id, standUrl),
      EXPECTED_JSON: JSON.stringify(expectedForChecks(checks, expected), null, 2),
      VERDICT_PATH: verdictPath,
      SHOT_DIR: shotDir,
      SHOT_REL: shotRel,
      ...shotVars(checks, shotDir),
      SHOT_MISMATCH_EXAMPLE: path.join(shotDir, `${fieldKeys[0]}-mismatch.png`),
    });
    clearStrayShots(runPaths.verifyDir);

    log(`${sid}: verifier started (session ${expected.session_id}, repo ${repoId})`);
    const command = [claudeCmd, ...verifierArgs(mcpFile, reportDir)].join(' ');
    const res = await runAsync(command, [], {
      cwd: runPaths.verifyDir,
      env,
      input: prompt,
      shell: true,
      timeoutMs,
      stdoutFile: runPaths.verifyStdout(sid),
      stderrFile: runPaths.verifyStderr(sid),
    });
    out.meta = verifierMeta(runPaths.verifyStdout(sid));
    const moved = collectStrayShots(runPaths.verifyDir, shotDir);
    if (moved.length) log(`${sid}: moved ${moved.length} screenshot(s) from the verifier cwd into ${shotRel}/`);

    if (!fs.existsSync(verdictPath)) {
      if (res.timedOut) throw new Error(`verifier timed out after ${Math.round(timeoutMs / 1000)}s and wrote no verdict`);
      throw new Error(`verifier wrote no verdict (claude -p exited with ${res.exitCode})`);
    }
    let verdict;
    try {
      verdict = readJson(verdictPath);
    } catch (err) {
      throw new Error(`verdict is not valid JSON: ${err.message}`);
    }
    const validation = validateVerdict(verdict, fieldKeys);
    if (!validation.ok) throw new Error(`invalid verdict: ${validation.errors.join('; ')}`);
    applyScriptedJudgements(verdict, expected);

    const missingShots = [];
    for (const key of fieldKeys) {
      const found = resolveShot(reportDir, shotDir, verdict.fields[key].screenshot);
      if (found) verdict.fields[key].screenshot = found;
      else missingShots.push(`${key} → ${verdict.fields[key].screenshot}`);
    }
    for (const file of shotsFor(checks)) {
      const label = file.replace(/\.[^.]+$/, '');
      const found = resolveShot(reportDir, shotDir, `${shotRel}/${file}`);
      if (found) out.evidence.push({ label, path: found });
      else missingShots.push(`${label} → ${shotRel}/${file}`);
    }
    out.verdict = verdict;
    if (missingShots.length) throw new Error(`missing evidence screenshot(s): ${missingShots.join(', ')}`);

    for (const key of fieldKeys) {
      const f = verdict.fields[key];
      if (f.status === 'fail') {
        const expectedKey = Object.prototype.hasOwnProperty.call(FIELD_EXPECTED_KEY, key) ? FIELD_EXPECTED_KEY[key] : key;
        out.mismatches.push({
          field: key,
          expected: expectedKey ? (expected[expectedKey] ?? null) : null,
          observed: f.observed,
          note: f.note || '',
          screenshot: f.screenshot,
        });
      }
    }
    out.status = verdict.overall === 'pass' ? VERIFY_STATUS.pass : VERIFY_STATUS.fail;
    log(`${sid}: verdict ${verdict.overall}${out.mismatches.length ? ` (${out.mismatches.map((m) => m.field).join(', ')})` : ''}`);
  } catch (err) {
    out.status = VERIFY_STATUS.verifierError;
    out.error = err.message;
    log(`${sid}: verifier error — ${err.message}`);
  }
  return finish();
}
