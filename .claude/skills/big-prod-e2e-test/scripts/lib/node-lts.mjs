// FR-NODE (phase P5c): the hook must run on every current Node.js LTS line, because it runs with
// the user's own `node` from PATH (docs/knowledgebase/hook-system-overview.md, "Runs on every
// current Node.js LTS"). For each Node image tag this runs, in throwaway `docker run --rm
// --network none` containers: the hook algorithm tests (hook/ from the git root) and
// `node-lts/smoke.cjs` against the plugin this run installed, in a CommonJS repo, an ESM repo
// (`"type": "module"`) and a repo without package.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsync } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SMOKE_DIR = path.resolve(here, '..', 'node-lts');

export const NODE_SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
// The official images' mirror: Docker Hub's anonymous pull rate limit (429) hit during the PoC.
export const NODE_IMAGE_REPO = 'public.ecr.aws/docker/library/node';
export const NODE_IMAGE_VARIANT = 'bookworm'; // full image: has git, which smoke.cjs needs
// The engines floor in hook/package.json, always tested on top of the live lines.
export const NODE_ENGINES_FLOOR = '18.19.0';
// Used only when schedule.json cannot be fetched (recorded in the detail).
export const NODE_FALLBACK_MAJORS = Object.freeze(['22', '24', '26']);
export const NODE_REPO_KINDS = Object.freeze(['cjs', 'esm', 'none']);
const PULL_TIMEOUT_MS = 15 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

const toDocker = (p) => path.resolve(p).replace(/\\/g, '/');

/**
 * Even release lines alive on `today` (YYYY-MM-DD) per the nodejs/Release schedule: active or
 * maintenance LTS, plus an even Current line that is scheduled to become LTS (an early warning).
 * Odd lines never become LTS and are skipped. Returns [{ major, status, end }] sorted by major.
 */
export function liveLtsLines(schedule, today) {
  const lines = [];
  for (const [ver, s] of Object.entries(schedule ?? {})) {
    const major = ver.replace(/^v/, '');
    if (!/^\d+$/.test(major) || Number(major) % 2 !== 0) continue;
    if (!s?.start || s.start > today || !s.end || s.end <= today || !s.lts) continue;
    let status;
    if (s.lts > today) status = `Current (LTS from ${s.lts})`;
    else status = s.maintenance && s.maintenance <= today ? 'Maintenance LTS' : 'Active LTS';
    lines.push({ major, status, end: s.end });
  }
  return lines.sort((a, b) => Number(a.major) - Number(b.major));
}

/** The image tags to test: the engines floor plus every live line (fallback majors when offline). */
export async function nodeTags({ today = new Date().toISOString().slice(0, 10), fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(NODE_SCHEDULE_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lines = liveLtsLines(await res.json(), today);
    if (lines.length === 0) throw new Error('no live LTS line in the schedule');
    return { tags: [NODE_ENGINES_FLOOR, ...lines.map((l) => l.major)], lines, scheduleError: null };
  } catch (err) {
    return { tags: [NODE_ENGINES_FLOOR, ...NODE_FALLBACK_MAJORS], lines: null, scheduleError: err.message };
  }
}

async function docker(args, timeoutMs = RUN_TIMEOUT_MS) {
  const r = await runAsync('docker', args, { timeoutMs });
  return { ...r, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function ensureImage(image) {
  if ((await docker(['image', 'inspect', image])).exitCode === 0) return null;
  const r = await docker(['pull', '-q', image], PULL_TIMEOUT_MS);
  return r.exitCode === 0 ? null : `pull ${image} failed: ${r.stderr.trim().slice(0, 300)}`;
}

/** Hook algorithm tests inside the container; hook/ needs scripts/algo-docs and the algorithm docs. */
async function runAlgo(image, gitRoot) {
  const sh =
    'mkdir -p /w/repo && cd /src && tar --exclude=./hook/node_modules -cf - ./hook ./scripts/algo-docs ' +
    './docs/knowledgebase/algorithms | tar -xf - -C /w/repo && cd /w/repo/hook && node scripts/run-tests.js';
  const r = await docker(['run', '--rm', '--network', 'none', '-v', `${toDocker(gitRoot)}:/src:ro`, image, 'sh', '-c', sh]);
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (k) => {
    const m = out.match(new RegExp(`^(?:#|ℹ) ${k} (\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const failLines = out.split(/\r?\n/).filter((l) => /^not ok|✖/.test(l.trim())).slice(0, 5);
  return { ok: r.exitCode === 0 && !r.timedOut, tests: num('tests'), fail: num('fail'), failLines };
}

async function runSmoke(image, kind, pluginDir) {
  const r = await docker([
    'run', '--rm', '--network', 'none',
    '-v', `${toDocker(pluginDir)}:/plugin:ro`,
    '-v', `${toDocker(SMOKE_DIR)}:/h:ro`,
    image, 'node', '/h/smoke.cjs', '--plugin', '/plugin', '--kind', kind, '--work', '/tmp/smoke',
  ]);
  const line = r.stdout.trim().split(/\r?\n/).pop() || '';
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, kind, steps: [], notes: [`no JSON (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 400)}`] };
  }
}

/** First problem of a failed smoke result, for the one-line detail. */
export function smokeProblem(res) {
  for (const s of res.steps ?? []) if (s.errors?.length) return `${s.event}/${s.script}: ${s.errors[0]}`;
  return res.hookLogErrors?.[0] ?? res.notes?.[0] ?? 'failed';
}

/**
 * Pure verdict over the matrix rows ({ tag, node?, error?, algo?, smoke? }): ok only when every
 * row ran and every cell passed. Returns { ok, cells, problems } — cells like "24/esm".
 */
export function judgeNodeMatrix(rows, kinds = NODE_REPO_KINDS) {
  const problems = [];
  let cells = 0;
  for (const r of rows) {
    const label = r.node ? `${r.tag} (${r.node})` : r.tag;
    if (r.error) {
      problems.push(`${label}: ${r.error}`);
      continue;
    }
    cells++;
    if (!r.algo?.ok) problems.push(`${label} algo: ${r.algo?.failLines?.[0] ?? `fail ${r.algo?.fail ?? '?'}`}`);
    for (const kind of kinds) {
      cells++;
      const s = r.smoke?.[kind];
      if (!s) problems.push(`${label} smoke ${kind}: not run`);
      else if (!s.ok) problems.push(`${label} smoke ${kind}: ${smokeProblem(s)}`);
    }
  }
  if (rows.length === 0) problems.push('no Node version was tested');
  return { ok: problems.length === 0, cells, problems };
}

/**
 * Runs the whole matrix. `pluginDir` is an installed `log-hub-hooks` plugin dir, `gitRoot` holds
 * hook/. Writes `resultFile` (JSON) and resolves { rows, tags, lines, scheduleError }.
 */
export async function runNodeLtsMatrix({ pluginDir, gitRoot, resultFile, log = () => {} }) {
  const { tags, lines, scheduleError } = await nodeTags();
  log(
    scheduleError
      ? `schedule.json unavailable (${scheduleError}); testing fallback tags ${tags.join(', ')}`
      : `live lines: ${lines.map((l) => `v${l.major} ${l.status}`).join(', ')}; tags ${tags.join(', ')}`,
  );
  const rows = [];
  for (const tag of tags) {
    const image = `${NODE_IMAGE_REPO}:${tag}-${NODE_IMAGE_VARIANT}`;
    const row = { tag, image };
    const pullError = await ensureImage(image);
    if (pullError) {
      row.error = pullError;
      rows.push(row);
      log(`${tag}: ${pullError}`);
      continue;
    }
    row.node = (await docker(['run', '--rm', '--network', 'none', image, 'node', '--version'])).stdout.trim();
    row.algo = await runAlgo(image, gitRoot);
    row.smoke = {};
    for (const kind of NODE_REPO_KINDS) row.smoke[kind] = await runSmoke(image, kind, pluginDir);
    rows.push(row);
    const cells = [`algo ${row.algo.ok ? 'ok' : 'FAIL'}`, ...NODE_REPO_KINDS.map((k) => `${k} ${row.smoke[k].ok ? 'ok' : 'FAIL'}`)];
    log(`${tag} (${row.node}): ${cells.join(', ')}`);
  }
  if (resultFile) {
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, `${JSON.stringify({ tags, lines, scheduleError, rows }, null, 2)}\n`);
  }
  return { rows, tags, lines, scheduleError };
}
