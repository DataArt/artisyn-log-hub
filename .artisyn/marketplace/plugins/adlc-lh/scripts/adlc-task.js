#!/usr/bin/env node
// Resolves a task id to the WHOLE paths of that task's docs, and prints them.
//
// Every task skill used to carry the same paragraph of glob instructions, and
// every one of them ended with the model assembling paths by hand
// ("docs/tasks/todo/" + id + "-" + slug + "/impl-plan.md"). Both jobs move here:
// the lookup is done by code, and what comes back are finished strings the skill
// copies verbatim. Where those paths are rooted is repo-config.js's business --
// this file only knows task ids, folder names, and what to print.
//
// Every path it prints is absolute, so it is correct from any working directory
// -- including a session Claude Code started in a subdirectory of the project.
//
// Usage:
//   node adlc-task.js --list [--project <dir>] [--json]
//   node adlc-task.js --task <task-id> [--project <dir>] [--json]
//   node adlc-task.js --new <task-id> --slug <slug> [--followup] [--project <dir>] [--json]
//   node adlc-task.js --paths [--project <dir>] [--json]
//
// --list and --paths take no task id, which is why they are the two modes a
// skill injects with `` !`...` ``: a skill CAN interpolate $ARGUMENTS into an
// injected command -- the substitution happens first -- but then a task id of
// `$(whoami)` executes, unprompted, before Claude reads a word of the skill.
// Those two modes carry nothing across the shell boundary, so the skill gets its
// answer with no tool call and no argument to smuggle anything through. An
// injected command that fails also aborts the whole skill invocation, so neither
// mode ever exits non-zero.
//
// Exit codes: 0 for every resolution outcome (including not-found -- that is an
// answer, not a failure, and the calling skill has prose for it), 1 only for a
// usage error or a broken `paths` config, which a person has to fix.
const fs = require('fs');
const path = require('path');
const repoConfig = require('./repo-config');

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { out.json = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = '';
      } else {
        out[key] = next;
        i += 1;
      }
      continue;
    }
    // A bare first token is accepted as the task id so `--task` can be omitted.
    if (!out.task && !out.new) out.task = arg;
  }
  return out;
}

// Folder names are `<task-id>` or `<task-id>-<slug>`. Comparison is
// case-insensitive because Windows checkouts are, and because a user typing
// `proj-123` means the same task as `PROJ-123`.
function matchesId(folderName, taskId) {
  const name = folderName.toLowerCase();
  const id = taskId.toLowerCase();
  return name === id || name.startsWith(`${id}-`);
}

function listTaskFolders(projectRoot, relDir) {
  const absolute = path.join(projectRoot, relDir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function findIn(projectRoot, relDir, taskId) {
  // Exact name first: when both `PROJ-123` and `PROJ-123-slug` exist, the id the
  // user typed in full is the one they meant.
  const all = listTaskFolders(projectRoot, relDir).filter((name) => matchesId(name, taskId));
  const exact = all.filter((name) => name.toLowerCase() === taskId.toLowerCase());
  return (exact.length ? exact : all).sort();
}

// Last resort before reporting nothing: the index can name a task whose folder
// does not carry the id at all -- an idea scratched as `2026-08-11-export-csv`
// and later linked to `PROJ-123` is the usual way that happens. So take every
// index line that mentions the id, and report the folders those lines point at
// that actually exist. Scanning for folders whose NAME matches the id would add
// nothing here: the directory listing above already did exactly that.
function findViaIndex(projectRoot, paths, taskId) {
  const indexPath = path.join(projectRoot, paths.todoIndex);
  if (!fs.existsSync(indexPath)) return [];
  let text;
  try {
    text = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return [];
  }
  const folders = new Set(listTaskFolders(projectRoot, paths.todoDir));
  const id = taskId.toLowerCase();
  const hits = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.toLowerCase().includes(id)) continue;
    for (const token of line.split(/[^A-Za-z0-9._-]+/)) {
      if (token.length > 1 && folders.has(token)) hits.add(token);
    }
  }
  return [...hits].sort();
}

function taskFilePaths(paths, dir, folderName) {
  const taskDir = `${dir}/${folderName}`;
  return {
    taskFolderName: folderName,
    taskDir,
    requirements: `${taskDir}/${paths.requirementsFile}`,
    implPlan: `${taskDir}/${paths.implPlanFile}`,
  };
}

// A date id (`2026-08-21`) is shared on purpose: adlc-lh:scratch uses today's date
// for every idea-mode task, so a day with two ideas has two folders whose names
// both start with it. A tracker key is the opposite -- `PROJ-123-anything` IS
// task PROJ-123, and a second folder for it is the collision adlc-lh:scratch must
// refuse. So the two kinds of id cannot share one collision rule.
function isDateId(taskId) {
  return /^\d{4}-\d{2}-\d{2}$/.test(taskId);
}

// Collision check for --new. For a tracker key this is the same lookup as
// resolve(): any folder carrying the key is the answer. Two cases need the
// narrower rule -- only the exact folder about to be created counts:
//
//   * a date id, where prefix matching would report today's unrelated,
//     already-archived task as this one and stop the skill on a task nobody has
//     scratched yet;
//   * --followup, where the caller KNOWS the key is already scratched and is
//     deliberately adding a second task under it (the little fix that comes out
//     of the first one's implementation).
//
// A bare `<task-id>` folder counts as a clash under the date rule -- that is the
// name that run would have to write into -- but not under --followup, where the
// folder being claimed always carries a slug.
function resolveNew(config, paths, taskId, slug, followup) {
  const dateId = isDateId(taskId);
  if (!dateId && !followup) return resolve(config, paths, taskId);

  const exact = `${taskId}-${slug}`.toLowerCase();
  const wanted = new Set(dateId ? [taskId.toLowerCase(), exact] : [exact]);
  const matching = (relDir) => listTaskFolders(config.projectRoot, relDir)
    .filter((name) => wanted.has(name.toLowerCase())).sort();

  const inTodo = matching(paths.todoDir);
  if (inTodo.length) return { status: 'found-in-todo', matchedVia: 'folder-name', folders: inTodo, dir: paths.todoDir };

  const inDone = matching(paths.doneDir);
  if (inDone.length) return { status: 'found-in-done', matchedVia: 'folder-name', folders: inDone, dir: paths.doneDir };

  return { status: 'not-found', folders: [] };
}

// The tasks already scratched under this id, for a --followup run to point at:
// the new requirements doc has to say what it is a follow-up TO, and the folder
// holding the original is the only place that answer lives. Date ids get nothing
// here -- tasks sharing a date have nothing to do with each other.
function findRelated(config, paths, taskId, slug) {
  if (isDateId(taskId)) return [];
  const claimed = `${taskId}-${slug}`.toLowerCase();
  const inDir = (relDir) => findIn(config.projectRoot, relDir, taskId)
    .filter((name) => name.toLowerCase() !== claimed)
    .map((name) => `${relDir}/${name}`);
  return [...inDir(paths.todoDir), ...inDir(paths.doneDir)];
}

function resolve(config, paths, taskId) {
  const root = config.projectRoot;
  const inTodo = findIn(root, paths.todoDir, taskId);
  if (inTodo.length === 1) return { status: 'found-in-todo', matchedVia: 'folder-name', folders: inTodo };
  if (inTodo.length > 1) return { status: 'ambiguous', matchedVia: 'folder-name', folders: inTodo, dir: paths.todoDir };

  const viaIndex = findViaIndex(root, paths, taskId);
  if (viaIndex.length === 1) return { status: 'found-in-todo', matchedVia: 'index', folders: viaIndex };
  if (viaIndex.length > 1) return { status: 'ambiguous', matchedVia: 'index', folders: viaIndex, dir: paths.todoDir };

  const inDone = findIn(root, paths.doneDir, taskId);
  if (inDone.length >= 1) return { status: 'found-in-done', matchedVia: 'folder-name', folders: inDone, dir: paths.doneDir };

  return { status: 'not-found', folders: [] };
}

// One entry per task folder, each carrying the whole path of every file that task
// owns. Archived tasks are names only: a skill that finds its task in `done` stops,
// so paths for it would be bytes in every injected block for nothing.
function listResult(config, paths, mode, limit) {
  const open = listTaskFolders(config.projectRoot, paths.todoDir).sort();
  const shown = open.slice(0, limit);
  return {
    ...baseResult(config, paths, mode),
    status: 'list',
    openTaskCount: open.length,
    truncated: open.length > shown.length ? { shown: shown.length, total: open.length } : null,
    tasks: shown.map((name) => {
      const task = taskFilePaths(paths, paths.todoDir, name);
      return {
        ...task,
        requirementsExists: config.exists(task.requirements),
        implPlanExists: config.exists(task.implPlan),
      };
    }),
    archived: buildArchived(listTaskFolders(config.projectRoot, paths.doneDir).sort(), limit),
  };
}

// The archived names exist so a skill can say "that task is done" without a tool
// call -- but a mature project archives tasks forever, so the same cap applies.
// Anything past it is covered by the --task fallback (status found-in-done).
function buildArchived(names, limit) {
  return {
    total: names.length,
    shown: names.slice(0, limit),
    truncated: names.length > limit,
  };
}

function baseResult(config, paths, mode) {
  return {
    mode,
    status: null,
    matchedVia: null,
    taskId: null,
    projectRoot: config.projectRoot,
    projectRootVia: `${config.projectRootVia} (from ${config.projectRootSource})`,
    todoDir: paths.todoDir,
    doneDir: paths.doneDir,
    todoIndex: paths.todoIndex,
    todoIndexExists: config.exists(paths.todoIndex),
    doneIndex: paths.doneIndex,
    doneIndexExists: config.exists(paths.doneIndex),
    warnings: config.warnings,
    candidates: [],
    related: [],
  };
}

function buildResult(config, paths, taskId, mode, slug, followup) {
  const found = mode === 'new'
    ? resolveNew(config, paths, taskId, slug, followup)
    : resolve(config, paths, taskId);
  const result = { ...baseResult(config, paths, mode), status: found.status, matchedVia: found.matchedVia || null, taskId };

  if (mode === 'new') {
    // A task id that already has a folder is the stop signal for adlc-lh:scratch:
    // someone scratched this task already, and a second folder for the same id
    // is exactly what must not be created.
    result.status = found.status === 'found-in-todo' ? 'exists-in-todo'
      : found.status === 'found-in-done' ? 'exists-in-done'
        : found.status === 'ambiguous' ? 'exists-in-todo'
          : 'available';
    if (result.status === 'available') {
      Object.assign(result, taskFilePaths(paths, paths.todoDir, `${taskId}-${slug}`));
      result.requirementsExists = false;
      result.implPlanExists = false;
      if (followup) result.related = findRelated(config, paths, taskId, slug);
    } else {
      const dir = found.status === 'found-in-done' ? paths.doneDir : paths.todoDir;
      result.candidates = found.folders.map((name) => `${dir}/${name}`);
      Object.assign(result, taskFilePaths(paths, dir, found.folders[0]));
      result.requirementsExists = config.exists(result.requirements);
      result.implPlanExists = config.exists(result.implPlan);
    }
    return result;
  }

  if (found.status === 'ambiguous') {
    result.candidates = found.folders.map((name) => `${found.dir}/${name}`);
    return result;
  }
  if (found.status === 'not-found') return result;

  const dir = found.status === 'found-in-done' ? paths.doneDir : paths.todoDir;
  Object.assign(result, taskFilePaths(paths, dir, found.folders[0]));
  result.requirementsExists = config.exists(result.requirements);
  result.implPlanExists = config.exists(result.implPlan);
  result.candidates = found.folders.map((name) => `${dir}/${name}`);

  if (found.status === 'found-in-todo') {
    result.archiveDest = `${paths.doneDir}/${result.taskFolderName}`;
  }
  return result;
}

// Everything above works in paths relative to the project root, because that is
// what the folder matching and the existence checks need. Everything a caller
// SEES is absolute: a skill running in a session started in `apps/web` would
// resolve a relative path against that directory, silently reading and writing
// under `apps/web/docs/tasks/`. The move commands are assembled here for the
// same reason -- they must be correct whatever the shell's cwd is.
const PATH_FIELDS = ['taskDir', 'requirements', 'implPlan', 'archiveDest', 'todoDir', 'doneDir', 'todoIndex', 'doneIndex'];

function finalize(config, result) {
  for (const field of PATH_FIELDS) {
    if (result[field]) result[field] = config.absolute(result[field]);
  }
  for (const task of result.tasks ?? []) {
    for (const field of PATH_FIELDS) {
      if (task[field]) task[field] = config.absolute(task[field]);
    }
  }
  result.candidates = result.candidates.map((candidate) => config.absolute(candidate));
  result.related = (result.related ?? []).map((task) => config.absolute(task));
  if (result.archiveDest) {
    result.moveCommandBash = `mv "${result.taskDir}" "${result.archiveDest}"`;
    result.moveCommandPowershell = `Move-Item -Path "${result.taskDir}" -Destination "${result.archiveDest}"`;
  }
  return result;
}

// The token block is the skill-facing format: one whole path per line, no value
// that has to be combined with another to be useful.
function render(result) {
  const lines = [];
  // In --new mode the task files are the ones about to be written, so flagging
  // them as MISSING would read as a problem instead of the expected state.
  const absentNote = result.mode === 'new' && result.status === 'available' ? '   (TO CREATE)' : '   (MISSING)';
  const put = (key, value, absent) => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`${key}: ${value}${absent ? absentNote : ''}`);
  };

  lines.push('<!-- adlc task paths: use these strings verbatim; never build a path from parts -->');
  put('STATUS', result.status);
  for (const warning of result.warnings ?? []) lines.push(`WARNING: ${warning}`);
  put('MATCHED_VIA', result.matchedVia);
  put('TASK_ID', result.taskId);
  put('TASK_FOLDER_NAME', result.taskFolderName);
  put('TASK_DIR', result.taskDir);
  put('REQUIREMENTS', result.requirements, result.requirementsExists === false);
  put('IMPL_PLAN', result.implPlan, result.implPlanExists === false);
  put('ARCHIVE_DEST', result.archiveDest);
  put('TODO_INDEX', result.todoIndex, !result.todoIndexExists);
  put('DONE_INDEX', result.doneIndex, !result.doneIndexExists);
  put('TODO_DIR', result.todoDir);
  put('DONE_DIR', result.doneDir);
  put('MOVE_COMMAND_BASH', result.moveCommandBash);
  put('MOVE_COMMAND_POWERSHELL', result.moveCommandPowershell);
  put('PROJECT_ROOT', result.projectRoot);
  put('PROJECT_ROOT_VIA', result.projectRootVia);
  if (result.candidates.length > 1 || result.status === 'ambiguous') {
    for (const candidate of result.candidates) lines.push(`CANDIDATE: ${candidate}`);
  }
  for (const task of result.related ?? []) lines.push(`RELATED_TASK: ${task}`);
  if (result.status === 'list') {
    put('OPEN_TASKS', String(result.openTaskCount));
    for (const task of result.tasks) {
      lines.push(`TASK: ${task.taskFolderName}`);
      lines.push(`  TASK_DIR: ${task.taskDir}`);
      lines.push(`  REQUIREMENTS: ${task.requirements}${task.requirementsExists ? '' : '   (MISSING)'}`);
      lines.push(`  IMPL_PLAN: ${task.implPlan}${task.implPlanExists ? '' : '   (MISSING)'}`);
    }
    if (result.archived.shown.length) {
      const extra = result.archived.truncated
        ? ` … and ${result.archived.total - result.archived.shown.length} more` : '';
      lines.push(`ARCHIVED: ${result.archived.shown.join(', ')}${extra}`);
    }
    if (result.truncated || result.archived.truncated) {
      const shown = result.truncated ? result.truncated.shown : result.openTaskCount;
      lines.push(`TRUNCATED: listed ${shown} of ${result.openTaskCount} open tasks — for any task ` +
        'not listed here, open or archived, run the resolver with --task <task-id>');
    }
  }
  return lines.join('\n');
}

const USAGE = 'usage: node adlc-task.js --list [--project <dir>] [--json]\n' +
  '       node adlc-task.js --task <task-id> [--project <dir>] [--json]\n' +
  '       node adlc-task.js --new <task-id> --slug <slug> [--followup] [--project <dir>] [--json]\n' +
  '       node adlc-task.js --paths [--project <dir>] [--json]';

// Enough to cover any real todo directory, and a ceiling so one runaway project
// cannot put thousands of lines in front of every skill. Past it the output says
// so -- a silently trimmed list reads as "these are all the tasks".
const LIST_LIMIT = 60;

function pickMode(args) {
  if ('list' in args) return 'list';
  if ('paths' in args) return 'paths';
  return repoConfig.clean(args.new) ? 'new' : 'resolve';
}

// The two argument-free modes are the ones skills inject, and an injected command
// that exits non-zero takes the whole skill invocation down with it -- so they
// report a broken config in their own output and still exit 0.
const args = parseArgs(process.argv.slice(2));
const mode = pickMode(args);
const injected = mode === 'list' || mode === 'paths';

try {
  const taskId = mode === 'new' ? repoConfig.clean(args.new) : repoConfig.clean(args.task);
  const slug = repoConfig.clean(args.slug);
  const followup = 'followup' in args;

  if (!injected) {
    if (followup && mode !== 'new') {
      throw new Error(`--followup only applies to --new\n${USAGE}`);
    }
    if (!taskId) throw new Error(`no task id given\n${USAGE}`);
    if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
      throw new Error(`task id must be a folder-name prefix ([A-Za-z0-9._-]), got "${taskId}"`);
    }
    if (mode === 'new' && !/^[a-z0-9-]+$/.test(slug)) {
      throw new Error(`slug must be kebab-case ([a-z0-9-]), got "${slug}"`);
    }
  }

  const config = repoConfig.load(args.project);
  const paths = config.taskPaths();
  const result = finalize(config,
    mode === 'list' ? listResult(config, paths, mode, LIST_LIMIT)
      : mode === 'paths' ? { ...baseResult(config, paths, mode), status: 'paths-only' }
        : buildResult(config, paths, taskId, mode, slug, followup));

  process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : render(result)}\n`);
  process.exit(0);
} catch (err) {
  if (!injected) process.stderr.write(`adlc-task error: ${err.message}\n`);
  process.stdout.write(`STATUS: error\nERROR: ${err.message}\n`);
  process.exit(injected ? 0 : 1);
}
