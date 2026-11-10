#!/usr/bin/env node
// Applies today's pairing and the planned background-MCP join (impl-plan DD-2..DD-7) to the
// captured transcripts and checks the expectations per Claude Code version.
// Usage: node check.cjs [dir]   (default: fixtures/ if it has transcripts, else raw/)
// Reads the <capture>.transcript.jsonl files listed in CAPTURES. Exit 1 on a failed check.
'use strict';

const fs = require('fs');
const path = require('path');

const ACK_RE = /moved to the background as task ([A-Za-z0-9_-]+)/;

function tag(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
}

function flatten(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

// DD-3: notifications from string-content user lines (preferred) and queue-operation enqueues.
function collectNotifications(lines) {
  const byTask = new Map();
  const add = (xml, ts, fromUser) => {
    if (typeof xml !== 'string' || !xml.trimStart().startsWith('<task-notification>')) return;
    const taskId = tag(xml, 'task-id');
    if (!taskId) return;
    const prev = byTask.get(taskId);
    if (prev && (prev.fromUser || !fromUser)) return;
    byTask.set(taskId, { taskId, status: tag(xml, 'status') || '', result: tag(xml, 'result'),
      ts: Date.parse(ts), fromUser, toolUseId: tag(xml, 'tool-use-id') });
  };
  for (const e of lines) {
    if (e.type === 'user' && e.message && typeof e.message.content === 'string') add(e.message.content, e.timestamp, true);
    if (e.type === 'queue-operation' && e.operation === 'enqueue') add(e.content, e.timestamp, false);
  }
  return byTask;
}

// Today's rule (no background field) and the DD-4 rule.
function outcome(r) {
  if (r === null) return 'unresolved';
  if (r.background) {
    if (r.background.status === null) return 'unresolved';
    return r.background.status === 'completed' ? 'success' : 'failure';
  }
  return r.isError === true ? 'failure' : 'success';
}

function analyse(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const calls = [];
  const results = new Map();
  for (const e of lines) {
    const c = e.message && e.message.content;
    if (e.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, ts: Date.parse(e.timestamp) });
    }
    if (e.type === 'user' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type !== 'tool_result' || results.has(b.tool_use_id)) continue;
        const text = flatten(b.content);
        results.set(b.tool_use_id, { isError: b.is_error === true ? true : (b.is_error === false ? false : null),
          text, ts: Date.parse(e.timestamp), ackTaskId: (ACK_RE.exec(text) || [])[1] || null,
          tur: e.toolUseResult });
      }
    }
  }
  const notes = collectNotifications(lines);
  const version = (lines.find((e) => typeof e.version === 'string') || {}).version || '?';
  const rows = calls.filter((c) => c.name.startsWith('mcp__')).map((c) => {
    const r = results.get(c.id) || null;
    const tur = r && r.tur && !Array.isArray(r.tur) && typeof r.tur === 'object' ? r.tur : null;
    const curDur = tur && typeof tur.durationMs === 'number' ? tur.durationMs : (r ? r.ts - c.ts : null);
    const now = { outcome: outcome(r), durMs: curDur, text: r ? r.text : null };
    let next = now;
    let bg = null;
    if (r && r.isError !== true && r.ackTaskId) { // DD-2: isBackgroundCandidate + matchBackgroundAckTaskId
      const n = notes.get(r.ackTaskId) || null;
      bg = { taskId: r.ackTaskId, status: n ? n.status : null, via: n ? (n.fromUser ? 'user-line' : 'enqueue') : 'none' };
      next = { outcome: outcome({ ...r, background: { status: bg.status } }),
        durMs: n && n.ts >= c.ts ? n.ts - c.ts : now.durMs,
        text: n ? (n.result || '') : r.text };
    }
    return { name: c.name.replace('mcp__mock__', ''), isError: r ? r.isError : 'no result', bg, now, next };
  });
  return { version, rows, notes: [...notes.values()] };
}

const dirArg = process.argv[2];
const fixtures = path.join(__dirname, 'fixtures');
const dir = dirArg ? path.resolve(dirArg)
  : (fs.existsSync(fixtures) && fs.readdirSync(fixtures).some((f) => f.endsWith('.transcript.jsonl')) ? fixtures : path.join(__dirname, 'raw'));

let failed = 0;
function expect(label, ok, detail) {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}\n`);
  if (!ok) failed += 1;
}
const short = (s) => (s === null ? 'null' : JSON.stringify(s.length > 70 ? `${s.slice(0, 70)}…` : s));

// capture → expectation kind: old (no background), done (notifications arrived), live (no
// notification: still running, or the process was hard-killed), gone (a plain -p ended its turn
// and closed the MCP connection: enqueue-only "failed" notifications).
const CAPTURES = { 'old-full': 'old', 'mid-full': 'done', 'new-full': 'done', 'new-live': 'live',
  'new-kill': 'live', 'new-close': 'gone' };
for (const [tagName, kind] of Object.entries(CAPTURES)) {
  const file = path.join(dir, `${tagName}.transcript.jsonl`);
  if (!fs.existsSync(file)) { process.stdout.write(`== ${tagName}: missing ${file}\n`); failed += 1; continue; }
  const a = analyse(file);
  process.stdout.write(`== ${tagName} (CC ${a.version}); notifications: ${a.notes.map((n) => `${n.taskId}=${n.status}${n.toolUseId ? ' +tool-use-id' : ''}`).join(', ') || 'none'}\n`);
  for (const r of a.rows) {
    process.stdout.write(`  ${r.name.padEnd(9)} is_error=${String(r.isError).padEnd(5)} bg=${r.bg ? `${r.bg.taskId}/${r.bg.status}/${r.bg.via}` : '-'}\n`
      + `    today:   ${r.now.outcome.padEnd(10)} ${String(r.now.durMs).padStart(6)} ms ${short(r.now.text)}\n`
      + `    planned: ${r.next.outcome.padEnd(10)} ${String(r.next.durMs).padStart(6)} ms ${short(r.next.text)}\n`);
  }
  const by = Object.fromEntries(a.rows.map((r) => [r.name, r]));
  const has = (n) => by[n] !== undefined;
  expect('all four tools called', ['fast_echo', 'fast_fail', 'slow_echo', 'slow_fail'].every(has), `got ${Object.keys(by)}`);
  if (!['fast_echo', 'fast_fail', 'slow_echo', 'slow_fail'].every(has)) continue;
  // On old CC the first call can race the MCP connect ("No such tool available"); either way it
  // is not background and the plan must leave it as it is today.
  expect('fast_echo: not background, planned == today', !by.fast_echo.bg && JSON.stringify(by.fast_echo.next) === JSON.stringify(by.fast_echo.now), JSON.stringify(by.fast_echo));
  expect('fast_fail: not background, failure both ways', !by.fast_fail.bg && by.fast_fail.next.outcome === 'failure', JSON.stringify(by.fast_fail));
  if (kind === 'old') {
    expect('old CC: no call joined, planned == today', a.rows.every((r) => !r.bg && JSON.stringify(r.next) === JSON.stringify(r.now)), 'a call changed');
    expect('old CC: slow_echo success with its real ~8 s', by.slow_echo.now.outcome === 'success' && by.slow_echo.now.durMs >= 7500, JSON.stringify(by.slow_echo.now));
    expect('old CC: slow_fail failure', by.slow_fail.now.outcome === 'failure', JSON.stringify(by.slow_fail.now));
  } else if (kind === 'done') {
    expect('new CC: slow_echo backgrounded, today wrongly instant', !!by.slow_echo.bg && by.slow_echo.now.durMs < 7500, JSON.stringify(by.slow_echo));
    expect('new CC: slow_echo planned = success, >= 8 s, real result', by.slow_echo.next.outcome === 'success' && by.slow_echo.next.durMs >= 7500 && by.slow_echo.next.text === 'slow_echo: c', JSON.stringify(by.slow_echo.next));
    expect('new CC: slow_fail backgrounded and planned = failure', !!by.slow_fail.bg && by.slow_fail.bg.status !== null && by.slow_fail.next.outcome === 'failure', JSON.stringify(by.slow_fail));
  } else if (kind === 'live') {
    expect('live: slow calls backgrounded, no notification yet', ['slow_echo', 'slow_fail'].every((n) => by[n].bg && by[n].bg.status === null), JSON.stringify([by.slow_echo.bg, by.slow_fail.bg]));
    expect('live: planned = unresolved (background, no result), today success', ['slow_echo', 'slow_fail'].every((n) => by[n].next.outcome === 'unresolved' && by[n].now.outcome === 'success'), JSON.stringify([by.slow_echo, by.slow_fail]));
  } else if (kind === 'gone') {
    expect('kill: notifications only as queue-operation enqueue', ['slow_echo', 'slow_fail'].every((n) => by[n].bg && by[n].bg.via === 'enqueue'), JSON.stringify([by.slow_echo.bg, by.slow_fail.bg]));
    expect('kill: planned = failure from the enqueue status, today success', ['slow_echo', 'slow_fail'].every((n) => by[n].next.outcome === 'failure' && by[n].now.outcome === 'success'), JSON.stringify([by.slow_echo.next, by.slow_fail.next]));
  }
}
process.stdout.write(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
