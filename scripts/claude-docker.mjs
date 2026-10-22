#!/usr/bin/env node
// claude-docker — per-task Claude Code sandboxes (git worktree + container) for this repo.
// Entry point: parses argv, validates flag combinations and dispatches to scripts/claude-docker/*.
// Usage errors exit 2; command failures exit 1; a session exits with claude's own exit code.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseAge, resolvePaths } from './claude-docker/config.mjs';
import { ensureInfra } from './claude-docker/docker.mjs';
import { runMenu } from './claude-docker/menu.mjs';
import { migrateLegacyLayout } from './claude-docker/migrate.mjs';
import { listStates } from './claude-docker/state.mjs';
import {
  buildPlan,
  executePlan,
  planSize,
  printPlan,
  printStaleReminder,
} from './claude-docker/prune.mjs';
import {
  LauncherError,
  checkPrerequisites,
  createOrStart,
  openSession,
  printList,
  remove,
  reset,
  serve,
  shell,
  stop,
} from './claude-docker/sandbox.mjs';

const USAGE = `Usage:
  claude-docker                                   interactive menu (needs a terminal)
  claude-docker <name> [--branch <branch>] [--from <ref>] [--continue | --resume[=<id>]]
                                                  create or start the sandbox and open Claude in it
  claude-docker --shell <name>                    bash shell in the sandbox
  claude-docker --stop <name> [--force]           stop the sandbox's dev services and container
  claude-docker --list                            list sandboxes
  claude-docker --remove <name> [--force] [--delete-branch]
                                                  remove container, volumes, databases, worktree (and branch)
  claude-docker --prune [--older-than <age>] [--force] [--yes] [--include-running]
                                                  remove old sandboxes that have nothing to lose
  claude-docker --serve <name>                    start (or create) the sandbox without a session, print its URLs
  claude-docker --reset [<name>]                  rebuild the image and recreate the container — of <name>,
                                                  or of every sandbox without a name
                                                  (volumes, databases, worktree and ports are kept)
  claude-docker --help                            this help

Names: a-z, 0-9 and "-", at most 40 characters, not ending in -test.
Ages: <n>m, <n>h or <n>d (e.g. 15m, 2h, 7d).
Environment: CLAUDE_DOCKER_WORKTREES_DIR, CLAUDE_DOCKER_STALE_AFTER, CLAUDE_DOCKER_SETUP_TIMEOUT_S,
             CLAUDE_DOCKER_READY_TIMEOUT_S.
`;

const MENU_HINT =
  'claude-docker: the interactive menu needs a terminal (TTY).\n' +
  'In WebStorm run it in the Terminal tool window, or enable "Emulate terminal in output console"\n' +
  'in the Node.js run configuration. Use the command-line flags for scripting (--help).\n';

class UsageError extends Error {}

/** Commands that take a sandbox name as their value. */
const NAME_COMMANDS = ['shell', 'stop', 'remove', 'serve', 'reset'];
/** Commands without a value. */
const BARE_COMMANDS = ['list', 'prune', 'help'];
/** Option flags with a value. */
const VALUE_OPTIONS = ['branch', 'from', 'older-than'];
/** Boolean option flags. */
const BOOL_OPTIONS = ['continue', 'force', 'delete-branch', 'yes', 'include-running'];

/** Which options each command accepts ('session' = `claude-docker <name>`). */
const ALLOWED = {
  session: ['branch', 'from', 'continue', 'resume'],
  shell: [],
  stop: ['force'],
  list: [],
  remove: ['force', 'delete-branch'],
  prune: ['older-than', 'force', 'yes', 'include-running'],
  serve: [],
  reset: [],
  help: [],
};

/**
 * Parses argv into { command, name, opts }. command is one of the ALLOWED keys, or 'menu' for no
 * arguments. Throws UsageError on unknown flags, missing values and invalid combinations.
 */
function parseArgs(argv) {
  if (argv.length === 0) return { command: 'menu', name: null, opts: {} };
  const commands = [];
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') {
      commands.push({ command: 'help' });
      continue;
    }
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-') && arg.length > 1) throw new UsageError(`unknown flag ${arg}`);
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const takeValue = () => {
      if (inline !== undefined) {
        if (inline === '') throw new UsageError(`--${flag} needs a value`);
        return inline;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) throw new UsageError(`--${flag} needs a value`);
      i++;
      return next;
    };
    if (flag === 'reset' && inline === undefined && (argv[i + 1] === undefined || argv[i + 1].startsWith('-'))) {
      // --reset without a name resets every sandbox.
      commands.push({ command: 'reset', name: null });
    } else if (NAME_COMMANDS.includes(flag)) {
      commands.push({ command: flag, name: takeValue() });
    } else if (BARE_COMMANDS.includes(flag)) {
      if (inline !== undefined) throw new UsageError(`--${flag} takes no value`);
      commands.push({ command: flag });
    } else if (VALUE_OPTIONS.includes(flag)) {
      if (flag in opts) throw new UsageError(`--${flag} given twice`);
      opts[flag] = takeValue();
    } else if (BOOL_OPTIONS.includes(flag)) {
      if (inline !== undefined) throw new UsageError(`--${flag} takes no value`);
      opts[flag] = true;
    } else if (flag === 'resume') {
      // claude's --resume opens the picker; --resume=<id> resumes that session directly.
      if (inline === '') throw new UsageError('--resume=<id> needs a session id');
      opts.resume = inline ?? true;
    } else {
      throw new UsageError(`unknown flag ${arg}`);
    }
  }

  if (commands.some((c) => c.command === 'help')) return { command: 'help', name: null, opts: {} };
  if (commands.length > 1) {
    throw new UsageError(`only one command at a time: ${commands.map((c) => `--${c.command}`).join(', ')}`);
  }

  let command;
  let name = null;
  if (commands.length === 1) {
    ({ command } = commands[0]);
    name = commands[0].name ?? null;
    if (positionals.length > 0) throw new UsageError(`unexpected argument ${positionals[0]}`);
  } else {
    if (positionals.length === 0) throw new UsageError('a sandbox name or a command is required');
    if (positionals.length > 1) throw new UsageError(`unexpected argument ${positionals[1]}`);
    command = 'session';
    name = positionals[0];
  }

  for (const key of Object.keys(opts)) {
    if (!ALLOWED[command].includes(key)) {
      const where = command === 'session' ? 'a session' : `--${command}`;
      throw new UsageError(`--${key} cannot be used with ${where}`);
    }
  }
  if (opts.continue && opts.resume) throw new UsageError('--continue and --resume cannot be combined');
  return { command, name, opts };
}

/** The extra claude arguments of a session command. */
function claudePassthrough(opts) {
  if (opts.continue) return ['--continue'];
  if (opts.resume === true) return ['--resume'];
  if (typeof opts.resume === 'string') return ['--resume', opts.resume];
  return [];
}

async function runSession(name, opts) {
  await createOrStart(name, { branch: opts.branch, from: opts.from });
  const code = openSession(name, claudePassthrough(opts));
  printStaleReminder({ exclude: name });
  return code;
}

async function runShell(name) {
  const code = await shell(name);
  printStaleReminder({ exclude: name });
  return code;
}

/** Asks a y/N question on the terminal; resolves true only for y / yes. */
async function confirm(question) {
  // terminal: false keeps the console in cooked mode: toggling raw mode closed the WebStorm
  // terminal (see claude-docker/keys.mjs).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * `--prune [--older-than <age>] [--force] [--yes] [--include-running]`: prints the plan, asks y/N on
 * the terminal unless --yes, and exits 1 without a terminal and without --yes.
 */
async function runPrune(opts) {
  if (opts['older-than'] !== undefined && parseAge(opts['older-than']) === null) {
    throw new UsageError(`--older-than ${opts['older-than']} is not an age like 15m, 2h or 7d`);
  }
  checkPrerequisites();
  // The orphan-DB rule (DD-6) needs the shared Postgres; bring it up so the plan can list them.
  process.stdout.write('checking shared infra (log-hub-postgres)…\n');
  try {
    await ensureInfra();
  } catch (err) {
    throw new LauncherError(err.message);
  }
  const plan = buildPlan({
    olderThan: opts['older-than'],
    force: Boolean(opts.force),
    includeRunning: Boolean(opts['include-running']),
  });
  printPlan(plan);
  if (planSize(plan) === 0) {
    process.stdout.write('\nnothing to prune\n');
    return 0;
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write('\nclaude-docker: --prune needs a terminal to confirm, or --yes; nothing was removed\n');
      return 1;
    }
    if (!(await confirm('\nProceed? [y/N] '))) {
      process.stdout.write('nothing changed\n');
      return 0;
    }
  }
  return (await executePlan(plan)).exitCode;
}

/**
 * The command the menu picked (a session, shell or new sandbox) runs as a fresh process, never
 * inside the menu's process: on Windows, starting containers and `docker exec` after the menu had
 * read the console in raw mode closed the whole terminal. The .ps1/.cmd wrappers set
 * CLAUDE_DOCKER_NEXT_FILE; the command is written there (one argument per line) and the wrapper
 * runs it. Without a wrapper (plain `node scripts/claude-docker.mjs`) the command is printed.
 */
function handNext(argv) {
  const file = (process.env.CLAUDE_DOCKER_NEXT_FILE || '').trim();
  if (file) {
    fs.writeFileSync(file, `${argv.join('\n')}\n`, 'utf8');
    return 0;
  }
  process.stdout.write(`run: scripts/claude-docker.ps1 ${argv.join(' ')}\n`);
  return 0;
}

/**
 * `--reset` without a name: --reset of every sandbox with a state file, one after another (the
 * first rebuilds the image; the others reuse the layer cache). A failing sandbox is reported and
 * the rest still run. Returns 1 if any failed.
 */
async function resetAll() {
  const names = listStates().map((s) => s.name);
  if (names.length === 0) {
    process.stdout.write('no sandboxes to reset\n');
    return 0;
  }
  process.stdout.write(`resetting ${names.length} sandbox(es): ${names.join(', ')}\n`);
  const failed = [];
  for (const n of names) {
    process.stdout.write(`\n=== ${n}\n`);
    try {
      await reset(n);
    } catch (err) {
      failed.push(n);
      process.stderr.write(`claude-docker: --reset ${n} failed: ${err.message}\n`);
    }
  }
  if (failed.length > 0) {
    process.stderr.write(`\nreset failed for: ${failed.join(', ')}\n`);
    return 1;
  }
  process.stdout.write(`\nreset ${names.length} sandbox(es)\n`);
  return 0;
}

/** Runs the parsed command; resolves the process exit code. */
async function dispatch({ command, name, opts }) {
  switch (command) {
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    case 'menu': {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write(MENU_HINT);
        return 1;
      }
      const result = await runMenu();
      if (typeof result === 'number') return result;
      return handNext(result.next);
    }
    case 'session':
      return runSession(name, opts);
    case 'shell':
      return runShell(name);
    case 'stop':
      return stop(name, { force: Boolean(opts.force) });
    case 'list':
      return printList();
    case 'remove':
      return remove(name, { force: Boolean(opts.force), deleteBranch: Boolean(opts['delete-branch']) });
    case 'prune':
      return runPrune(opts);
    case 'serve':
      return serve(name);
    case 'reset':
      return name ? reset(name) : resetAll();
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

/**
 * Appends a failure to <repo>/tmp/claude-docker/launcher-errors.log, so it can be read even when
 * the terminal window closed with the launcher. Best effort: logging never masks the error itself.
 */
function logFailure(kind, err) {
  try {
    const file = path.join(resolvePaths().repoRoot, 'tmp', 'claude-docker', 'launcher-errors.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `[${new Date().toISOString()}] ${kind} · argv: ${JSON.stringify(process.argv.slice(2))}\n${err?.stack ?? err}\n\n`,
    );
  } catch {
    // ignore: the message is still printed
  }
}

process.on('uncaughtException', (err) => {
  logFailure('uncaughtException', err);
  process.stderr.write(`claude-docker: ${err?.stack ?? err}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logFailure('unhandledRejection', err);
  process.stderr.write(`claude-docker: ${err?.stack ?? err}\n`);
  process.exit(1);
});

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`claude-docker: ${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw err;
  }
  try {
    if (parsed.command !== 'help') await migrateLegacyLayout();
    process.exitCode = await dispatch(parsed);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`claude-docker: ${err.message}\n`);
      process.exitCode = 2;
    } else if (err instanceof LauncherError) {
      logFailure('LauncherError', err);
      process.stderr.write(`claude-docker: ${err.message}\n`);
      process.exitCode = err.exitCode;
    } else {
      logFailure('error', err);
      process.stderr.write(`claude-docker: ${err?.message ?? err}\n`);
      process.exitCode = 1;
    }
  }
}

await main();
