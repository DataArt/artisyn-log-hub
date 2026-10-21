'use strict';
// UI-only prototype of the `claude-docker` interactive menu (FR-W8 of task
// 2026-10-15-claude-dev-container). No Docker, no git: all sandboxes are mock data and every action
// only changes that in-memory list or prints the command the real launcher would run.
//
// Deviation from the nodejs-script skill (sync-only): an interactive TUI needs keypress events, so
// input is event-driven via readline. Still CommonJS and built-ins only, so there is nothing to install.

const readline = require('readline');

const ESC = '\x1b[';
const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
};

const STALE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const WORKTREES = 'D:\\_work\\Artisyn-LogHub\\_repo-worktrees';

// Mock sandboxes covering every state the real launcher distinguishes.
const sandboxes = [
  { name: 'r1-claude-dev-container', base: 'main', state: 'running', sessions: 1, last: now - 2 * 60 * 1000, files: 3, commits: 0, outsideDocs: false },
  { name: 'r2-sysctx-review', base: 'main', state: 'stopped', sessions: 0, last: now - 5 * 60 * 60 * 1000, files: 1, commits: 0, outsideDocs: false },
  { name: 'r3-otel-port', base: 'main', state: 'stopped', sessions: 0, last: now - 2 * DAY, files: 0, commits: 0, outsideDocs: false },
  { name: 'r4-old-review', base: 'main', state: 'stopped', sessions: 0, last: now - 9 * DAY, files: 0, commits: 0, outsideDocs: false },
  { name: 'r5-forgotten-spike', base: 'main', state: 'stopped', sessions: 0, last: now - 23 * DAY, files: 4, commits: 2, outsideDocs: true },
  { name: 'r6-merged-review', base: 'main', state: 'stopped', sessions: 0, last: now - 12 * DAY, files: 0, commits: 0, merged: true, outsideDocs: false },
];

let selected = 0;
let mode = 'list'; // list | confirm | input | prune | message
let overlay = null;
let status = '';

const out = (s) => process.stdout.write(s);
const width = () => Math.max(60, process.stdout.columns || 100);
const height = () => Math.max(20, process.stdout.rows || 30);

// Pads/truncates by visible width: ANSI colour codes inside `text` take no space on screen.
function pad(text, n) {
  const s = String(text);
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length > n) return `${visible.slice(0, Math.max(0, n - 1))}…`;
  return s + ' '.repeat(n - visible.length);
}

function ago(ts) {
  const m = Math.round((now - ts) / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const isStale = (s) => now - s.last > STALE_DAYS * DAY;
const hasWork = (s) => s.files > 0 || s.commits > 0;
const isActive = (s) => s.state === 'running' && s.sessions > 0;

function pending(s) {
  if (s.merged) return 'merged';
  const parts = [];
  if (s.files) parts.push(`${s.files} file${s.files > 1 ? 's' : ''}`);
  if (s.commits) parts.push(`${s.commits} commit${s.commits > 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : '—';
}

function rule(ch) {
  return c.gray + ch.repeat(width()) + c.reset + '\n';
}

function renderList() {
  const w = width();
  const cols = { name: Math.min(28, Math.floor(w * 0.3)), state: 11, sess: 5, last: 12 };
  cols.pending = Math.max(10, w - 4 - cols.name - cols.state - cols.sess - cols.last - 4);
  let s = '';
  s += ` ${c.bold}${c.magenta}✻ Claude sandboxes${c.reset}  ${c.gray}Artisyn-LogHub · ${sandboxes.length} sandboxes · stale > ${STALE_DAYS} d${c.reset}\n`;
  s += rule('─');
  s += c.gray + '   ' + pad('NAME / BRANCH', cols.name) + ' ' + pad('STATE', cols.state) + ' ' + pad('SESS', cols.sess) + ' ' + pad('LAST ACTIVE', cols.last) + ' ' + pad('PENDING WORK', cols.pending) + c.reset + '\n';
  sandboxes.forEach((sb, i) => {
    const sel = i === selected;
    const stateTxt = sb.state === 'running' ? '● running' : '○ stopped';
    const stateCol = sb.state === 'running' ? c.green : c.gray;
    const lastTxt = isStale(sb) ? `⚠ ${ago(sb.last)}` : ago(sb.last);
    const lastCol = isStale(sb) ? c.yellow : '';
    const pendCol = sb.merged ? c.green : hasWork(sb) ? c.cyan : c.gray;
    const pointer = sel ? `${c.cyan}${c.bold} ❯ ${c.reset}` : '   ';
    const nameCol = sel ? c.bold + c.cyan : '';
    s += pointer + nameCol + pad(sb.name, cols.name) + c.reset + ' '
      + stateCol + pad(stateTxt, cols.state) + c.reset + ' '
      + pad(sb.sessions || '', cols.sess) + ' '
      + lastCol + pad(lastTxt, cols.last) + c.reset + ' '
      + pendCol + pad(pending(sb), cols.pending) + c.reset + '\n';
  });
  const newSel = selected === sandboxes.length;
  s += (newSel ? `${c.cyan}${c.bold} ❯ ` : `${c.gray}   `) + '+ New sandbox' + c.reset + '\n';
  s += rule('─');
  if (newSel) {
    s += ` ${c.gray}Create a worktree + branch from the current HEAD and open Claude in a new container.${c.reset}\n\n`;
  } else {
    const sb = sandboxes[selected];
    s += ` ${c.bold}${sb.name}${c.reset}  ${c.gray}branch ${sb.name} ← ${sb.base} · container log-hub-dev-${sb.name}${c.reset}\n`;
    s += ` ${c.gray}worktree ${WORKTREES}\\${sb.name}${c.reset}\n`;
  }
  const stale = sandboxes.filter(isStale);
  if (stale.length) {
    s += `\n ${c.yellow}⚠ ${stale.length} sandbox(es) idle > ${STALE_DAYS} d: ${stale.map((x) => x.name).join(', ')}${c.reset}\n`;
    s += ` ${c.gray}  clean up:${c.reset} scripts/claude-docker.ps1 --prune --older-than ${STALE_DAYS}d   ${c.gray}(or press P)${c.reset}\n`;
  }
  if (status) s += `\n ${status}\n`;
  return s;
}

function footer() {
  const keys = selected === sandboxes.length
    ? [['↑↓', 'select'], ['Enter', 'create'], ['P', 'prune'], ['Q', 'quit']]
    : [['↑↓', 'select'], ['Enter', 'continue'], ['R', 'resume…'], ['S', 'shell'], ['T', 'stop'], ['M', 'merge'], ['D', 'remove'], ['P', 'prune'], ['Q', 'quit']];
  return ' ' + keys.map(([k, v]) => `${c.bold}${k}${c.reset} ${c.gray}${v}${c.reset}`).join('  ');
}

function renderBox(title, lines, hint, color) {
  const w = Math.min(width() - 4, 84);
  const indent = ' '.repeat(Math.max(0, Math.floor((width() - w) / 2)));
  let s = '\n';
  s += indent + color + '╭─ ' + title + ' ' + '─'.repeat(Math.max(0, w - title.length - 5)) + '╮' + c.reset + '\n';
  for (const line of lines) {
    s += indent + color + '│' + c.reset + ' ' + pad(line, w - 4) + ' ' + color + '│' + c.reset + '\n';
  }
  s += indent + color + '╰' + '─'.repeat(w - 2) + '╯' + c.reset + '\n';
  s += indent + ' ' + c.gray + hint + c.reset + '\n';
  return s;
}

function prunePlan() {
  const candidates = sandboxes.filter((s) => !isActive(s));
  const remove = candidates.filter((s) => s.merged || !hasWork(s));
  const keep = candidates.filter((s) => !s.merged && hasWork(s));
  return { remove, keep, active: sandboxes.filter(isActive) };
}

function render() {
  let s = `${ESC}H${ESC}2J`;
  if (mode === 'list') {
    s += renderList();
  } else if (mode === 'confirm' || mode === 'message') {
    s += renderList();
    s += renderBox(overlay.title, overlay.lines, overlay.hint, overlay.color);
  } else if (mode === 'input') {
    s += renderList();
    const err = overlay.error ? [`  ${overlay.error}`] : [];
    s += renderBox(overlay.title, [overlay.label, `› ${overlay.value}█`, ...err], 'Enter confirm · Esc cancel', c.cyan);
  } else if (mode === 'prune') {
    const p = prunePlan();
    s += ` ${c.bold}${c.magenta}✻ Prune plan${c.reset}  ${c.gray}inactive sandboxes (no running claude session)${c.reset}\n`;
    s += rule('─');
    s += ` ${c.red}${c.bold}Will remove${c.reset} ${c.gray}(container, volumes, worktree, branch)${c.reset}\n`;
    if (!p.remove.length) s += `   ${c.gray}nothing${c.reset}\n`;
    for (const sb of p.remove) s += `   ${c.red}✗${c.reset} ${pad(sb.name, 28)} ${c.gray}${sb.merged ? 'merged into ' + sb.base : 'no changes, no commits'} · ${ago(sb.last)}${c.reset}\n`;
    s += `\n ${c.green}${c.bold}Will keep${c.reset}\n`;
    for (const sb of p.keep) s += `   ${c.green}✓${c.reset} ${pad(sb.name, 28)} ${c.cyan}has work: ${pending(sb)}${c.reset} ${c.gray}→ M merge, or F to remove anyway (branch kept)${c.reset}\n`;
    for (const sb of p.active) s += `   ${c.green}✓${c.reset} ${pad(sb.name, 28)} ${c.gray}active claude session${c.reset}\n`;
    s += rule('─');
    s += ` Remove ${p.remove.length} sandbox(es)? ${c.bold}y${c.reset} ${c.gray}yes${c.reset}  ${c.bold}F${c.reset} ${c.gray}yes, including ones with work${c.reset}  ${c.bold}Esc${c.reset} ${c.gray}back${c.reset}\n`;
    out(s);
    return;
  }
  const used = s.split('\n').length;
  s += '\n'.repeat(Math.max(1, height() - used - 1));
  s += footer();
  out(s);
}

function confirm(title, lines, onYes) {
  mode = 'confirm';
  overlay = { title, lines, hint: 'y confirm · any other key cancels', color: c.yellow, onYes };
}

function message(title, lines, color) {
  mode = 'message';
  overlay = { title, lines, hint: 'any key to close', color: color || c.cyan };
}

function leave(lines) {
  out(`${ESC}?25h${ESC}?1049l`);
  for (const l of lines) out(`${l}\n`);
  process.exit(0);
}

function sessionCmd(sb, extra) {
  return `docker exec -it log-hub-dev-${sb.name} claude --dangerously-skip-permissions${extra ? ' ' + extra : ''}`;
}

function onListKey(_str, key) {
  const onNew = selected === sandboxes.length;
  const sb = sandboxes[selected];
  status = '';
  if (key.name === 'up') selected = (selected + sandboxes.length) % (sandboxes.length + 1);
  else if (key.name === 'down') selected = (selected + 1) % (sandboxes.length + 1);
  else if (key.name === 'q' || key.name === 'escape') leave([`${c.gray}claude-docker: nothing changed.${c.reset}`]);
  else if (key.name === 'p') mode = 'prune';
  else if (onNew && key.name === 'return') {
    mode = 'input';
    overlay = { title: 'New sandbox', label: 'Name ([a-z0-9-]; becomes the branch and worktree name):', value: '', error: '' };
  } else if (onNew) {
    return;
  } else if (key.name === 'return') {
    leave([`${c.green}▶ ${sb.name}${c.reset} ${c.gray}starting container…${c.reset}`, `  would run: ${sessionCmd(sb, '--continue')}`, `${c.gray}  (prototype: the terminal is now handed to Claude; on exit you are back in the shell)${c.reset}`]);
  } else if (key.name === 'r') {
    leave([`${c.green}▶ ${sb.name}${c.reset}`, `  would run: ${sessionCmd(sb, '--resume')}   ${c.gray}(Claude's own session picker)${c.reset}`]);
  } else if (key.name === 's') {
    leave([`${c.green}▶ ${sb.name}${c.reset}`, `  would run: docker exec -it log-hub-dev-${sb.name} bash`]);
  } else if (key.name === 't') {
    if (sb.state !== 'running') status = `${c.gray}${sb.name} is already stopped.${c.reset}`;
    else if (sb.sessions) confirm('Stop sandbox', [`${sb.name} has ${sb.sessions} running claude session(s).`, 'Stopping the container ends them (resume later with Enter).'], () => { sb.state = 'stopped'; sb.sessions = 0; status = `${c.green}✓ ${sb.name} stopped${c.reset}`; });
    else { sb.state = 'stopped'; status = `${c.green}✓ ${sb.name} stopped${c.reset}`; }
  } else if (key.name === 'm') {
    if (isActive(sb)) message('Cannot merge', [`${sb.name} has a running claude session.`, 'Finish or stop it first (T).'], c.red);
    else if (sb.outsideDocs) message('Merge refused', [`${sb.name} changes files outside docs/:`, '  server/src/app.module.ts, client/src/App.tsx', 'Review sandboxes may only change docs/. Use D (remove) or merge by hand.'], c.red);
    else if (!hasWork(sb)) message('Nothing to merge', [`${sb.name} has no changes and no commits.`], c.gray);
    else confirm('Merge', [`Commit ${pending(sb)} of ${sb.name} as "review: ${sb.name}"`, `and merge into ${sb.base} (main checkout must be on ${sb.base}).`, 'Then remove container, worktree and branch.'], () => { sandboxes.splice(selected, 1); status = `${c.green}✓ merged ${sb.name} into ${sb.base} and cleaned up${c.reset}`; });
  } else if (key.name === 'd') {
    if (isActive(sb)) { message('Cannot remove', [`${sb.name} has a running claude session.`], c.red); return; }
    const lines = hasWork(sb)
      ? [`${c.red}This loses work:${c.reset} ${pending(sb)} in ${sb.name}.`, 'Container, volumes and worktree are deleted; the branch is kept.']
      : [`Remove ${sb.name}: container, volumes, worktree.`, sb.merged ? 'The branch is merged and will be deleted too.' : 'The branch has no commits and will be deleted too.'];
    confirm(hasWork(sb) ? 'Remove (force)' : 'Remove', lines, () => { sandboxes.splice(selected, 1); status = `${c.green}✓ removed ${sb.name}${c.reset}`; });
  }
  selected = Math.min(selected, sandboxes.length);
}

function onInputKey(str, key) {
  if (key.name === 'escape') { mode = 'list'; return; }
  if (key.name === 'backspace') { overlay.value = overlay.value.slice(0, -1); return; }
  if (key.name === 'return') {
    const v = overlay.value;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) { overlay.error = `${c.red}only a-z, 0-9 and "-"${c.reset}`; return; }
    if (sandboxes.some((s) => s.name === v)) { overlay.error = `${c.red}a sandbox named ${v} already exists${c.reset}`; return; }
    leave([`${c.green}▶ creating ${v}${c.reset}`, `  would run: git worktree add --relative-paths ${WORKTREES}\\${v} -b ${v} HEAD`, `  would run: docker run -d --init --name log-hub-dev-${v} … sleep infinity`, `  would run: docker exec -it log-hub-dev-${v} claude --dangerously-skip-permissions`]);
  }
  if (str && str.length === 1 && !key.ctrl && !key.meta) { overlay.value += str; overlay.error = ''; }
}

function onPruneKey(_str, key) {
  const p = prunePlan();
  if (key.name === 'y' || key.name === 'f') {
    const force = key.name === 'f';
    const victims = force ? [...p.remove, ...p.keep] : p.remove;
    for (const v of victims) sandboxes.splice(sandboxes.indexOf(v), 1);
    status = `${c.green}✓ pruned ${victims.length} sandbox(es)${force && p.keep.length ? ` (incl. ${p.keep.length} with work; their branches kept)` : ''}${c.reset}`;
    selected = Math.min(selected, sandboxes.length);
  }
  mode = 'list';
}

function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('claude-docker: the interactive menu needs a terminal (TTY).\n'
      + 'In WebStorm run it in the Terminal tool window, or enable "Emulate terminal in output console"\n'
      + 'in the Node.js run configuration. Use the command-line flags for scripting.\n');
    process.exit(1);
  }
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  out(`${ESC}?1049h${ESC}?25l`);
  process.stdout.on('resize', render);
  process.stdin.on('keypress', (str, key) => {
    try {
      if (!key) key = { name: str };
      if (key.ctrl && key.name === 'c') leave([`${c.gray}claude-docker: interrupted, nothing changed.${c.reset}`]);
      if (mode === 'list') onListKey(str, key);
      else if (mode === 'input') onInputKey(str, key);
      else if (mode === 'prune') onPruneKey(str, key);
      else if (mode === 'confirm') { const fn = overlay.onYes; mode = 'list'; if (key.name === 'y') fn(); }
      else if (mode === 'message') mode = 'list';
      render();
    } catch (err) {
      out(`${ESC}?25h${ESC}?1049l`);
      process.stderr.write(`menu error: ${err.stack}\n`);
      process.exit(1);
    }
  });
  render();
}

main();
