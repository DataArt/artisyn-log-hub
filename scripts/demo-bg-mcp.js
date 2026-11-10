#!/usr/bin/env node
// Demo: uploads the four real Claude Code captures of MCP calls moved to the background
// (tests/scenarios/fixtures/bg-mcp/, from the PoC docs/pocs/2026-11-09-1318-mcp-mock-old-new-cc/)
// into a running Log Hub, one session each, in the repository DEMO_REPO, so the Logs tab shows
// what a background MCP call looks like:
//
//   new-full   CC 2.1.319, both notifications       slow_echo ✓ ok ⏱ 8.1s, slow_fail ✗ error
//   new-close  turn ended first, enqueue only        slow_echo ✗ error «Connection closed»
//   new-live   no notification at all                slow_echo ⧗ background
//   old-full   CC 2.1.211, before the hand-off       unchanged
//   live-then-done  new-live uploaded, then re-uploaded with the notifications (the real flow)
//
//   node scripts/demo-bg-mcp.js --email you@example.com [--url http://localhost:5003]
//   node scripts/demo-bg-mcp.js --api-key <key> [--url …]
//   … --only <new-full|new-close|new-live|old-full|live-then-done>   upload just that one
//   … --run-id <id>   reuse the session ids of an earlier run (re-upload replaces those sessions)
//
// Without --api-key it identifies as --email (auth mode `none` only) and creates an API key named
// `demo-bg-mcp-<random>`. The sessions belong to the key's owner. Every run uploads new session ids; the
// timestamps are shifted so each capture starts `--hours-ago` hours ago (default 1).
// HTTP goes through curl (sync, no dependencies); the cookie jar lives in tmp/demo-bg-mcp/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const fixturesDir = path.join(repoRoot, 'tests', 'scenarios', 'fixtures', 'bg-mcp');
const workDir = path.join(repoRoot, 'tmp', 'demo-bg-mcp');
const DEMO_REPO = 'https://demo.loghub.local/demo/background-mcp';
const CAPTURES = [
  ['new-full', 'CC 2.1.319, both task notifications'],
  ['new-close', 'CC 2.1.319, the turn ended first (enqueue only)'],
  ['new-live', 'CC 2.1.319, no task notification'],
  ['old-full', 'CC 2.1.211, before the background hand-off'],
];

function parseArgs(argv) {
  const out = { url: 'http://localhost:5003', email: null, apiKey: null, hoursAgo: 1, only: null, runId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${argv[i]} needs a value`);
      i += 1;
      return v;
    };
    if (argv[i] === '--url') out.url = next().replace(/\/+$/, '');
    else if (argv[i] === '--email') out.email = next();
    else if (argv[i] === '--api-key') out.apiKey = next();
    else if (argv[i] === '--hours-ago') out.hoursAgo = Number(next());
    else if (argv[i] === '--only') out.only = next();
    else if (argv[i] === '--run-id') out.runId = next();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.email && !out.apiKey) throw new Error('pass --email (auth mode none) or --api-key');
  if (!Number.isFinite(out.hoursAgo) || out.hoursAgo < 0) throw new Error('--hours-ago must be a number >= 0');
  return out;
}

// One HTTP call through curl; returns { status, body }. `bodyFile` is sent as is.
function http(method, url, { headers = {}, bodyFile = null, jar = null } = {}) {
  const args = ['-sS', '-X', method, '-w', '\n%{http_code}', url];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (bodyFile) args.push('--data-binary', `@${bodyFile}`);
  if (jar) args.push('-b', jar, '-c', jar);
  const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 60000 });
  const nl = out.lastIndexOf('\n');
  return { status: Number(out.slice(nl + 1)), body: out.slice(0, nl) };
}

function writeTmp(name, text) {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function createApiKey(url, email) {
  const jar = path.join(workDir, 'cookies.txt');
  const json = { 'Content-Type': 'application/json' };
  const config = http('GET', `${url}/api/v1/auth/config`);
  if (config.status !== 200 || JSON.parse(config.body).mode !== 'none') {
    throw new Error(`--email works only in auth mode none (got ${config.status} ${config.body}); pass --api-key`);
  }
  const who = http('POST', `${url}/api/v1/auth/identify`, {
    headers: json, jar, bodyFile: writeTmp('identify.json', JSON.stringify({ email })),
  });
  if (who.status < 200 || who.status > 299) throw new Error(`identify failed (${who.status}): ${who.body}`);
  const key = http('POST', `${url}/api/v1/api-keys`, {
    headers: json, jar, bodyFile: writeTmp('api-key.json', JSON.stringify({ name: `demo-bg-mcp-${crypto.randomBytes(3).toString('hex')}` })),
  });
  if (key.status !== 201) throw new Error(`creating the API key failed (${key.status}): ${key.body}`);
  return JSON.parse(key.body).key;
}

// The capture under a new session id: uuids prefixed with it, every timestamp shifted so the
// first line lands at `at` (deltas stay exact). A parentUuid pointing at a line the PoC
// sanitizer dropped is re-linked to the nearest earlier kept line (as in s-sess-03 step 6b).
function claudeBody(capture, sessionId, at) {
  const lines = fs.readFileSync(path.join(fixturesDir, `${capture}.transcript.jsonl`), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  const first = lines.find((r) => typeof r.timestamp === 'string');
  if (!first) throw new Error(`${capture} has no timestamp`);
  const shift = at.getTime() - Date.parse(first.timestamp);
  const prefixed = (v) => (typeof v === 'string' ? `${sessionId}-${v}` : v);
  const uuids = new Set(lines.map((r) => r.uuid).filter((u) => typeof u === 'string'));
  let lastUuid = null;
  let lastTs = at.getTime();
  const out = lines.map((r) => {
    const parent = typeof r.parentUuid === 'string' && !uuids.has(r.parentUuid) ? lastUuid : r.parentUuid;
    if (typeof r.uuid === 'string') lastUuid = r.uuid;
    const row = { ...r, sessionId };
    if ('uuid' in r) row.uuid = prefixed(r.uuid);
    if ('parentUuid' in r) row.parentUuid = prefixed(parent);
    if ('sourceToolAssistantUUID' in r) row.sourceToolAssistantUUID = prefixed(r.sourceToolAssistantUUID);
    if (typeof r.timestamp === 'string') {
      const ts = Date.parse(r.timestamp) + shift;
      lastTs = Math.max(lastTs, ts);
      row.timestamp = new Date(ts).toISOString();
    }
    return JSON.stringify(row);
  });
  return { text: out.join('\n') + '\n', endTs: lastTs };
}

// The hook's own log: one prompt_start/prompt_stop pair that gives the session its repository.
function artisynBody(sessionId, prompt, at, endTs) {
  const git = { repo: DEMO_REPO, branch: 'main' };
  return [
    { event: 'prompt_start', timestamp: at.toISOString(), session_id: sessionId, prompt, git },
    { event: 'prompt_stop', timestamp: new Date(endTs + 1000).toISOString(), session_id: sessionId },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function upload(url, apiKey, sessionId, name, bodies) {
  for (const type of ['artisyn', 'claude']) {
    const res = http('POST', `${url}/api/v2/logs?sessionId=${encodeURIComponent(sessionId)}&type=${type}`, {
      headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': apiKey },
      bodyFile: writeTmp(`${name}.${type}.jsonl`, bodies[type]),
    });
    if (res.status !== 201) throw new Error(`upload ${name} ${type} failed (${res.status}): ${res.body}`);
  }
}

// The real flow of a live session, the way the hook sends it: first the `new-live` snapshot (both
// slow calls still in the background), then — once the tasks end — the same transcript again with
// the two task notifications CC appends (enqueue + user line each, wording as in `new-full`) and
// the model's reply. The second upload replaces the first, so the calls go from «⧗ background»
// to ✓ ok / ✗ error with the real result.
function liveThenDone(url, apiKey, runId, at) {
  const sessionId = `demo-bg-mcp-live-then-done-${runId}`;
  const prompt = '[demo] background MCP calls — live-then-done: uploaded while running, then again after the notifications';
  const live = claudeBody('new-live', sessionId, at);
  upload(url, apiKey, sessionId, 'live-then-done.1', {
    artisyn: artisynBody(sessionId, prompt, at, live.endTs), claude: live.text,
  });
  process.stderr.write(`uploaded ${sessionId}  (1/2: tasks still running) — waiting 20 s\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);

  const rows = live.text.trim().split('\n').map((l) => JSON.parse(l));
  const callTs = (name) => Date.parse(rows.find((r) => Array.isArray(r.message?.content)
    && r.message.content.some((b) => b.type === 'tool_use' && b.name === name)).timestamp);
  let parent = rows[rows.length - 1].uuid;
  const extra = [];
  const notify = (n, taskId, tool, status, result, ts) => {
    const xml = `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n`
      + `<summary>MCP task ${taskId} (mock/${tool}) ${status}.</summary>\n<result>\n${result}\n</result>\n</task-notification>`;
    const uuid = `${sessionId}-done-n${n}`;
    extra.push(
      { type: 'queue-operation', operation: 'enqueue', timestamp: new Date(ts - 50).toISOString(), sessionId, content: xml },
      { type: 'user', uuid, parentUuid: parent, sessionId, timestamp: new Date(ts).toISOString(),
        message: { role: 'user', content: xml }, origin: { kind: 'task-notification' }, promptSource: 'system' },
    );
    parent = uuid;
  };
  // In the `cut` capture both tools run 60 s.
  const echoEnd = callTs('mcp__mock__slow_echo') + 60000;
  const failEnd = callTs('mcp__mock__slow_fail') + 60000;
  notify(1, 'kkumm8n15', 'slow_echo', 'completed', 'slow_echo: c', echoEnd);
  notify(2, 'kahpngag1', 'slow_fail', 'failed', 'Task failed: slow_fail: d failed', failEnd);
  extra.push({
    type: 'assistant', uuid: `${sessionId}-done-a`, parentUuid: parent, sessionId,
    timestamp: new Date(failEnd + 900).toISOString(),
    message: { role: 'assistant', model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 12 },
      content: [{ type: 'text', text: 'slow_echo returned "c"; slow_fail failed: slow_fail: d failed.' }] },
  });
  const done = live.text + extra.map((r) => JSON.stringify(r)).join('\n') + '\n';
  upload(url, apiKey, sessionId, 'live-then-done.2', {
    artisyn: artisynBody(sessionId, prompt, at, failEnd + 900), claude: done,
  });
  process.stderr.write(`uploaded ${sessionId}  (2/2: notifications arrived)\n`);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(workDir, { recursive: true });
  const apiKey = opts.apiKey || createApiKey(opts.url, opts.email);
  const runId = opts.runId || crypto.randomBytes(3).toString('hex');
  const at = new Date(Date.now() - opts.hoursAgo * 60 * 60 * 1000);
  for (const [capture, label] of CAPTURES) {
    if (opts.only && opts.only !== capture) continue;
    const sessionId = `demo-bg-mcp-${capture}-${runId}`;
    const claude = claudeBody(capture, sessionId, at);
    const bodies = {
      artisyn: artisynBody(sessionId, `[demo] background MCP calls — ${capture}: ${label}`, at, claude.endTs),
      claude: claude.text,
    };
    upload(opts.url, apiKey, sessionId, capture, bodies);
    process.stderr.write(`uploaded ${sessionId}  (${label})\n`);
  }
  if (!opts.only || opts.only === 'live-then-done') liveThenDone(opts.url, apiKey, runId, at);
  process.stderr.write(`\nRepository ${DEMO_REPO} — open it in ${opts.url}, Logs tab of each session, Tools → mock:slow_echo / mock:slow_fail.\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`demo-bg-mcp error: ${err.message}\n`);
  process.exit(1);
}
