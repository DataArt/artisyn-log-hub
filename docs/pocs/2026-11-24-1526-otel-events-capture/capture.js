'use strict';
// Drives a few short `claude -p` sessions with the Log Hub installer's OTEL env pointed at
// receiver.js, each built to trigger specific OTEL events. Synchronous: every session is a
// spawnSync. Start receiver.js on the same port first.
//
// Usage: node capture.js --claude <claude executable> --port <receiver port> --work <new empty dir>
//
// The work dir gets a copy of sample-project/ (claude-config/ becomes .claude/ there) and
// sessions.json. It must not exist yet or be empty; nothing outside it is written.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function prepareWorkDir(dir) {
  const abs = path.resolve(dir);
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const forbidden = [path.parse(abs).root, os.homedir(), repoRoot];
  if (forbidden.some((f) => path.resolve(f) === abs) || repoRoot.startsWith(abs + path.sep)) {
    throw new Error(`refusing to use ${abs} as the work dir`);
  }
  if (fs.existsSync(abs) && fs.readdirSync(abs).length > 0) {
    throw new Error(`work dir ${abs} is not empty`);
  }
  fs.mkdirSync(abs, { recursive: true });
  const sample = path.join(abs, 'sample');
  fs.cpSync(path.join(__dirname, 'sample-project', 'src'), path.join(sample, 'src'), { recursive: true });
  fs.cpSync(path.join(__dirname, 'sample-project', 'claude-config'), path.join(sample, '.claude'), { recursive: true });
  return { abs, sample };
}

// The installer's env (artisyn-hooks-installer/src/otel-env.ts OTEL_ENV_KEYS + OTEL_TRACE_ENV_KEYS),
// with every inherited OTEL key removed first so nothing else leaks in.
function otelEnv(port, extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('OTEL_') || k === 'CLAUDE_CODE_ENABLE_TELEMETRY' || k === 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA') continue;
    env[k] = v;
  }
  const base = `http://127.0.0.1:${port}`;
  return Object.assign(env, {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_COMPRESSION: 'none',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${base}/v1/logs`,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${base}/v1/metrics`,
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_RESOURCE_ATTRIBUTES: 'artisyn.repo=poc-otel-events',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/v1/traces`,
  }, extra || {});
}

const COMMON = ['--model', 'haiku', '--setting-sources', 'project', '--max-turns', '12'];

function run(claude, cwd, env, name, args, input) {
  const only = arg('--only');
  if (only && !only.split(',').includes(name)) return { name, skipped: true };
  process.stderr.write(`--- session ${name}\n`);
  const r = spawnSync(claude, args, { cwd, env, input: input || '', encoding: 'utf8', timeout: 300000 });
  const out = r.stdout || '';
  let sessionId = null;
  const m = out.match(/"session_id"\s*:\s*"([0-9a-f-]{36})"/);
  if (m) sessionId = m[1];
  const result = { name, exit: r.status, error: r.error ? r.error.message : null, sessionId, stdoutTail: out.slice(-600), stderrTail: (r.stderr || '').slice(-600) };
  process.stderr.write(`    exit=${r.status} session=${sessionId}\n`);
  return result;
}

try {
  const claude = arg('--claude');
  const port = Number(arg('--port'));
  const work = arg('--work');
  if (!claude || !port || !work) throw new Error('usage: node capture.js --claude <exe> --port <port> --work <dir>');
  const { abs, sample } = prepareWorkDir(work);
  const env = otelEnv(port);
  const sessions = [];

  // A: skill, sub-agent, @-mention, hooks, allowed tool decisions.
  const a = run(claude, sample, env, 'skill-subagent-mention', ['-p',
    'First use the poc-hello skill. Then use the Agent tool to spawn a general-purpose subagent that reads @src/app.js and reports how many functions it defines. Then reply with one short line.',
    ...COMMON, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep,Skill,Agent,Task']);
  sessions.push(a);

  // B: a denied tool (no permission in -p) -> tool_decision reject.
  sessions.push(run(claude, sample, env, 'denied-tool', ['-p',
    'Create a file named out.txt containing the word hello using the Write tool. If you cannot, say so in one line.',
    ...COMMON, '--output-format', 'json', '--permission-mode', 'default']));

  // C: compaction of session A.
  if (a.sessionId) {
    sessions.push(run(claude, sample, env, 'compact', ['-p', '/compact', '--resume', a.sessionId, ...COMMON, '--output-format', 'json']));
  }

  // D: API failure against a dead local port -> api_error / api_retries_exhausted.
  const dead = otelEnv(port, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port + 1}`, CLAUDE_CODE_MAX_RETRIES: '2', API_TIMEOUT_MS: '15000' });
  sessions.push(run(claude, sample, dead, 'api-failure', ['-p', 'Say hi.', ...COMMON, '--output-format', 'json']));

  // E: stream-json input: a second user message while the first turn runs (mid-turn delivery)
  // and a permission-mode change through a control request.
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Read src/app.js, then read it once more, then list its function names.' } },
    { type: 'control_request', request_id: 'poc-1', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } },
    { type: 'user', message: { role: 'user', content: 'Also tell me how many lines the file has.' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
  sessions.push(run(claude, sample, env, 'mid-turn', ['-p', ...COMMON, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read'], lines));

  // F: a sub-agent on its own (in A the skill's one-line reply ends the turn first).
  sessions.push(run(claude, sample, env, 'subagent', ['-p',
    'Use the Agent tool to spawn a general-purpose subagent that reads src/app.js and reports how many functions it defines. Then repeat its answer in one line.',
    ...COMMON, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep,Agent,Task']));

  // G: auto permission mode, where the classifier decides -> classifier_verdict / classifier_category.
  sessions.push(run(claude, sample, env, 'auto-mode', ['-p',
    'Create a file named notes.txt containing the word hello, then read src/app.js and say how many functions it has.',
    ...COMMON, '--output-format', 'json', '--permission-mode', 'auto']));

  // H: a Bash command in auto mode — not covered by config, so the classifier has to decide.
  sessions.push(run(claude, sample, env, 'auto-bash', ['-p',
    'Run the shell command `node -e "console.log(6*7)"` with the Bash tool and report its output in one line.',
    ...COMMON, '--output-format', 'json', '--permission-mode', 'auto']));

  fs.writeFileSync(path.join(abs, 'sessions.json'), JSON.stringify(sessions, null, 2), 'utf8');
  process.stderr.write(`done, ${sessions.length} sessions; see ${path.join(abs, 'sessions.json')}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`capture error: ${err.message}\n`);
  process.exit(1);
}
