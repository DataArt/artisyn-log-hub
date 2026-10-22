// Sandbox pruning (DD-6) and the stale reminder (FR-E4).
//
// classifyPruneCandidate() is the pure classifier (the subject of the algorithm doc
// docs/knowledgebase/algorithms/sandbox-prune-classification.md): plain values in, an action out,
// no I/O. findOrphans() collects the leftovers DD-6 names (state without worktree, containers and
// volumes whose label matches no sandbox, per-sandbox DBs of orphans), buildPlan() combines both
// into what `--prune` (and the menu's prune screen) would remove and keep, printPlan() shows it and
// executePlan() runs it through the chunk 4 `--remove` steps.
import fs from 'node:fs';
import { STATE_VERSION, containerName, dbNames, parseAge, resolvePaths, staleAfterMs, worktreePath } from './config.mjs';
import {
  dbExists,
  dropDb,
  listLabeledContainers,
  listLabeledVolumes,
  listSandboxDbs,
  liveSessions,
  containerState,
  postgresReady,
  removeContainerByName,
  volumeRemove,
} from './docker.mjs';
import { pendingWork } from './git.mjs';
import { PHASE, formatAgo, pendingText, remove } from './sandbox.mjs';
import { listStates } from './state.mjs';

/** The classifier's actions (DD-6). */
export const PRUNE_ACTIONS = Object.freeze({
  notCandidate: 'not-candidate',
  liveSession: 'live-session',
  remove: 'remove',
  keepHasWork: 'keep-has-work',
  removeForce: 'remove-force',
});

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** An ISO string, a Date or epoch ms as epoch ms; NaN when absent or unparsable. */
function toMs(value) {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim() !== '') return Date.parse(value);
  return Number.NaN;
}

/** The `olderThan` option as ms: an age string (`15m`, `2h`, `7d`), a number of ms, or 0 when absent. */
function olderThanToMs(olderThan) {
  if (olderThan === undefined || olderThan === null || olderThan === '') return 0;
  if (typeof olderThan === 'number') return olderThan;
  const ms = parseAge(olderThan);
  if (ms === null) throw new Error(`olderThan "${olderThan}" is not an age like 15m, 2h or 7d`);
  return ms;
}

/**
 * Classifies one sandbox for pruning (DD-6). Pure: no I/O, no clock — `now` is an input.
 *
 * input:
 *   containerState  'running' | 'stopped' | 'missing'
 *   liveSessions    number of live Claude sessions in the container
 *   lastActivity    ISO time (or ms) of the last session/shell; absent = infinitely old
 *   now             ISO time (or ms) the age is measured against
 *   files           uncommitted changes (`git status --porcelain` line count)
 *   base            the base branch name, or null
 *   isAncestor      `git merge-base --is-ancestor <branch> <base>` succeeded
 *   branchCreated   the launcher created the branch
 * opts:
 *   olderThan       age (`7d`) or ms; only sandboxes at least this old are candidates (default 0)
 *   includeRunning  running containers are candidates too (default false)
 *   force           remove sandboxes that have work, keeping their branch (default false)
 *
 * Returns { action, deleteBranch, reason } where action is one of PRUNE_ACTIONS:
 *   not-candidate   running without includeRunning, or younger than olderThan
 *   live-session    a live Claude session — never removed, even with force
 *   remove          clean, base set and merged into it; deleteBranch = branchCreated
 *   keep-has-work   anything else, without force
 *   remove-force    has work and force; deleteBranch = false
 */
export function classifyPruneCandidate(input, opts = {}) {
  const s = input || {};
  const olderThanMs = olderThanToMs(opts.olderThan);
  const running = s.containerState === 'running';
  if (running && !opts.includeRunning) {
    return { action: PRUNE_ACTIONS.notCandidate, deleteBranch: false, reason: 'running (add --include-running)' };
  }
  const last = toMs(s.lastActivity);
  const age = Number.isNaN(last) ? Number.POSITIVE_INFINITY : toMs(s.now) - last;
  if (!(age >= olderThanMs)) {
    return { action: PRUNE_ACTIONS.notCandidate, deleteBranch: false, reason: 'active more recently than --older-than' };
  }
  const sessions = Number(s.liveSessions) || 0;
  if (sessions > 0) {
    return {
      action: PRUNE_ACTIONS.liveSession,
      deleteBranch: false,
      reason: `${plural(sessions, 'live Claude session')}; never pruned, even with --force`,
    };
  }
  const files = Number(s.files) || 0;
  if (files === 0 && s.base && s.isAncestor) {
    return {
      action: PRUNE_ACTIONS.remove,
      deleteBranch: Boolean(s.branchCreated),
      reason: `clean, merged into ${s.base}`,
    };
  }
  const work = [];
  if (files > 0) work.push(plural(files, 'uncommitted change'));
  if (!s.base) work.push('no base branch to check it is merged');
  else if (!s.isAncestor) work.push(`not merged into ${s.base}`);
  if (opts.force) {
    return {
      action: PRUNE_ACTIONS.removeForce,
      deleteBranch: false,
      reason: `${work.join(' · ')}; removed with --force, branch kept`,
    };
  }
  return { action: PRUNE_ACTIONS.keepHasWork, deleteBranch: false, reason: work.join(' · ') };
}

// ---------------------------------------------------------------------------------------------
// Orphans (DD-6)
// ---------------------------------------------------------------------------------------------

/** Directory names under the worktrees dir (the `.sandboxes` state dir and other dot dirs excluded). */
function worktreeDirNames(paths) {
  let entries;
  try {
    entries = fs.readdirSync(paths.worktreesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

/**
 * Finds what DD-6 calls orphans. N = the state-file names ∪ the worktree dir names.
 *   orphanSandboxes     states whose worktree is gone: they get the full removal steps
 *   statelessWorktrees  worktree dirs without a state file: never removed, only reported
 *   strayContainers     containers labelled `log-hub.sandbox=<x>` with x not in N
 *   strayVolumes        volumes labelled `log-hub.sandbox=<x>` with x not in N
 *   orphanDbs           [{ db, sandbox }]: existing DBs that are exactly log_hub_<n> /
 *                       log_hub_<n>_test of an orphan sandbox n (dbsChecked/dbsNote tell whether
 *                       they could be looked up)
 * Needs a reachable Docker daemon.
 */
export function findOrphans(paths = resolvePaths(), states = listStates(paths)) {
  const stateNames = new Set(states.map((s) => s.name));
  const worktreeNames = new Set(worktreeDirNames(paths));
  const names = new Set([...stateNames, ...worktreeNames]);

  const orphanSandboxes = states.filter((s) => !fs.existsSync(s.worktree || worktreePath(s.name, paths)));
  const statelessWorktrees = [...worktreeNames].filter((n) => !stateNames.has(n)).sort();
  const strayContainers = listLabeledContainers().filter((c) => !names.has(c.sandbox));
  const strayVolumes = listLabeledVolumes().filter((v) => !names.has(v.sandbox));

  const { orphanDbs, dbsChecked, dbsNote } = findOrphanDbs(orphanSandboxes.map((s) => s.name));
  return { names, orphanSandboxes, statelessWorktrees, strayContainers, strayVolumes, orphanDbs, dbsChecked, dbsNote };
}

/**
 * The DD-6 DB rule: a database is an orphan only when its name, as listed by listSandboxDbs(), is
 * exactly (string equality) one of dbNames(n) — `log_hub_<n_>` or `log_hub_<n_>_test` — for an
 * orphan sandbox name n. No prefix or pattern match: a DB of a live sandbox, of a stateless
 * worktree or any other `log_hub_*` database is never selected. When log-hub-postgres does not
 * answer, nothing is selected and dbsChecked is false (dbsNote says why).
 */
function findOrphanDbs(orphanNames) {
  if (PHASE < STATE_VERSION || orphanNames.length === 0) {
    return { orphanDbs: [], dbsChecked: PHASE >= STATE_VERSION, dbsNote: null };
  }
  if (!postgresReady()) {
    return { orphanDbs: [], dbsChecked: false, dbsNote: 'log-hub-postgres is not running' };
  }
  let existing;
  try {
    existing = listSandboxDbs();
  } catch (err) {
    return { orphanDbs: [], dbsChecked: false, dbsNote: err.message.split('\n')[0] };
  }
  const orphanDbs = [];
  for (const n of orphanNames) {
    for (const wanted of dbNames(n)) {
      if (existing.some((db) => db === wanted)) orphanDbs.push({ db: wanted, sandbox: n });
    }
  }
  return { orphanDbs, dbsChecked: true, dbsNote: null };
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

/** pendingWork() that yields null instead of throwing on a broken worktree. */
function safePendingWork(s) {
  try {
    return pendingWork(s);
  } catch {
    return null;
  }
}

/**
 * Builds the prune plan. opts: { olderThan (age string, default none = every age), force,
 * includeRunning, now (ms, default Date.now()) }. Needs Docker.
 * Returns {
 *   opts,
 *   remove: [{ kind: 'sandbox', name, branch, base, lastActivity, deleteBranch, force, orphan, reason }],
 *   keep:   [{ name, branch, lastActivity, action, reason }],   (live sessions and sandboxes with work)
 *   skipped: [{ name, reason }],                                 (not candidates)
 *   strayContainers, strayVolumes,
 *   orphanDbs [{ db, sandbox }] (only of orphans in `remove`), dbsChecked, dbsNote
 * }
 */
export function buildPlan(opts = {}, paths = resolvePaths()) {
  const classifyOpts = {
    olderThan: opts.olderThan,
    force: Boolean(opts.force),
    includeRunning: Boolean(opts.includeRunning),
  };
  olderThanToMs(classifyOpts.olderThan); // validate up front
  const now = opts.now ?? Date.now();
  const states = listStates(paths);
  const orphans = findOrphans(paths, states);
  const orphanNames = new Set(orphans.orphanSandboxes.map((s) => s.name));

  const plan = {
    opts: { ...classifyOpts },
    remove: [],
    keep: [],
    skipped: [],
    strayContainers: orphans.strayContainers,
    strayVolumes: orphans.strayVolumes,
    orphanDbs: orphans.orphanDbs,
    dbsChecked: orphans.dbsChecked,
    dbsNote: orphans.dbsNote,
  };

  for (const s of states) {
    const cs = containerState(s.name);
    const sessions = cs === 'running' ? liveSessions(s.name) : 0;
    const base = s.base ?? null;
    const row = { name: s.name, branch: s.branch ?? null, base, lastActivity: s.lastActivity ?? null };

    if (orphanNames.has(s.name)) {
      // State without a worktree: full removal steps; the branch only if the launcher created it,
      // via `git branch -d`, which refuses an unmerged branch with a warning.
      if (sessions > 0) {
        plan.keep.push({
          ...row,
          action: PRUNE_ACTIONS.liveSession,
          reason: `worktree missing, but ${plural(sessions, 'live Claude session')}; never pruned, even with --force`,
        });
      } else {
        plan.remove.push({
          kind: 'sandbox',
          ...row,
          deleteBranch: Boolean(s.branchCreated),
          force: true,
          orphan: true,
          reason: 'worktree missing (orphan state)',
        });
      }
      continue;
    }

    const pending = safePendingWork(s);
    if (!pending) {
      plan.keep.push({ ...row, action: PRUNE_ACTIONS.keepHasWork, reason: 'cannot read pending work' });
      continue;
    }
    const verdict = classifyPruneCandidate(
      {
        containerState: cs,
        liveSessions: sessions,
        lastActivity: s.lastActivity,
        now,
        files: pending.files,
        base,
        isAncestor: pending.merged,
        branchCreated: Boolean(s.branchCreated),
      },
      classifyOpts,
    );
    switch (verdict.action) {
      case PRUNE_ACTIONS.notCandidate:
        plan.skipped.push({ name: s.name, reason: verdict.reason });
        break;
      case PRUNE_ACTIONS.remove:
      case PRUNE_ACTIONS.removeForce:
        plan.remove.push({
          kind: 'sandbox',
          ...row,
          deleteBranch: verdict.deleteBranch,
          force: verdict.action === PRUNE_ACTIONS.removeForce,
          orphan: false,
          reason: verdict.action === PRUNE_ACTIONS.remove ? verdict.reason : `${pendingText(pending, base)}; --force, branch kept`,
        });
        break;
      default:
        plan.keep.push({
          ...row,
          action: verdict.action,
          reason: verdict.action === PRUNE_ACTIONS.keepHasWork ? `${pendingText(pending, base)} (${verdict.reason})` : verdict.reason,
        });
    }
  }

  for (const name of orphans.statelessWorktrees) {
    plan.keep.push({
      name,
      branch: null,
      lastActivity: null,
      action: 'stateless-worktree',
      reason: `worktree without state; kept: run --remove ${name}`,
    });
  }
  // DBs of an orphan that is kept (a live session) stay with it.
  const removedOrphans = new Set(plan.remove.filter((r) => r.orphan).map((r) => r.name));
  plan.orphanDbs = plan.orphanDbs.filter((d) => removedOrphans.has(d.sandbox));
  return plan;
}

/** Number of things executePlan() would remove. */
export function planSize(plan) {
  return plan.remove.length + plan.strayContainers.length + plan.strayVolumes.length + plan.orphanDbs.length;
}

/** Prints the plan: what is removed, what is kept and why. */
export function printPlan(plan, out = process.stdout, now = Date.now()) {
  const w = (line = '') => out.write(`${line}\n`);
  const age = plan.opts.olderThan ? `older than ${plan.opts.olderThan}` : 'any age';
  const candidates = plan.opts.includeRunning ? 'stopped, missing and idle running containers' : 'stopped / missing containers';
  w(`Prune plan · ${age} · candidates: ${candidates}${plan.opts.force ? ' · --force' : ''}`);
  w();
  w('Will remove:');
  if (planSize(plan) === 0) w('  (nothing)');
  for (const r of plan.remove) {
    const branch = r.branch ? (r.deleteBranch ? `deletes branch ${r.branch}` : `keeps branch ${r.branch}`) : 'no branch';
    w(`  ${r.name}  — ${r.reason}; ${branch}; last activity ${formatAgo(r.lastActivity, now)}`);
  }
  for (const c of plan.strayContainers) w(`  container ${c.name}  — no sandbox named ${c.sandbox}`);
  for (const v of plan.strayVolumes) w(`  volume ${v.name}  — no sandbox named ${v.sandbox}`);
  for (const d of plan.orphanDbs) w(`  database ${d.db}  — sandbox ${d.sandbox} is an orphan`);
  w();
  w('Will keep:');
  if (plan.keep.length === 0) w('  (nothing)');
  for (const k of plan.keep) {
    const branch = k.branch ? `branch ${k.branch}; ` : '';
    w(`  ${k.name}  — ${k.reason}${k.lastActivity ? `; ${branch}last activity ${formatAgo(k.lastActivity, now)}` : ''}`);
  }
  if (plan.skipped.length > 0) {
    w();
    w(`Not candidates: ${plan.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`);
  }
  if (!plan.dbsChecked) {
    w();
    w(
      `Databases: not checked${plan.dbsNote ? ` (${plan.dbsNote})` : ''}; ` +
        'removing a sandbox still drops its own databases.',
    );
  }
}

/**
 * Runs the plan: each sandbox through the `--remove` steps (with that action's force and
 * deleteBranch), then the stray containers, volumes and orphan DBs. A failure is reported and the
 * rest still runs. Returns { removed, failed: [{ what, message }], exitCode }.
 */
export async function executePlan(plan, paths = resolvePaths(), out = process.stdout) {
  let removed = 0;
  const failed = [];
  let exitCode = 0;
  const attempt = async (what, fn) => {
    try {
      const code = await fn();
      removed++;
      if (typeof code === 'number' && code !== 0) exitCode = code;
    } catch (err) {
      failed.push({ what, message: err.message });
      out.write(`failed to remove ${what}: ${err.message}\n`);
      exitCode = 1;
    }
  };

  for (const r of plan.remove) {
    out.write(`\n— ${r.name}\n`);
    await attempt(`sandbox ${r.name}`, () => remove(r.name, { force: r.force, deleteBranch: r.deleteBranch }, paths));
  }
  for (const c of plan.strayContainers) {
    await attempt(`container ${c.name}`, () => {
      if (removeContainerByName(c.name).removed) out.write(`removed container ${c.name}\n`);
      return 0;
    });
  }
  for (const v of plan.strayVolumes) {
    await attempt(`volume ${v.name}`, () => {
      if (volumeRemove(v.name).removed) out.write(`removed volume ${v.name}\n`);
      return 0;
    });
  }
  // An orphan sandbox's `--remove` steps above already drop its two DBs; this pass catches the
  // ones left when that removal failed. Only the exact names chosen by findOrphanDbs() are touched.
  for (const { db } of plan.orphanDbs) {
    await attempt(`database ${db}`, () => {
      if (dbExists(db)) {
        dropDb(db);
        out.write(`dropped database ${db}\n`);
      }
      return 0;
    });
  }
  out.write(`\npruned ${plural(removed, 'item')}${failed.length > 0 ? `, ${failed.length} failed` : ''}\n`);
  return { removed, failed, exitCode };
}

// ---------------------------------------------------------------------------------------------
// Stale reminder (FR-E4)
// ---------------------------------------------------------------------------------------------

/**
 * Printed on every launch: the sandboxes whose lastActivity is older than CLAUDE_DOCKER_STALE_AFTER
 * (default 7d), with branch, last activity and pending work, ending with the prune command.
 * `exclude` is the sandbox just used. Never throws: a failure becomes a one-line warning.
 */
export function printStaleReminder({ exclude = null, now = Date.now(), out = process.stdout } = {}, paths = resolvePaths()) {
  try {
    const stale = staleAfterMs();
    const rows = listStates(paths)
      .filter((s) => s.name !== exclude)
      .filter((s) => {
        const last = Date.parse(s.lastActivity ?? '');
        return Number.isNaN(last) || now - last > stale.ms;
      });
    if (rows.length === 0) return 0;
    out.write(`\nStale sandboxes (no activity for more than ${stale.text}):\n`);
    for (const s of rows) {
      const worktree = s.worktree || worktreePath(s.name, paths);
      const pending = fs.existsSync(worktree) ? safePendingWork({ ...s, worktree }) : null;
      const work = fs.existsSync(worktree) ? pendingText(pending, s.base ?? null) : 'worktree missing';
      out.write(
        `  ${s.name}  branch ${s.branch ?? '-'} · last activity ${formatAgo(s.lastActivity, now)} · ${work}` +
          `  (${containerName(s.name)})\n`,
      );
    }
    out.write(`Clean up: scripts/claude-docker.ps1 --prune --older-than ${stale.text}\n`);
    return rows.length;
  } catch (err) {
    process.stderr.write(`warning: stale reminder skipped: ${err.message.split('\n')[0]}\n`);
    return 0;
  }
}
