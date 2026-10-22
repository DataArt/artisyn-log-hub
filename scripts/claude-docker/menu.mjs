// Interactive sandbox menu (FR-W8): the `claude-docker` TUI shown when the launcher runs with no
// arguments in a terminal. Ported from the UI prototype docs/pocs/2026-10-21-1316-sandbox-menu-tui/
// menu.js (renderer, keys, dialogs, prune screen), now driven by the real launcher code paths:
// listRows() for the data, stop/remove for the actions and buildPlan/executePlan for the prune
// screen. The PoC's merge feature is not ported (merge outside the menu).
//
// The keypress loop is event-driven (DD-2 allows async here). Actions that print (stop, remove,
// prune) run with stdout/stderr captured so they do not scribble over the alternate screen; their
// outcome becomes the status line or a message box. Session keys (Enter/R/S, create) never start
// anything here: the menu ends and resolves { next: argv }, and the claude-docker.ps1/.cmd wrapper
// runs that command as a fresh process (see handOver()).
import path from 'node:path';
import readline from 'node:readline';
import {
  IMAGE_NAME,
  containerName,
  protectedBranchError,
  resolvePaths,
  staleAfterMs,
  validateName,
} from './config.mjs';
import { FIRST_BUILD_NOTICE, imageMissing } from './docker.mjs';
import { startKeys } from './keys.mjs';
import { branchExists, currentBranch } from './git.mjs';
import { PRUNE_ACTIONS, buildPlan, executePlan, planSize } from './prune.mjs';
import { checkPrerequisites, listRows, pendingText, remove, servicesText, stop } from './sandbox.mjs';
import { readState } from './state.mjs';

const ESC = '\x1b[';
const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
};

const ENTER_SCREEN = `${ESC}?1049h${ESC}?25l`;
const LEAVE_SCREEN = `${ESC}?25h${ESC}?1049l`;

// The real stdout writer, kept even while an action's output is captured.
const writeOut = process.stdout.write.bind(process.stdout);
const out = (s) => writeOut(s);
const width = () => Math.max(60, process.stdout.columns || 100);
const height = () => Math.max(20, process.stdout.rows || 30);

// ---------------------------------------------------------------------------------------------
// Rendering helpers (ported from the PoC)
// ---------------------------------------------------------------------------------------------

/** Pads/truncates by visible width: ANSI colour codes inside `text` take no space on screen. */
export function pad(text, n) {
  const s = String(text);
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length > n) return `${visible.slice(0, Math.max(0, n - 1))}…`;
  return s + ' '.repeat(n - visible.length);
}

/** `2 min ago`, `5 h ago`, `3 d ago` for an ISO time; `—` when absent or unparsable. */
export function ago(iso, now = Date.now()) {
  const ts = Date.parse(iso ?? '');
  if (Number.isNaN(ts)) return '—';
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function rule(ch) {
  return `${c.gray}${ch.repeat(width())}${c.reset}\n`;
}

/** Splits plain text into lines of at most n characters (at spaces where possible). */
function wrap(text, n) {
  const result = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw;
    while (line.length > n) {
      let cut = line.lastIndexOf(' ', n);
      if (cut <= 0) cut = n;
      result.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, '');
    }
    result.push(line);
  }
  return result;
}

function boxWidth() {
  return Math.min(width() - 4, 84);
}

function renderBox(title, lines, hint, color) {
  const w = boxWidth();
  const indent = ' '.repeat(Math.max(0, Math.floor((width() - w) / 2)));
  let s = '\n';
  s += `${indent}${color}╭─ ${title} ${'─'.repeat(Math.max(0, w - title.length - 5))}╮${c.reset}\n`;
  for (const line of lines) {
    s += `${indent}${color}│${c.reset} ${pad(line, w - 4)} ${color}│${c.reset}\n`;
  }
  s += `${indent}${color}╰${'─'.repeat(w - 2)}╯${c.reset}\n`;
  s += `${indent} ${c.gray}${hint}${c.reset}\n`;
  return s;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------------------------
// Output capture for actions that print (stop, remove, prune)
// ---------------------------------------------------------------------------------------------

function swapWriters(chunks) {
  const orig = { out: process.stdout.write, err: process.stderr.write };
  const sink = (chunk, enc, cb) => {
    chunks.push(String(chunk));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  process.stdout.write = sink;
  process.stderr.write = sink;
  return () => {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  };
}

function captureSync(fn) {
  const chunks = [];
  const restore = swapWriters(chunks);
  try {
    return { value: fn(), text: chunks.join('') };
  } finally {
    restore();
  }
}

async function captureAsync(fn) {
  const chunks = [];
  const restore = swapWriters(chunks);
  try {
    return { value: await fn(), text: chunks.join('') };
  } catch (err) {
    err.captured = chunks.join('');
    throw err;
  } finally {
    restore();
  }
}

function lastLine(text) {
  return String(text ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
}

// ---------------------------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------------------------

const hasWork = (r) => Boolean(r.pending && (r.pending.files > 0 || r.pending.commits > 0));
const isMergedRow = (r) => Boolean(r.pending && !hasWork(r) && r.pending.merged && r.base);
const sessionsOf = (r) => r.sessions ?? 0;

function stateCell(r) {
  if (r.state === 'running') return { text: '● running', color: c.green };
  if (r.state === 'stopped') return { text: '○ stopped', color: c.gray };
  if (r.state === 'missing') return { text: '○ missing', color: c.gray };
  return { text: '? unknown', color: c.yellow };
}

function pendingCell(r) {
  if (r.worktreeMissing) return { text: 'worktree missing', color: c.red };
  const text = pendingText(r.pending, r.base) + (r.hasState ? '' : ' · no state');
  const color = isMergedRow(r) ? c.green : hasWork(r) ? c.cyan : c.gray;
  return { text, color };
}

// ---------------------------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------------------------

class Menu {
  constructor(paths, resolve, reject) {
    this.paths = paths;
    this.resolve = resolve;
    this.reject = reject;
    this.repoName = path.basename(paths.repoRoot);
    this.rows = [];
    this.warnings = [];
    this.selected = 0;
    this.mode = 'list'; // list | confirm | input | prune | message
    this.overlay = null;
    this.prunePlan = null;
    this.status = '';
    this.busy = false;
    this.changed = false;
    this.attached = false;
    this.done = false;
    this.onKey = this.onKey.bind(this);
    this.onResize = this.onResize.bind(this);
    this.restoreOnExit = () => {
      if (this.attached) writeOut(LEAVE_SCREEN);
    };
    this.onSigint = () => this.quit(true);
  }

  // --- terminal ownership ---------------------------------------------------------------------

  attach() {
    // Keys come from keys.mjs: on Windows a PowerShell reader (Node never changes the console
    // mode), elsewhere Node's raw mode.
    this.stopKeys = startKeys(this.onKey, (err) => this.fatal(err));
    process.stdout.on('resize', this.onResize);
    process.once('exit', this.restoreOnExit);
    // Ctrl+C stays a console signal on Windows (the console mode is untouched).
    process.on('SIGINT', this.onSigint);
    out(ENTER_SCREEN);
    this.attached = true;
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.stopKeys?.();
    this.stopKeys = null;
    process.stdout.off('resize', this.onResize);
    process.off('exit', this.restoreOnExit);
    process.off('SIGINT', this.onSigint);
    out(LEAVE_SCREEN);
  }

  /** Leaves the screen, prints `lines` and ends the menu with `code`. */
  finish(code, lines = []) {
    if (this.done) return;
    this.detach();
    for (const l of lines) out(`${l}\n`);
    this.done = true;
    this.resolve(code);
  }

  /** A rendering/handler error: restore the screen and cursor, report, exit 1. */
  fatal(err) {
    if (this.done) return;
    this.detach();
    process.stderr.write(`claude-docker: menu error: ${err?.stack ?? err}\n`);
    this.done = true;
    this.resolve(1);
  }

  quit(interrupted) {
    const what = this.changed ? 'menu closed.' : 'nothing changed.';
    this.finish(0, [`${c.gray}claude-docker: ${interrupted ? 'interrupted, ' : ''}${what}${c.reset}`]);
  }

  // --- data -----------------------------------------------------------------------------------

  refresh() {
    const { value, text } = captureSync(() => listRows(this.paths));
    this.rows = value;
    this.warnings = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (imageMissing()) {
      this.warnings.unshift(`⚠ image ${IMAGE_NAME} is not built yet — the first start builds it (~20–30 min); later starts take seconds`);
    }
    this.selected = Math.min(this.selected, this.rows.length);
  }

  staleText() {
    try {
      return staleAfterMs().text;
    } catch {
      return '7d';
    }
  }

  // --- rendering ------------------------------------------------------------------------------

  renderList() {
    const w = width();
    const rows = this.rows;
    const cols = { name: Math.min(28, Math.floor(w * 0.3)), state: 11, sess: 5, last: 12 };
    cols.pending = Math.max(10, w - 4 - cols.name - cols.state - cols.sess - cols.last - 4);
    const stale = this.staleText();
    let s = '';
    s += ` ${c.bold}${c.magenta}✻ Claude sandboxes${c.reset}  ${c.gray}${this.repoName} · ${rows.length} sandbox${rows.length === 1 ? '' : 'es'} · stale > ${stale}${c.reset}\n`;
    s += rule('─');
    s += `${c.gray}   ${pad('NAME / BRANCH', cols.name)} ${pad('STATE', cols.state)} ${pad('SESS', cols.sess)} ${pad('LAST ACTIVE', cols.last)} ${pad('PENDING WORK', cols.pending)}${c.reset}\n`;
    rows.forEach((r, i) => {
      const sel = i === this.selected;
      const st = stateCell(r);
      const lastTxt = r.stale ? `⚠ ${ago(r.lastActivity)}` : ago(r.lastActivity);
      const lastCol = r.stale ? c.yellow : '';
      const pend = pendingCell(r);
      const pointer = sel ? `${c.cyan}${c.bold} ❯ ${c.reset}` : '   ';
      const nameCol = sel ? c.bold + c.cyan : '';
      s += `${pointer}${nameCol}${pad(r.name, cols.name)}${c.reset} `
        + `${st.color}${pad(st.text, cols.state)}${c.reset} `
        + `${pad(r.sessions === null ? '?' : r.sessions || '', cols.sess)} `
        + `${lastCol}${pad(lastTxt, cols.last)}${c.reset} `
        + `${pend.color}${pad(pend.text, cols.pending)}${c.reset}\n`;
    });
    const newSel = this.selected === rows.length;
    s += `${newSel ? `${c.cyan}${c.bold} ❯ ` : `${c.gray}   `}+ New sandbox${c.reset}\n`;
    s += rule('─');
    if (newSel) {
      s += ` ${c.gray}Create a worktree + branch (from the main checkout's current branch, or --from) and open Claude in a new container.${c.reset}\n\n`;
    } else {
      const r = rows[this.selected];
      const branch = r.branch ? `branch ${r.branch}${r.base ? ` ← ${r.base}` : ''}` : 'no branch';
      s += ` ${c.bold}${r.name}${c.reset}  ${c.gray}${branch} · container ${containerName(r.name)}${c.reset}\n`;
      s += ` ${c.gray}worktree ${r.worktree}${r.worktreeMissing ? ' (missing)' : ''}${c.reset}\n`;
      const services = servicesText(r);
      if (services) s += ` ${r.state === 'running' ? c.green : c.gray}${pad(services, w - 2)}${c.reset}\n`;
    }
    const staleRows = rows.filter((r) => r.stale);
    if (staleRows.length) {
      s += `\n ${c.yellow}⚠ ${staleRows.length} sandbox(es) idle > ${stale}: ${staleRows.map((x) => x.name).join(', ')}${c.reset}\n`;
      s += ` ${c.gray}  clean up:${c.reset} scripts/claude-docker.ps1 --prune --older-than ${stale}   ${c.gray}(or press P)${c.reset}\n`;
    }
    for (const warn of this.warnings.slice(0, 3)) s += ` ${c.gray}${pad(warn, w - 2)}${c.reset}\n`;
    if (this.status) s += `\n ${this.status}\n`;
    return s;
  }

  footer() {
    const keys = this.selected === this.rows.length
      ? [['↑↓', 'select'], ['Enter', 'create'], ['P', 'prune'], ['Q', 'quit']]
      : [['↑↓', 'select'], ['Enter', 'continue'], ['R', 'resume…'], ['S', 'shell'], ['T', 'stop'], ['D', 'remove'], ['P', 'prune'], ['Q', 'quit']];
    return ` ${keys.map(([k, v]) => `${c.bold}${k}${c.reset} ${c.gray}${v}${c.reset}`).join('  ')}`;
  }

  renderPrune() {
    const p = this.prunePlan;
    let s = ` ${c.bold}${c.magenta}✻ Prune plan${c.reset}  ${c.gray}· candidates: stopped / missing containers${c.reset}\n`;
    s += rule('─');
    s += ` ${c.red}${c.bold}Will remove${c.reset} ${c.gray}(container, volumes, databases, worktree, branch)${c.reset}\n`;
    if (planSize(p) === 0) s += `   ${c.gray}nothing${c.reset}\n`;
    for (const r of p.remove) {
      const branch = r.branch ? (r.deleteBranch ? `deletes branch ${r.branch}` : `keeps branch ${r.branch}`) : 'no branch';
      s += `   ${c.red}✗${c.reset} ${pad(r.name, 28)} ${c.gray}${r.reason} · ${branch} · ${ago(r.lastActivity)}${c.reset}\n`;
    }
    for (const ct of p.strayContainers) s += `   ${c.red}✗${c.reset} ${pad(`container ${ct.name}`, 28)} ${c.gray}no sandbox named ${ct.sandbox}${c.reset}\n`;
    for (const v of p.strayVolumes) s += `   ${c.red}✗${c.reset} ${pad(`volume ${v.name}`, 28)} ${c.gray}no sandbox named ${v.sandbox}${c.reset}\n`;
    for (const d of p.orphanDbs) s += `   ${c.red}✗${c.reset} ${pad(`database ${d.db}`, 28)} ${c.gray}sandbox ${d.sandbox} is an orphan${c.reset}\n`;

    s += `\n ${c.green}${c.bold}Will keep${c.reset}\n`;
    if (p.keep.length === 0) s += `   ${c.gray}nothing${c.reset}\n`;
    for (const k of p.keep) {
      let why;
      if (k.action === PRUNE_ACTIONS.keepHasWork) {
        why = `${c.cyan}has work: ${k.reason}${c.reset} ${c.gray}→ merge outside · F removes anyway, keeps branch${c.reset}`;
      } else if (k.action === PRUNE_ACTIONS.liveSession) {
        why = `${c.gray}live claude session · never pruned, even with F${c.reset}`;
      } else {
        why = `${c.gray}${k.reason}${c.reset}`;
      }
      s += `   ${c.green}✓${c.reset} ${pad(k.name, 28)} ${why}\n`;
    }
    if (p.skipped.length > 0) {
      s += `\n ${c.gray}Not candidates${c.reset}\n`;
      for (const sk of p.skipped) s += `   ${c.gray}· ${pad(sk.name, 28)} ${sk.reason}${c.reset}\n`;
    }
    s += rule('─');
    const n = planSize(p);
    const withWork = p.keep.filter((k) => k.action === PRUNE_ACTIONS.keepHasWork).length;
    if (n === 0 && withWork === 0) {
      s += ` Nothing to prune.  ${c.bold}Esc${c.reset} ${c.gray}back${c.reset}\n`;
    } else {
      s += ` Remove ${n} item(s)? ${c.bold}y${c.reset} ${c.gray}yes${c.reset}`;
      if (withWork > 0) s += `  ${c.bold}F${c.reset} ${c.gray}yes, including ${withWork} with work${c.reset}`;
      s += `  ${c.bold}Esc${c.reset} ${c.gray}back${c.reset}\n`;
    }
    return s;
  }

  render() {
    if (!this.attached) return;
    let s = `${ESC}H${ESC}2J`;
    if (this.mode === 'prune') {
      out(s + this.renderPrune());
      return;
    }
    s += this.renderList();
    if (this.mode === 'confirm' || this.mode === 'message') {
      s += renderBox(this.overlay.title, this.overlay.lines, this.overlay.hint, this.overlay.color);
    } else if (this.mode === 'input') {
      const o = this.overlay;
      const err = o.error ? [`  ${o.error}`] : [];
      s += renderBox(o.title, [o.label, `› ${o.value}█`, ...err], 'Enter confirm · Esc cancel', c.cyan);
    }
    const used = s.split('\n').length;
    s += '\n'.repeat(Math.max(1, height() - used - 1));
    s += this.footer();
    out(s);
  }

  onResize() {
    try {
      this.render();
    } catch (err) {
      this.fatal(err);
    }
  }

  // --- overlays -------------------------------------------------------------------------------

  confirm(title, lines, onYes) {
    this.mode = 'confirm';
    this.overlay = { title, lines, hint: 'y confirm · any other key cancels', color: c.yellow, onYes };
  }

  message(title, lines, color) {
    this.mode = 'message';
    this.overlay = { title, lines: lines.flatMap((l) => wrap(l, boxWidth() - 4)), hint: 'any key to close', color: color || c.cyan };
  }

  /**
   * Runs an action that prints (stop/remove/prune) with its output captured; `onDone(value, text)`
   * sets the status. A failure shows a red box with the error message.
   */
  runAction(label, errorTitle, fn, onDone) {
    this.busy = true;
    this.mode = 'list';
    this.status = `${c.gray}… ${label}${c.reset}`;
    this.render();
    captureAsync(fn)
      .then(({ value, text }) => {
        this.changed = true;
        onDone(value, text);
      })
      .catch((err) => {
        this.changed = true;
        this.status = '';
        this.message(errorTitle, [err?.message ?? String(err)], c.red);
      })
      .then(() => {
        this.busy = false;
        if (this.done) return;
        this.refresh();
        this.render();
      })
      .catch((err) => this.fatal(err));
  }

  // --- list keys ------------------------------------------------------------------------------

  onListKey(str, key) {
    const total = this.rows.length;
    const onNew = this.selected === total;
    const r = this.rows[this.selected];
    this.status = '';
    if (key.name === 'up') this.selected = (this.selected + total) % (total + 1);
    else if (key.name === 'down') this.selected = (this.selected + 1) % (total + 1);
    else if (key.name === 'q' || key.name === 'escape') this.quit(false);
    else if (key.name === 'p') this.openPrune();
    else if (onNew && key.name === 'return') {
      this.mode = 'input';
      this.overlay = {
        step: 'name',
        title: 'New sandbox',
        label: 'Name (a-z, 0-9, "-"; the container and worktree name):',
        value: '',
        error: '',
        data: {},
      };
    } else if (onNew) {
      // other keys do nothing on the "+ New sandbox" row
    } else if (key.name === 'return') {
      this.startSession(r, ['--continue']);
    } else if (key.name === 'r') {
      this.startSession(r, ['--resume']);
    } else if (key.name === 's') {
      this.startShell(r);
    } else if (key.name === 't') {
      this.stopKey(r);
    } else if (key.name === 'd') {
      this.removeKey(r);
    }
  }

  startSession(r, passthrough) {
    this.handOver([r.name, ...passthrough]);
  }

  startShell(r) {
    this.handOver(['--shell', r.name]);
  }

  /**
   * Ends the menu and hands the chosen command to the wrapper, which runs it as a fresh
   * `claude-docker` process. The menu never starts containers or sessions itself: on Windows, child
   * processes started after the menu has read the console in raw mode killed the whole terminal
   * (seen in Windows Terminal), while the same command run as its own process works.
   */
  handOver(argv) {
    this.finish({ next: argv }, [`${c.green}▶ claude-docker ${argv.join(' ')}${c.reset}`]);
  }

  stopKey(r) {
    if (r.state === 'unknown') {
      this.status = `${c.yellow}Docker is not reachable; cannot stop ${r.name}.${c.reset}`;
      return;
    }
    if (r.state !== 'running') {
      this.status = `${c.gray}${r.name} ${r.state === 'missing' ? 'has no container' : 'is already stopped'}.${c.reset}`;
      return;
    }
    const doStop = (force) =>
      this.runAction(`stopping ${r.name}`, 'Stop failed', async () => stop(r.name, { force }, this.paths), () => {
        this.status = `${c.green}✓ ${r.name} stopped${c.reset}`;
      });
    const n = sessionsOf(r);
    if (n > 0) {
      this.confirm(
        'Stop sandbox',
        [
          `${r.name} has ${plural(n, 'running claude session')}.`,
          `Stopping the container ends ${n === 1 ? 'it' : 'them'} (resume later with Enter or R).`,
        ],
        () => doStop(true),
      );
    } else {
      doStop(false);
    }
  }

  removeKey(r) {
    const n = sessionsOf(r);
    const work = hasWork(r);
    const files = r.pending?.files ?? 0;
    const state = r.hasState ? readState(r.name, this.paths) : null;
    const deleteBranch = Boolean(
      state?.branchCreated && r.branch && !work && r.pending && (r.pending.merged || r.pending.noCommits),
    );
    const force = n > 0 || files > 0;
    const lines = [];
    if (n > 0) lines.push(`${c.red}Ends ${plural(n, 'live claude session')}${c.reset} in ${containerName(r.name)}.`);
    if (work) lines.push(`${c.red}This loses work:${c.reset} ${pendingText(r.pending, r.base)} in ${r.name}.`);
    const branchLine = !r.branch
      ? ''
      : deleteBranch
        ? ` Branch ${r.branch} is deleted too.`
        : ` Branch ${r.branch} is kept.`;
    lines.push(...wrap(`Container, volumes, databases and worktree are deleted.${branchLine}`, boxWidth() - 4));
    this.confirm(force || work ? 'Remove (force)' : 'Remove', lines, () =>
      this.runAction(
        `removing ${r.name}`,
        'Remove failed',
        () => remove(r.name, { force, deleteBranch }, this.paths),
        (code, text) => {
          const warning = lastLine(text.split(/\r?\n/).filter((l) => l.startsWith('warning:')).join('\n'));
          this.status = code === 0
            ? `${c.green}✓ removed ${r.name}${c.reset}`
            : `${c.yellow}✓ removed ${r.name}; ${warning || 'see --list'}${c.reset}`;
        },
      ),
    );
  }

  // --- input dialog (new sandbox) -------------------------------------------------------------

  onInputKey(str, key) {
    const o = this.overlay;
    if (key.name === 'escape') {
      this.mode = 'list';
      return;
    }
    if (key.name === 'backspace') {
      o.value = o.value.slice(0, -1);
      o.error = '';
      return;
    }
    if (key.name === 'return') {
      this.submitInput();
      return;
    }
    if (str && str.length === 1 && !key.ctrl && !key.meta && str >= ' ') {
      o.value += str;
      o.error = '';
    }
  }

  submitInput() {
    const o = this.overlay;
    const v = o.value.trim();
    if (o.step === 'name') {
      const err = validateName(v) ?? (this.rows.some((r) => r.name === v) ? `a sandbox named ${v} already exists` : null);
      if (err) {
        o.error = `${c.red}${err}${c.reset}`;
        return;
      }
      o.data.name = v;
      o.step = 'branch';
      o.label = `Branch — an existing one to work on, or a new name (e.g. ${v}):`;
      o.value = '';
      o.error = '';
      return;
    }
    if (o.step === 'branch') {
      // A branch is required: the sandbox works on its own branch, chosen explicitly.
      let err = v ? null : 'enter a branch: an existing one or a new name';
      if (!err) {
        try {
          err = protectedBranchError(v, this.paths);
        } catch (e) {
          err = e.message;
        }
      }
      if (err) {
        o.error = `${c.red}${err}${c.reset}`;
        return;
      }
      o.data.branch = v;
      if (branchExists(v)) {
        this.create(o.data);
        return;
      }
      let def = 'HEAD';
      try {
        def = currentBranch(this.paths.repoRoot) ?? 'HEAD';
      } catch {
        // keep HEAD
      }
      o.step = 'from';
      o.label = `Create the new branch from (--from ref; Enter = ${def}):`;
      o.value = '';
      o.error = '';
      return;
    }
    o.data.from = v || undefined;
    this.create(o.data);
  }

  create({ name, branch, from }) {
    this.mode = 'list';
    // The same command as `claude-docker <name> --branch <b> [--from <ref>]`; a git refusal (e.g.
    // the branch is checked out elsewhere) is printed by that run.
    this.handOver([name, '--branch', branch, ...(from ? ['--from', from] : [])]);
  }

  // --- prune screen ---------------------------------------------------------------------------

  openPrune() {
    try {
      this.prunePlan = captureSync(() => buildPlan({}, this.paths)).value;
      this.mode = 'prune';
    } catch (err) {
      this.message('Prune unavailable', [err?.message ?? String(err)], c.red);
    }
  }

  onPruneKey(_str, key) {
    const p = this.prunePlan;
    const isY = key.name === 'y';
    const isF = key.name === 'f';
    this.mode = 'list';
    if (!isY && !isF) return;
    const withWork = p.keep.filter((k) => k.action === PRUNE_ACTIONS.keepHasWork).length;
    if (isY && planSize(p) === 0) {
      this.status = `${c.gray}nothing to prune${c.reset}`;
      return;
    }
    if (isF && planSize(p) === 0 && withWork === 0) {
      this.status = `${c.gray}nothing to prune${c.reset}`;
      return;
    }
    this.runAction(
      'pruning',
      'Prune failed',
      async () => {
        const plan = isF ? buildPlan({ force: true }, this.paths) : p;
        const result = await executePlan(plan, this.paths);
        return { plan, result };
      },
      ({ plan, result }) => {
        const failedNames = new Set(result.failed.map((f) => f.what));
        const sandboxes = plan.remove.filter((r) => !failedNames.has(`sandbox ${r.name}`)).length;
        const forced = plan.remove.filter((r) => r.force && !r.orphan).length;
        const extra = isF && forced ? ` (incl. ${forced} with work; their branches kept)` : '';
        const failed = result.failed.length ? `${c.red} · ${result.failed.length} failed: ${result.failed[0].message.split('\n')[0]}` : '';
        this.status = `${c.green}✓ pruned ${sandboxes} sandbox(es)${extra}${failed}${c.reset}`;
      },
    );
  }

  // --- dispatch -------------------------------------------------------------------------------

  onKey(str, key) {
    try {
      if (this.done || !this.attached) return;
      const k = key ?? { name: str };
      if (k.ctrl && k.name === 'c') {
        this.quit(true);
        return;
      }
      if (this.busy) return;
      if (this.mode === 'list') this.onListKey(str, k);
      else if (this.mode === 'input') this.onInputKey(str, k);
      else if (this.mode === 'prune') this.onPruneKey(str, k);
      else if (this.mode === 'confirm') {
        const fn = this.overlay.onYes;
        this.mode = 'list';
        if (k.name === 'y') fn();
      } else if (this.mode === 'message') this.mode = 'list';
      if (!this.done && this.attached && !this.busy) this.render();
    } catch (err) {
      this.fatal(err);
    }
  }

  start() {
    this.refresh();
    this.attach();
    try {
      this.render();
    } catch (err) {
      this.fatal(err);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Simple (line) menu: no raw mode, no alternate screen
// ---------------------------------------------------------------------------------------------

/**
 * True only with CLAUDE_DOCKER_MENU=simple: a plain line menu (numbered list, line input), kept as a
 * fallback for terminals where the full-screen menu misbehaves. The full-screen menu is the default
 * everywhere, the WebStorm terminal included (see keys.mjs).
 */
export function useSimpleMenu(env = process.env) {
  return (env.CLAUDE_DOCKER_MENU || '').trim().toLowerCase() === 'simple';
}

/**
 * The line menu: a numbered list, then plain line input (readline with terminal: false, so the
 * console stays in its normal cooked mode). Opening a sandbox, a shell or a new sandbox resolves
 * { next: argv } like the full menu; stop/remove/prune are pointed to their CLI flags.
 */
export async function runSimpleMenu(paths) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    out(q);
    const { value, done } = await lines.next();
    return done ? null : String(value).trim();
  };
  try {
    const { value: rows, text } = captureSync(() => listRows(paths));
    out(`\n${c.bold}claude-docker${c.reset} ${c.gray}· sandboxes of ${path.basename(paths.repoRoot)}${c.reset}\n`);
    for (const w of text.split(/\r?\n/).filter(Boolean)) out(`${c.gray}${w}${c.reset}\n`);
    if (imageMissing()) out(`${c.yellow}⚠ image ${IMAGE_NAME} is not built yet — the first start builds it (~20–30 min)${c.reset}\n`);
    const nameW = Math.max(4, ...rows.map((r) => r.name.length));
    const branchW = Math.max(6, ...rows.map((r) => (r.branch ?? '-').length));
    rows.forEach((r, i) => {
      const st = stateCell(r);
      const pend = pendingCell(r);
      out(
        ` ${c.bold}${String(i + 1).padStart(2)}${c.reset}  ${pad(r.name, nameW)} ${pad(r.branch ?? '-', branchW)} ` +
          `${st.color}${pad(st.text, 10)}${c.reset} ${pend.color}${pend.text}${c.reset}\n`,
      );
    });
    if (rows.length === 0) out(` ${c.gray}no sandboxes yet${c.reset}\n`);
    out(
      `\n ${c.gray}<n> open Claude (--continue) · <n>r resume picker · <n>s shell · n new sandbox · q quit\n` +
        ` stop/remove/prune: scripts/claude-docker.ps1 --stop|--remove <name>, --prune${c.reset}\n`,
    );
    for (;;) {
      const a = await ask('> ');
      if (a === null || a === '' || a === 'q') return 0;
      const m = /^(\d+)\s*([rs]?)$/.exec(a);
      if (m) {
        const r = rows[Number(m[1]) - 1];
        if (!r) {
          out(`${c.red}no sandbox number ${m[1]}${c.reset}\n`);
          continue;
        }
        if (m[2] === 's') return { next: ['--shell', r.name] };
        return { next: [r.name, m[2] === 'r' ? '--resume' : '--continue'] };
      }
      if (a === 'n') {
        let name;
        for (;;) {
          name = await ask('Name (a-z, 0-9, "-"; the container and worktree name): ');
          if (name === null || name === '') return 0;
          const err = validateName(name) ?? (rows.some((r) => r.name === name) ? `a sandbox named ${name} already exists` : null);
          if (!err) break;
          out(`${c.red}${err}${c.reset}\n`);
        }
        let branch;
        for (;;) {
          branch = await ask(`Branch — an existing one or a new name (e.g. ${name}): `);
          if (branch === null) return 0;
          let err = branch ? null : 'enter a branch: an existing one or a new name';
          if (!err) {
            try {
              err = protectedBranchError(branch, paths);
            } catch (e) {
              err = e.message;
            }
          }
          if (!err) break;
          out(`${c.red}${err}${c.reset}\n`);
        }
        let from;
        if (!branchExists(branch)) {
          let def = 'HEAD';
          try {
            def = currentBranch(paths.repoRoot) ?? 'HEAD';
          } catch {
            // keep HEAD
          }
          from = await ask(`Create the new branch from (--from ref; Enter = ${def}): `);
          if (from === null) return 0;
        }
        return { next: [name, '--branch', branch, ...(from ? ['--from', from] : [])] };
      }
      out(`${c.red}unknown choice "${a}"${c.reset}\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Runs the interactive menu. Resolves an exit code, or { next: argv } when the user picked a
 * session, shell or new sandbox — the caller hands that command to the wrapper. Needs a TTY on
 * stdin and stdout (the caller prints the hint otherwise). Rendering errors restore the screen and
 * cursor and resolve 1.
 */
export async function runMenu(paths = resolvePaths()) {
  checkPrerequisites();
  if (useSimpleMenu()) return runSimpleMenu(paths);
  if (imageMissing()) process.stdout.write(FIRST_BUILD_NOTICE);
  return new Promise((resolve, reject) => {
    const menu = new Menu(paths, resolve, reject);
    try {
      menu.start();
    } catch (err) {
      menu.fatal(err);
    }
  });
}
