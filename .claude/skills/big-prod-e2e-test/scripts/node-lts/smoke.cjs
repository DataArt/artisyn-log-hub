#!/usr/bin/env node
'use strict';

/**
 * Hook smoke test — the in-container half of the FR-NODE check (phase P5c, lib/node-lts.mjs), run
 * once per Node image tag and repo kind with `docker run --rm --network none node:<tag> node smoke.cjs`.
 *
 * Self-contained CommonJS, Node built-ins only, runs on Node >= 18.19 (the hook's engines floor).
 * Builds a throwaway git repo, installs the given log-hub-hooks plugin dir into it the way the
 * installer lays it out, then feeds the hook scripts realistic Claude Code stdin payloads exactly
 * as hooks.json wires them (`node ${CLAUDE_PLUGIN_ROOT}/scripts/<script>.js`, cwd = repo root).
 *
 * Usage:
 *   node smoke.cjs --plugin <pluginDir> --kind cjs|esm|none --work <workDir> [--port 47123]
 *
 * Prints exactly ONE JSON line to stdout:
 *   {node, kind, ok, hookVersion, steps:[{event, script, exit, ms, errors[]}], hookLogErrors[],
 *    hookLogExpected[], receiver:{...}, telemetryFiles, notes[]}
 * Exit code: 0 when ok, 1 otherwise.
 *
 * Repo kinds:
 *   cjs  — root package.json without "type" (CommonJS default)
 *   esm  — root package.json with "type": "module" (the 2026-10-23 ESM-host crash repro)
 *   none — no root package.json at all
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

// stderr lines that mean a hook crashed or misbehaved, whatever its exit code.
const STDERR_ERROR_RE = /(Uncaught|SyntaxError|ReferenceError|TypeError|RangeError|is not a function|is not defined|ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION|ERR_MODULE_NOT_FOUND|Cannot find module|-hook error:|ExperimentalWarning|DeprecationWarning)/;

// hook.log `[error]`/`[fail]` lines that are expected in this sandbox and do not count as failures:
// the server is deliberately unreachable (http://127.0.0.1:9) and there is no `claude` CLI.
const EXPECTED_LOG_RE = /(ECONNREFUSED|fetch failed|failed to fetch|127\.0\.0\.1:9\b|connect E|socket hang up|network|Upload failed|upload failed|status 0|spawn claude ENOENT|claude.*ENOENT|ENOENT.*claude)/i;

function parseArgs(argv) {
  const out = { port: '47123' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function canConnect(port) {
  // Synchronous TCP probe via a child node process (keeps this script sync).
  const code = `const s=require('net').connect(${Number(port)},'127.0.0.1');` +
    's.on(\'connect\',()=>{process.stdout.write(\'1\');s.destroy();});' +
    's.on(\'error\',()=>process.stdout.write(\'0\'));setTimeout(()=>process.exit(0),1500);';
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 });
  return r.stdout === '1';
}

function findProcesses(pattern) {
  const found = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return found; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(path.join('/proc', pid, 'cmdline'), 'utf8').split('\0').join(' ').trim();
      if (cmd.includes(pattern)) found.push({ pid: Number(pid), cmd });
    } catch { /* gone */ }
  }
  return found;
}

function buildRepo(work, pluginSrc, kind, port) {
  const repo = path.join(work, 'repo');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'smoke@example.com']);
  git(repo, ['config', 'user.name', 'Hook Smoke']);
  git(repo, ['remote', 'add', 'origin', 'https://example.com/acme/hook-smoke.git']);

  if (kind === 'esm') writeJson(path.join(repo, 'package.json'), { name: 'hook-smoke', version: '1.0.0', type: 'module' });
  else if (kind === 'cjs') writeJson(path.join(repo, 'package.json'), { name: 'hook-smoke', version: '1.0.0' });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'export const a = 1;\n', 'utf8');

  // Plugin, laid out as the installer does: <repo>/.artisyn/marketplace/plugins/log-hub-hooks/
  const pluginRoot = path.join(repo, '.artisyn', 'marketplace', 'plugins', 'log-hub-hooks');
  copyDir(pluginSrc, pluginRoot);

  // Config: tracked log-hub.json from the plugin's template, gitignored log-hub.local.json.
  const cfgDir = path.join(repo, '.artisyn', 'config');
  const tpl = path.join(pluginRoot, 'config-template', 'log-hub.json');
  let base = { serverUrl: '', telemetryDir: '', context: [] };
  try { base = JSON.parse(fs.readFileSync(tpl, 'utf8')); } catch { /* template missing: keep default */ }
  writeJson(path.join(cfgDir, 'log-hub.json'), base);
  writeJson(path.join(cfgDir, 'log-hub.local.json'), {
    apiKey: 'smoke-test-key',
    serverUrl: 'http://127.0.0.1:9',
    otelReceiverPort: Number(port),
  });
  fs.writeFileSync(path.join(cfgDir, '.gitignore'), 'log-hub.local.json\n', 'utf8');

  // .claude/settings.local.json the way the installer writes it (OTEL env block + enabledPlugins).
  writeJson(path.join(repo, '.claude', 'settings.local.json'), {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_COMPRESSION: 'none',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
      OTEL_LOG_TOOL_DETAILS: '1',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
    },
    enabledPlugins: { 'log-hub-hooks@artisyn-smoke': true },
  });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.artisyn/ai_work_dir/\n.claude/settings.local.json\n', 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return { repo, pluginRoot };
}

function writeTranscript(claudeHome, repo, sessionId) {
  const slug = repo.replace(/[^a-zA-Z0-9]/g, '-');
  const file = path.join(claudeHome, 'projects', slug, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t0 = Date.now();
  const ts = (n) => new Date(t0 + n * 1000).toISOString();
  const common = { sessionId, cwd: repo, version: '2.1.280', gitBranch: 'main', userType: 'external', isSidechain: false };
  const lines = [
    { ...common, type: 'user', uuid: 'u1', parentUuid: null, timestamp: ts(0),
      message: { role: 'user', content: 'List the files in src and add a comment to index.js' } },
    { ...common, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: ts(2), requestId: 'req_1',
      message: { id: 'msg_1', role: 'assistant', model: 'claude-sonnet-4-5', type: 'message',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls src', description: 'List src' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 } } },
    { ...common, type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: ts(3),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'index.js' }] },
      toolUseResult: { stdout: 'index.js', stderr: '', interrupted: false } },
    { ...common, type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: ts(5), requestId: 'req_2',
      message: { id: 'msg_2', role: 'assistant', model: 'claude-sonnet-4-5', type: 'message',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit',
          input: { file_path: path.join(repo, 'src', 'index.js'), old_string: 'export const a = 1;', new_string: '// answer\nexport const a = 1;' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 300, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 6200 } } },
    { ...common, type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: ts(6),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'The file has been updated.' }] } },
    { ...common, type: 'assistant', uuid: 'a3', parentUuid: 'u3', timestamp: ts(8), requestId: 'req_3',
      message: { id: 'msg_3', role: 'assistant', model: 'claude-sonnet-4-5', type: 'message',
        content: [{ type: 'text', text: 'Done: src has index.js and I added a comment.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 6500 } } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

function buildSteps(repo, sessionId, transcriptPath) {
  const base = { session_id: sessionId, transcript_path: transcriptPath, cwd: repo, permission_mode: 'default' };
  const editFile = path.join(repo, 'src', 'index.js');
  return [
    { event: 'SessionStart', script: 'lifecycle-hook.js',
      input: { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-4-5' } },
    { event: 'UserPromptSubmit', script: 'telemetry-hook.js',
      input: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'List the files in src and add a comment to index.js' } },
    { event: 'PostToolUse(Bash)', script: 'lifecycle-hook.js',
      input: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1',
        tool_input: { command: 'ls src', description: 'List src' },
        tool_response: { stdout: 'index.js', stderr: '', interrupted: false, isImage: false } } },
    { event: 'PostToolUse(Edit)', script: 'lifecycle-hook.js',
      input: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'toolu_2',
        tool_input: { file_path: editFile, old_string: 'export const a = 1;', new_string: '// answer\nexport const a = 1;' },
        tool_response: { filePath: editFile, oldString: 'export const a = 1;', newString: '// answer\nexport const a = 1;',
          originalFile: 'export const a = 1;\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2,
            lines: ['+// answer', ' export const a = 1;'] }], userModified: false, replaceAll: false } } },
    { event: 'PostToolUseFailure', script: 'lifecycle-hook.js',
      input: { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_x',
        tool_input: { command: 'false' }, error: 'Command failed with exit code 1' } },
    { event: 'PostToolBatch', script: 'lifecycle-hook.js', input: { ...base, hook_event_name: 'PostToolBatch' } },
    { event: 'Stop', script: 'send-logs-hook.js',
      input: { ...base, hook_event_name: 'Stop', stop_hook_active: false } },
    { event: 'Stop', script: 'post-turn-analysis-hook.js',
      input: { ...base, hook_event_name: 'Stop', stop_hook_active: false } },
    { event: 'SessionEnd', script: 'lifecycle-hook.js', input: { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' } },
    { event: 'SessionEnd', script: 'send-logs-hook.js', input: { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' } },
  ];
}

function listFiles(dir) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const kind = args.kind || 'cjs';
  if (!args.plugin || !args.work || !['cjs', 'esm', 'none'].includes(kind)) {
    process.stderr.write('usage: node smoke.cjs --plugin <dir> --kind cjs|esm|none --work <dir> [--port N]\n');
    process.exit(2);
  }
  const result = {
    node: process.version, kind, ok: false, hookVersion: null,
    steps: [], hookLogErrors: [], hookLogExpected: [], receiver: null, telemetryFiles: 0, notes: [],
  };
  try {
    const pluginSrc = path.resolve(args.plugin);
    try { result.hookVersion = JSON.parse(fs.readFileSync(path.join(pluginSrc, 'scripts', 'version.json'), 'utf8')).version; } catch { /* none */ }
    const work = path.resolve(args.work);
    const { repo, pluginRoot } = buildRepo(work, pluginSrc, kind, args.port);
    const claudeHome = path.join(work, 'claude-home');
    const sessionId = crypto.randomUUID();
    const transcriptPath = writeTranscript(claudeHome, repo, sessionId);

    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PROJECT_DIR: repo,
      CLAUDE_CONFIG_DIR: claudeHome,
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    };

    for (const step of buildSteps(repo, sessionId, transcriptPath)) {
      const t = Date.now();
      const r = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', step.script)], {
        cwd: repo, env, input: JSON.stringify(step.input), encoding: 'utf8', timeout: 90000,
      });
      const stderr = (r.stderr || '').split(/\r?\n/).filter(Boolean);
      const errors = stderr.filter((l) => STDERR_ERROR_RE.test(l)).map((l) => l.slice(0, 400));
      if (r.error) errors.unshift(`spawn: ${r.error.message}`);
      if (r.status !== 0) errors.unshift(`exit ${r.status}${r.signal ? ` signal ${r.signal}` : ''}: ${stderr.slice(-3).join(' | ').slice(0, 600)}`);
      result.steps.push({ event: step.event, script: step.script, exit: r.status, ms: Date.now() - t, errors });
    }

    // Let detached children (otel receiver, post-turn worker) start, log, and fail-open.
    sleepMs(5000);

    const receivers = findProcesses('otel-receiver.js');
    const listening = canConnect(args.port);
    result.receiver = { processes: receivers.length, listening, port: Number(args.port) };

    const workDir = path.join(repo, '.artisyn', 'ai_work_dir');
    const logFiles = listFiles(workDir).filter((f) => /\.log(\.\d+)?$/.test(f));
    const hookLog = path.join(workDir, 'hook.log');
    if (!fs.existsSync(hookLog)) result.notes.push('hook.log missing');
    for (const f of logFiles) {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        if (!/\[(error|fail)\]/.test(line) && !/\b(TypeError|ReferenceError|SyntaxError|is not a function)\b/.test(line)) continue;
        const entry = `${path.basename(f)}: ${line.slice(0, 400)}`;
        if (EXPECTED_LOG_RE.test(line) && !/\b(TypeError|ReferenceError|SyntaxError|is not a function)\b/.test(line)) result.hookLogExpected.push(entry);
        else result.hookLogErrors.push(entry);
      }
    }
    result.logFiles = logFiles.map((f) => path.relative(workDir, f));
    result.telemetryFiles = listFiles(path.join(workDir, 'telemetry')).filter((f) => f.endsWith('.jsonl')).length;

    // Kill our detached children before reporting.
    for (const p of receivers.concat(findProcesses('post-turn-analysis-worker.js'))) {
      try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
    }

    const stepsOk = result.steps.every((s) => s.exit === 0 && s.errors.length === 0);
    if (!listening) result.notes.push(`otel receiver not listening on ${args.port}`);
    if (result.telemetryFiles === 0) result.notes.push('no telemetry *.jsonl written');
    result.ok = stepsOk && fs.existsSync(hookLog) && result.hookLogErrors.length === 0 && listening && result.telemetryFiles > 0;
  } catch (err) {
    result.notes.push(`harness error: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)}`);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

main();
