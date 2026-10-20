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
  VERIFIER_TOOL_BUDGET,
} from './config.mjs';
import { runAsync } from './proc.mjs';

/** The seven fields every verdict must carry, in report order. */
export const VERDICT_FIELDS = Object.freeze(['model', 'skills', 'rules', 'workflows', 'subagents', 'mcp', 'prompt']);
const STATUSES = new Set(['pass', 'fail']);

/** Mandatory evidence screenshots, one per checked view (relative to the scenario's shot dir). */
export const EVIDENCE_SHOTS = Object.freeze([
  Object.freeze({ label: 'summary', file: 'summary.png' }),
  Object.freeze({ label: 'harness-usage', file: 'harness-usage.png' }),
  Object.freeze({ label: 'logs', file: 'logs.png' }),
]);

// The 3 mandatory screenshots get their own calls on top of the measured budget.
export const VERIFIER_CALL_BUDGET = VERIFIER_TOOL_BUDGET + EVIDENCE_SHOTS.length + 2;

export const VERIFY_TEMPLATE_FILE = path.join(PROMPTS_DIR, 'verify-session.md');

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
 * Validates a verdict object against API changes → "Verifier verdict".
 * Returns { ok, errors } — never throws.
 */
export function validateVerdict(json) {
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
  for (const key of VERDICT_FIELDS) {
    const f = fields[key];
    if (!f || typeof f !== 'object') {
      errors.push(`fields.${key} is missing`);
      continue;
    }
    if (!STATUSES.has(f.status)) errors.push(`fields.${key}.status must be pass|fail, got ${JSON.stringify(f.status)}`);
    if (f.observed === undefined) errors.push(`fields.${key}.observed is missing`);
    if (!isRelativeShot(f.screenshot)) {
      errors.push(`fields.${key}.screenshot must be a non-empty relative path, got ${JSON.stringify(f.screenshot)}`);
    }
  }
  if (errors.length === 0) {
    const allPass = VERDICT_FIELDS.every((k) => fields[k].status === 'pass');
    if (json.overall === 'pass' && !allPass) errors.push('"overall" is pass but a field failed');
    if (json.overall === 'fail' && allPass) errors.push('"overall" is fail but every field passed');
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
 * scenario — a SCENARIOS entry; expected — the FR-8 expected params (with `session_id`);
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
    const creds = resolveOwner(owner);
    const { file: mcpFile, shotDir } = writeMcpConfig(runPaths, sid);
    fs.rmSync(verdictPath, { force: true });
    fs.mkdirSync(runPaths.verifyDir, { recursive: true });

    const tpl = fs.readFileSync(VERIFY_TEMPLATE_FILE, 'utf8');
    const prompt = fillTemplate(tpl, {
      TOOL_BUDGET: VERIFIER_CALL_BUDGET,
      SCENARIO_ID: sid,
      STAND_URL: standUrl,
      EMAIL: creds.email,
      PASSWORD: creds.password,
      SESSION_URL: sessionUrl(repoId, expected.session_id, standUrl),
      EXPECTED_JSON: JSON.stringify(
        {
          model: expected.model,
          skills: expected.skills,
          rules: expected.rules,
          workflows: expected.workflows,
          subagents: expected.subagents,
          mcp: expected.mcp ?? [],
          prompt: expected.prompt,
        },
        null,
        2,
      ),
      VERDICT_PATH: verdictPath,
      SHOT_DIR: shotDir,
      SHOT_REL: shotRel,
      SHOT_SUMMARY: path.join(shotDir, 'summary.png'),
      SHOT_HARNESS: path.join(shotDir, 'harness-usage.png'),
      SHOT_LOGS: path.join(shotDir, 'logs.png'),
      SHOT_MISMATCH_EXAMPLE: path.join(shotDir, 'skills-mismatch.png'),
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
    const check = validateVerdict(verdict);
    if (!check.ok) throw new Error(`invalid verdict: ${check.errors.join('; ')}`);

    const missingShots = [];
    for (const key of VERDICT_FIELDS) {
      const found = resolveShot(reportDir, shotDir, verdict.fields[key].screenshot);
      if (found) verdict.fields[key].screenshot = found;
      else missingShots.push(`${key} → ${verdict.fields[key].screenshot}`);
    }
    for (const shot of EVIDENCE_SHOTS) {
      const found = resolveShot(reportDir, shotDir, `${shotRel}/${shot.file}`);
      if (found) out.evidence.push({ label: shot.label, path: found });
      else missingShots.push(`${shot.label} → ${shotRel}/${shot.file}`);
    }
    out.verdict = verdict;
    if (missingShots.length) throw new Error(`missing evidence screenshot(s): ${missingShots.join(', ')}`);

    for (const key of VERDICT_FIELDS) {
      const f = verdict.fields[key];
      if (f.status !== 'pass') {
        out.mismatches.push({
          field: key,
          expected: expected[key],
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
