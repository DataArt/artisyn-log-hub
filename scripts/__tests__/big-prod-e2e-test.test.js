'use strict';

// Unit tests for the big pre-prod e2e test skill (.claude/skills/big-prod-e2e-test/scripts).
// The skill is ESM (.mjs), so every module is loaded with a dynamic `import()`. Nothing here
// starts docker, touches the DB, talks to the network beyond a local `http` stub, or spawns
// `claude` — temp dirs live under os.tmpdir() and are removed after each test.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, describe } = require('node:test');

const SKILL_SCRIPTS = path.resolve(__dirname, '..', '..', '.claude', 'skills', 'big-prod-e2e-test', 'scripts');

function load(rel) {
  return import(pathToFileURL(path.join(SKILL_SCRIPTS, rel)).href);
}

function tmpDir(t, prefix = 'big-prod-e2e-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n');

// ---- evidence ---------------------------------------------------------------------------------

describe('evidence', () => {
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: 'sid-1',
    model: 'claude-haiku-4-5-20251001',
    mcp_servers: [],
    slash_commands: ['add-jsdoc', 'compact'],
    skills: ['add-jsdoc', 'java-refactor'],
    plugins: [
      { name: 'log-hub-hooks', source: 'log-hub-hooks@artisyn-1a2b3c4d' },
      { name: 'telemetry', source: 'telemetry@builtin' },
      { name: 'agents-md', source: 'agents-md@builtin' },
    ],
  };

  test('parseStream reads the init event, strips the date suffix and returns the LAST result', async () => {
    const { parseStream } = await load('lib/evidence.mjs');
    const text = [
      JSON.stringify(init),
      'not json — a stray log line',
      JSON.stringify({ type: 'result', subtype: 'success', result: 'first', session_id: 'sid-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'second', session_id: 'sid-1' }),
    ].join('\r\n');
    const parsed = parseStream(text);
    assert.equal(parsed.sessionId, 'sid-1');
    assert.equal(parsed.model, 'claude-haiku-4-5');
    assert.deepEqual(parsed.init.mcp_servers, []);
    assert.deepEqual(parsed.init.slash_commands, ['add-jsdoc', 'compact']);
    assert.equal(parsed.init.plugins.length, 3);
    assert.equal(parsed.finalResult.result, 'second');
  });

  test('normalizeModel leaves an id without a date suffix unchanged', async () => {
    const { normalizeModel, parseStream } = await load('lib/evidence.mjs');
    assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.equal(normalizeModel('claude-sonnet-5'), 'claude-sonnet-5');
    assert.equal(parseStream([JSON.stringify({ ...init, model: 'claude-opus-5' })]).model, 'claude-opus-5');
  });

  test('extractHarness finds skills from a Skill tool_use and a <command-name> user message', async () => {
    const { extractHarness } = await load('lib/evidence.mjs');
    const lines = jsonl([
      { type: 'user', message: { content: '<command-name>/add-jsdoc</command-name>\n<command-args>x</command-args>' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'api-endpoint' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'add-jsdoc' } }] } },
    ]);
    const h = extractHarness(lines);
    assert.deepEqual(h.skills, ['add-jsdoc', 'api-endpoint']);
    assert.deepEqual(h.rules, []);
    assert.deepEqual(h.workflows, []);
    assert.equal(h.subagents, 0);
  });

  test('extractHarness maps a rules nested_memory to its name and ignores other nested_memory', async () => {
    const { extractHarness } = await load('lib/evidence.mjs');
    const lines = jsonl([
      { type: 'attachment', attachment: { type: 'nested_memory', path: 'C:\\repo\\js-cli\\.claude\\rules\\cli-flags.md' } },
      { type: 'attachment', attachment: { type: 'nested_memory', displayPath: '.claude/rules/cli-flags.md' } },
      { type: 'attachment', attachment: { type: 'nested_memory', path: '/repo/lib/CLAUDE.md' } },
      { type: 'attachment', attachment: { type: 'other', path: '.claude/rules/not-memory.md' } },
    ]);
    assert.deepEqual(extractHarness(lines).rules, ['cli-flags']);
  });

  test('extractHarness finds workflows from a Workflow tool_use and passes the subagent count', async () => {
    const { extractHarness } = await load('lib/evidence.mjs');
    const lines = jsonl([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Workflow', input: { name: 'java-refactor' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'x' } }] } },
    ]);
    const h = extractHarness(lines, 3);
    assert.deepEqual(h.workflows, ['java-refactor']);
    assert.deepEqual(h.skills, []);
    assert.equal(h.subagents, 3);
  });

  test('extractHarness finds MCP servers from mcp__<server>__<tool> calls and Read paths', async () => {
    const { extractHarness, mcpServerFromTool } = await load('lib/evidence.mjs');
    const lines = jsonl([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__big-test-pg__query', input: { sql: 'SELECT 1' } },
            { type: 'tool_use', name: 'mcp__big-test-pg__query', input: { sql: 'SELECT 2' } },
            { type: 'tool_use', name: 'Read', input: { file_path: 'D:\\x\\node-service\\src\\calc.js' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
    ]);
    const h = extractHarness(lines);
    assert.deepEqual(h.mcp, ['big-test-pg']);
    assert.deepEqual(h.reads, ['D:/x/node-service/src/calc.js']);
    assert.equal(mcpServerFromTool('Read'), null);
    assert.equal(mcpServerFromTool('mcp__a__b__c'), 'a');
  });

  test('checkIsolation allows exactly the scenario MCP servers, connected', async () => {
    const { checkIsolation } = await load('lib/evidence.mjs');
    const base = { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [], slash_commands: [], skills: [], plugins: [] };
    const pg = { name: 'big-test-pg', status: 'connected' };
    const ok = checkIsolation({ ...base, mcp_servers: [pg] }, [], [], ['big-test-pg']);
    assert.equal(ok.status, 'pass', ok.detail);
    const extra = checkIsolation({ ...base, mcp_servers: [pg, { name: 'claude.ai Gmail', source: 'claudeai' }] }, [], [], ['big-test-pg']);
    assert.equal(extra.status, 'fail');
    assert.ok(extra.detail.includes('claude.ai Gmail'));
    const failed = checkIsolation({ ...base, mcp_servers: [{ name: 'big-test-pg', status: 'failed' }] }, [], [], ['big-test-pg']);
    assert.equal(failed.status, 'fail');
    assert.ok(failed.detail.includes('big-test-pg is failed'));
    const missing = checkIsolation(base, [], [], ['big-test-pg']);
    assert.equal(missing.status, 'fail');
    assert.ok(missing.detail.includes('missing'));
    assert.equal(checkIsolation({ ...base, mcp_servers: [pg] }, [], []).status, 'fail', 'not allowed without allowedMcp');
  });

  test('checkIsolation passes with builtin plugins and a fixture workflow name in init.skills', async () => {
    const { checkIsolation } = await load('lib/evidence.mjs');
    const r = checkIsolation(init, ['global-skill', 'java-refactor'], ['add-jsdoc', 'java-refactor']);
    assert.equal(r.status, 'pass', r.detail);
  });

  test('checkIsolation fails on an MCP server', async () => {
    const { checkIsolation } = await load('lib/evidence.mjs');
    const r = checkIsolation({ ...init, mcp_servers: [{ name: 'claude.ai Gmail', source: 'claudeai' }] }, [], []);
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /mcp_servers/);
    assert.match(r.detail, /claudeai/);
  });

  test('checkIsolation fails on a global skill name', async () => {
    const { checkIsolation } = await load('lib/evidence.mjs');
    const r = checkIsolation({ ...init, skills: [...init.skills, 'comfyui'] }, ['comfyui', 'adb'], ['add-jsdoc']);
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /comfyui/);
  });

  test('checkIsolation fails on a non-builtin extra plugin', async () => {
    const { checkIsolation } = await load('lib/evidence.mjs');
    const plugins = [...init.plugins, { name: 'adlc', source: 'adlc@some-marketplace' }];
    const r = checkIsolation({ ...init, plugins }, [], []);
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /adlc@some-marketplace/);
  });

  test('checkIsolation fails without an init event', async () => {
    const { checkIsolation } = await load('lib/evidence.mjs');
    assert.equal(checkIsolation(null).status, 'fail');
  });

  test('isExercised covers every S1–S7 requires shape', async () => {
    const { isExercised } = await load('lib/evidence.mjs');
    const { SCENARIOS } = await load('scenarios.mjs');
    const req = Object.fromEntries(SCENARIOS.map((s) => [s.id, s.requires]));
    const none = { skills: [], rules: [], workflows: [], subagents: 0, mcp: [], reads: [] };

    const noHarness = {}; // the empty-requires "nothing at all" rule
    assert.equal(isExercised(noHarness, none), true);
    assert.equal(isExercised(noHarness, { ...none, mcp: ['big-test-pg'] }), false, 'S1 with a stray MCP call');
    const s7Reads = ['D:/x/dotnet-api/src/Api/Program.cs', 'D:/x/dotnet-api/tests/Api.Tests/HealthTests.cs'];
    assert.equal(isExercised(req.S7, { ...none, mcp: ['big-test-pg'], reads: s7Reads }), true);
    assert.equal(isExercised(req.S7, { ...none, reads: s7Reads }), false, 'S7 without the MCP call');
    assert.equal(isExercised(req.S7, { ...none, mcp: ['big-test-pg'], reads: [s7Reads[0]] }), false, 'S7 missing a read');
    assert.equal(
      isExercised(req.S7, { ...none, mcp: ['big-test-pg'], reads: ['D:/x/dotnet-api/xsrc/Api/Program.cs', s7Reads[1]] }),
      false,
      'segment boundary',
    );
    assert.equal(isExercised(noHarness, { ...none, subagents: 1 }), false, 'S1 with stray subagents');
    assert.equal(isExercised(noHarness, { ...none, skills: ['x'] }), false);

    assert.equal(isExercised(req.S2, { ...none, skills: ['add-jsdoc'] }), true);
    assert.equal(isExercised(req.S2, none), false);

    assert.equal(isExercised(req.S3, { ...none, subagents: 1 }), true);
    assert.equal(isExercised(req.S3, none), false);

    assert.equal(isExercised(req.S4, { ...none, workflows: ['java-refactor'], subagents: 2 }), true);
    assert.equal(isExercised(req.S4, none), false);

    assert.equal(isExercised(req.S5, { ...none, rules: ['cli-flags'] }), true);
    assert.equal(isExercised(req.S5, { ...none, rules: ['other'] }), false);

    assert.equal(isExercised(req.S6, { ...none, skills: ['api-endpoint'], subagents: 1 }), true);
    assert.equal(isExercised(req.S6, { ...none, skills: ['api-endpoint'] }), false);
    assert.equal(isExercised(req.S6, { ...none, subagents: 1 }), false);
  });

  const toolUse = (id, name, input = {}, extra = {}) => ({
    type: 'assistant',
    ...extra,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
  const toolResult = (id, content, extra = {}, blockExtra = {}) => ({
    type: 'user',
    ...extra,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...blockExtra }] },
  });

  test('extractHarness counts Bash calls and Bash errors (non-Bash errors are not counted)', async () => {
    const { extractHarness } = await load('lib/evidence.mjs');
    const h = extractHarness(
      jsonl([
        toolUse('b1', 'Bash', { command: 'node --version' }),
        toolResult('b1', 'v22.0.0'),
        toolUse('b2', 'Bash', { command: 'node -e "process.exit(3)"' }),
        toolResult('b2', 'Exit code 3', {}, { is_error: true }),
        toolUse('r1', 'Read', { file_path: '/x/missing.js' }),
        toolResult('r1', 'File does not exist.', {}, { is_error: true }),
      ]),
    );
    assert.equal(h.bashCalls, 2);
    assert.equal(h.bashErrors, 1);
    assert.deepEqual(h.denials, []);
    assert.equal(h.backgroundAgent, false);
    assert.equal(h.toolUseAfterNotification, false);
    assert.equal(h.cwd, null);
  });

  test('extractHarness finds denials from toolDenialKind and from the permission text', async () => {
    const { extractHarness, PERMISSION_DENIAL_RE } = await load('lib/evidence.mjs');
    const h = extractHarness(
      jsonl([
        toolUse('w1', 'Write', { file_path: 'denied.txt', content: 'hi' }),
        toolResult('w1', 'The user doesn\'t want to proceed with this tool use.', { toolDenialKind: 'user-rejected' }, { is_error: true }),
        toolUse('e1', 'Edit', { file_path: 'a.js' }),
        toolResult('e1', [{ type: 'text', text: 'Claude requested permissions to edit a.js, but you haven\'t granted it yet.' }], {}, { is_error: true }),
        toolUse('b1', 'Bash', { command: 'node -e "process.exit(3)"' }),
        toolResult('b1', 'Exit code 3', {}, { is_error: true }),
      ]),
    );
    assert.deepEqual(h.denials, ['Edit', 'Write']);
    assert.equal(h.bashErrors, 1, 'an ordinary Bash error is not a denial');
    assert.match('Claude requested permissions to write to x', PERMISSION_DENIAL_RE);
    assert.doesNotMatch('Exit code 3', PERMISSION_DENIAL_RE);
  });

  test('extractHarness: background agent, main-thread tool use after the notification, first cwd', async () => {
    const { extractHarness } = await load('lib/evidence.mjs');
    const before = [
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'user', cwd: 'D:\\run\\ts-webapp\\packages\\web', message: { content: 'count the lines' } },
      toolUse('a1', 'Agent', { prompt: 'count', run_in_background: true }, { cwd: '/elsewhere' }),
      toolResult('a1', 'Async agent launched'),
    ];
    const notification = { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>' } };

    const sidechainOnly = extractHarness(jsonl([...before, notification, toolUse('s1', 'Read', { file_path: 'x' }, { isSidechain: true })]));
    assert.equal(sidechainOnly.backgroundAgent, true);
    assert.equal(sidechainOnly.toolUseAfterNotification, false, 'a sidechain tool use does not count');
    assert.equal(sidechainOnly.cwd, 'D:/run/ts-webapp/packages/web', 'the first entry with a cwd, forward slashes');

    const main = extractHarness(jsonl([...before, notification, toolUse('w1', 'Write', { file_path: 'LINES.txt' })]));
    assert.equal(main.toolUseAfterNotification, true);

    const textBlock = { type: 'user', message: { content: [{ type: 'text', text: '<task-notification>done</task-notification>' }] } };
    assert.equal(extractHarness(jsonl([...before, textBlock, toolUse('w1', 'Write', {})])).toolUseAfterNotification, true);

    const noNotification = extractHarness(jsonl([...before, toolUse('w1', 'Write', {})]));
    assert.equal(noNotification.toolUseAfterNotification, false);

    const foreground = extractHarness(jsonl([toolUse('t1', 'Task', { prompt: 'x' }), toolUse('a2', 'Agent', { run_in_background: 'true' })]));
    assert.equal(foreground.backgroundAgent, false, 'only run_in_background === true');
    assert.equal(extractHarness(jsonl([toolUse('t2', 'Task', { run_in_background: true })])).backgroundAgent, true);
  });

  test('isExercised / exercisedGap for bash, bashError, denied, background, cwd and noHarness', async () => {
    const { isExercised, exercisedGap } = await load('lib/evidence.mjs');
    const { SCENARIOS, LEGACY_SCENARIO } = await load('scenarios.mjs');
    const req = Object.fromEntries([...SCENARIOS, LEGACY_SCENARIO].map((s) => [s.id, s.requires]));
    const none = {
      skills: [],
      rules: [],
      workflows: [],
      subagents: 0,
      mcp: [],
      reads: [],
      bashCalls: 0,
      bashErrors: 0,
      denials: [],
      backgroundAgent: false,
      toolUseAfterNotification: false,
      cwd: null,
    };

    // bash — a minimum count
    assert.equal(isExercised({ bash: 2 }, { ...none, bashCalls: 2 }), true);
    assert.equal(isExercised({ bash: 2 }, { ...none, bashCalls: 1 }), false);
    assert.equal(exercisedGap({ bash: 2 }, { ...none, bashCalls: 1 }), 'Bash calls 1 < 2');
    assert.equal(exercisedGap({ bash: 1 }, {}), 'Bash calls 0 < 1');

    // bashError
    assert.equal(isExercised({ bashError: true }, { ...none, bashErrors: 1 }), true);
    assert.equal(exercisedGap({ bashError: true }, none), 'no Bash call ended with is_error');

    // denied
    assert.equal(isExercised({ denied: ['Write'] }, { ...none, denials: ['Write'] }), true);
    assert.equal(exercisedGap({ denied: ['Write'] }, { ...none, denials: ['Edit'] }), 'not denied: Write');

    // background — both flags
    const bg = { ...none, backgroundAgent: true, toolUseAfterNotification: true };
    assert.equal(isExercised({ background: true }, bg), true);
    assert.equal(exercisedGap({ background: true }, { ...bg, backgroundAgent: false }), 'no Agent call with run_in_background: true');
    assert.equal(exercisedGap({ background: true }, { ...bg, toolUseAfterNotification: false }), 'no main-thread tool call after <task-notification>');
    assert.equal(exercisedGap({ background: true }, none).split('; ').length, 2, 'one gap per unmet flag');

    // cwd — the runner's cwdOk
    assert.equal(isExercised({ cwd: true }, { ...none, cwd: 'D:/r/packages/web', cwdOk: true }), true);
    assert.equal(exercisedGap({ cwd: true }, { ...none, cwd: 'D:/r', cwdOk: false }), 'session cwd not as expected (transcript cwd D:/r)');
    assert.equal(exercisedGap({ cwd: true }, none), 'session cwd not as expected (transcript cwd none)');

    // noHarness — explicit, and combined with another key
    assert.equal(isExercised({ noHarness: true }, none), true);
    assert.match(exercisedGap({ noHarness: true }, { ...none, workflows: ['w'] }), /^expected no harness use, got .*workflows=\[w\]/);
    assert.equal(isExercised(req.S1, { ...none, bashCalls: 1 }), true);
    assert.equal(isExercised(req.S1, { ...none, bashCalls: 1, subagents: 1 }), false, 'S1 with a stray subagent');
    assert.equal(isExercised(req.S1, none), false, 'S1 without the Bash call');
    assert.equal(isExercised(req.L1, none), true);
    assert.equal(isExercised(req.L1, { ...none, skills: ['x'] }), false);
    assert.equal(exercisedGap(req.L1, none), null);

    // the scenarios themselves
    const s8 = { ...none, bashCalls: 2, bashErrors: 1, denials: ['Write'] };
    assert.equal(isExercised(req.S8, s8), true);
    assert.equal(exercisedGap(req.S8, { ...s8, bashErrors: 0, denials: [] }), 'no Bash call ended with is_error; not denied: Write');
    assert.equal(isExercised(req.S9, { ...bg, subagents: 1 }), true);
    assert.equal(isExercised(req.S9, { ...bg, subagents: 0 }), false);
    for (const id of ['S10', 'S11']) {
      assert.equal(isExercised(req[id], { ...none, bashCalls: 1 }), true, id);
      assert.equal(isExercised(req[id], none), false, id);
    }
  });

  test('workTimeWindow spans the prompt to the last main-thread assistant entry after the notification', async () => {
    const { workTimeWindow } = await load('lib/evidence.mjs');
    const at = (s) => new Date(Date.UTC(2026, 9, 23, 10, 0, s)).toISOString();
    const lines = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: at(0) },
      { type: 'user', timestamp: at(1), message: { content: 'Use the Agent tool with run_in_background…' } },
      { ...toolUse('a1', 'Agent', { run_in_background: true }), timestamp: at(3) },
      { ...toolResult('a1', 'Async agent launched'), timestamp: at(4) },
      { type: 'assistant', timestamp: at(5), message: { content: [{ type: 'text', text: 'Waiting.' }] } },
      { ...toolUse('s1', 'Read', { file_path: 'x' }, { isSidechain: true }), timestamp: at(20) },
      { type: 'user', timestamp: at(30), message: { content: '<task-notification>\ndone\n</task-notification>' } },
      { ...toolUse('w1', 'Write', { file_path: 'LINES.txt' }), timestamp: at(35) },
      { ...toolResult('w1', 'written'), timestamp: at(36) },
      { type: 'assistant', timestamp: at(42), message: { content: [{ type: 'text', text: 'Wrote 12.' }] } },
      // After the last assistant entry: a sidechain assistant and a tool_result never end the turn.
      { type: 'assistant', isSidechain: true, timestamp: at(50), message: { content: [{ type: 'text', text: 'late' }] } },
      { ...toolResult('w2', 'late result'), timestamp: at(55) },
    ];
    assert.deepEqual(workTimeWindow(jsonl(lines)), { startTs: at(1), endTs: at(42), seconds: 41 });

    const noNotification = lines.filter((l) => !String(l.message?.content).startsWith('<task-notification>'));
    assert.equal(workTimeWindow(jsonl(noNotification)), null);
    const nothingAfter = lines.slice(0, 7).concat(lines.slice(10));
    assert.equal(workTimeWindow(jsonl(nothingAfter)), null, 'only a sidechain assistant and a tool_result after the notification');
  });

  test('findTranscripts returns the main transcript and subagents from both layouts', async (t) => {
    const { findTranscripts } = await load('lib/evidence.mjs');
    const cfg = tmpDir(t);
    const sid = '11111111-2222-3333-4444-555555555555';
    const base = path.join(cfg, 'projects', 'D--repo-js-cli');
    writeFile(path.join(cfg, 'projects', 'other-slug', 'unrelated.jsonl'), '{}');
    writeFile(path.join(base, `${sid}.jsonl`), '{}');
    writeFile(path.join(base, sid, 'subagents', 'agent-a1.jsonl'), '{}');
    writeFile(path.join(base, sid, 'subagents', 'agent-a2.jsonl'), '{}');
    writeFile(path.join(base, sid, 'subagents', 'agent-a1.meta.json'), '{}');
    writeFile(path.join(base, sid, 'subagents', 'workflows', 'wf-1', 'agent-w1.jsonl'), '{}');
    writeFile(path.join(base, sid, 'subagents', 'workflows', 'wf-1', 'agent-w2.jsonl'), '{}');
    writeFile(path.join(base, sid, 'subagents', 'workflows', 'wf-1', 'journal.json'), '{}');

    const found = findTranscripts(cfg, sid);
    assert.equal(found.main, path.join(base, `${sid}.jsonl`));
    assert.equal(found.subagents.length, 4);
    assert.ok(found.subagents.includes(path.join(base, sid, 'subagents', 'agent-a1.jsonl')));
    assert.ok(found.subagents.includes(path.join(base, sid, 'subagents', 'workflows', 'wf-1', 'agent-w2.jsonl')));

    assert.equal(findTranscripts(cfg, 'missing-session'), null);
    assert.equal(findTranscripts(path.join(cfg, 'nope'), sid), null);
  });

  test('globalHarnessNames lists skill dirs and command basenames; missing dirs give []', async (t) => {
    const { globalHarnessNames } = await load('lib/evidence.mjs');
    const home = tmpDir(t);
    fs.mkdirSync(path.join(home, 'skills', 'a'), { recursive: true });
    fs.mkdirSync(path.join(home, 'skills', 'b'), { recursive: true });
    writeFile(path.join(home, 'commands', 'c.md'), '# c');
    assert.deepEqual(globalHarnessNames(home), ['a', 'b', 'c']);
    assert.deepEqual(globalHarnessNames(path.join(home, 'missing')), []);
  });
});

// ---- report -----------------------------------------------------------------------------------

describe('report', () => {
  async function passingReport() {
    const { createReport, recordInfra, recordAc, recordSession, recordVisibility } = await load('lib/report.mjs');
    const r = createReport({ stamp: '20261012-101010', runDir: '/x/log_hub_big_test-20261012-101010', image: 'artisyn-log-hub:big-test-20261012-101010' });
    recordInfra(r, 'preflight', 'pass');
    recordInfra(r, 'build', 'pass');
    recordAc(r, 'FR-2', 'pass', 'amd64');
    recordSession(r, {
      id: 'S1',
      title: 'plain edit, no harness',
      repo: 'node-service',
      owner: 'U1',
      model: 'sonnet',
      status: 'pass',
      attempts: [{ n: 1, session_id: 'sid-s1' }],
      isolation: { status: 'pass', detail: 'ok' },
      evidence: [
        { label: 'summary', path: 'S1/summary.png' },
        { label: 'harness-usage', path: 'S1/harness-usage.png' },
      ],
    });
    recordVisibility(r, { id: 'V1', viewer: 'U1', view: 'personal', status: 'pass', detail: 'repos as expected', screenshot: 'visibility/V1.png' });
    return r;
  }

  test('computeOverall is PASS only when everything passes', async () => {
    const { computeOverall, recordSession, recordInfra, recordAc, recordVisibility, exitCodeFor } = await load('lib/report.mjs');
    const r = await passingReport();
    assert.equal(computeOverall(r), 'PASS');
    assert.equal(exitCodeFor(r), 0);

    const notExercised = await passingReport();
    recordSession(notExercised, { id: 'S2', status: 'scenario not exercised', attempts: [] });
    assert.equal(computeOverall(notExercised), 'FAIL');
    assert.equal(exitCodeFor(notExercised), 1);

    const infraFail = await passingReport();
    recordInfra(infraFail, 'teardown', 'fail', new Error('containers left'));
    assert.equal(computeOverall(infraFail), 'FAIL');
    assert.equal(exitCodeFor(infraFail), 2);

    const acFail = await passingReport();
    recordAc(acFail, 'FR-4', 'fail', 'dev port changed');
    assert.equal(computeOverall(acFail), 'FAIL');

    const visFail = await passingReport();
    recordVisibility(visFail, { id: 'V2', status: 'fail', detail: 'saw node-service', screenshot: 'visibility/V2.png' });
    assert.equal(computeOverall(visFail), 'FAIL');
  });

  test('renderIndexMd lists every id, puts failed infra first and links screenshots relatively', async () => {
    const { renderIndexMd, recordInfra, recordSession, recordVisibility } = await load('lib/report.mjs');
    const r = await passingReport();
    recordInfra(r, 'smoke', 'fail', 'claude -p exited with 1');
    recordSession(r, { id: 'S3', repo: 'ts-webapp', status: 'fail: not ingested', attempts: [{ n: 1, session_id: 'sid-s3' }], error: 'not ingested after 300s' });
    recordVisibility(r, { id: 'V7', viewer: 'U3', view: 'T-transparent / js-cli', status: 'fail', detail: 'S5 not listed', screenshot: 'visibility/V7.png', failScreenshot: 'visibility/V7-fail.png' });
    const md = renderIndexMd(r);

    for (const id of ['S1', 'S3', 'V1', 'V7']) assert.ok(md.includes(id), `index.md mentions ${id}`);
    const infra = md.slice(md.indexOf('## Infra'), md.indexOf('## AC checks'));
    assert.ok(infra.indexOf('| smoke |') < infra.indexOf('| preflight |'), 'failed infra row first');
    assert.match(md, /\[visibility\/V1\.png\]\(visibility\/V1\.png\)/);
    assert.ok(!/\]\((?:[A-Za-z]:|\/)/.test(md), 'no absolute link targets');
  });

  test('renderIndexMd ends with the Evidence gallery (pass, fail and no-screenshot cases)', async () => {
    const { renderIndexMd, recordSession, recordVisibility } = await load('lib/report.mjs');
    const r = await passingReport();
    recordSession(r, {
      id: 'S5',
      title: 'path-scoped rule',
      repo: 'js-cli',
      status: 'fail',
      attempts: [{ n: 1, session_id: 'sid-s5' }],
      isolation: { status: 'pass' },
      evidence: [{ label: 'summary', path: 'S5/summary.png' }],
      mismatches: [{ field: 'rules', expected: ['cli-flags'], observed: [], note: 'no rule row', screenshot: 'S5/rules-mismatch.png' }],
    });
    recordSession(r, { id: 'S6', title: 'skill + subagent', status: 'fail: not ingested', attempts: [], error: 'not ingested after 300s' });
    recordVisibility(r, { id: 'V5', viewer: 'U2', view: 'T-restricted / node-service', status: 'fail', detail: 'S1 visible', screenshot: 'visibility/V5.png', failScreenshot: 'visibility/V5-fail.png' });
    const md = renderIndexMd(r);

    const gallery = md.slice(md.indexOf('## Evidence'));
    assert.ok(md.indexOf('## Evidence') > md.indexOf('## Stand'), 'Evidence is the last section');
    assert.ok(!/\n## /.test(gallery.slice(1)), 'no section after Evidence');

    const s1 = gallery.slice(gallery.indexOf('### 🟢 S1'), gallery.indexOf('### ', gallery.indexOf('### 🟢 S1') + 4));
    assert.match(s1, /PASS/);
    assert.match(s1, /!\[summary\]\(S1\/summary\.png\)/);
    assert.match(gallery, /### 🟢 V1 .*PASS/);
    assert.match(gallery, /!\[V1\]\(visibility\/V1\.png\)/);

    const s5Start = gallery.indexOf('### 🔴 S5');
    assert.ok(s5Start >= 0, 'failing session has a red heading');
    const s5 = gallery.slice(s5Start, gallery.indexOf('### ', s5Start + 4));
    assert.match(s5, /FAIL/);
    const wrong = s5.indexOf('What is wrong');
    const mismatchImg = s5.indexOf('![rules mismatch](S5/rules-mismatch.png)');
    const regularImg = s5.indexOf('![summary](S5/summary.png)');
    assert.ok(wrong >= 0 && mismatchImg > wrong, '"What is wrong" before the mismatch image');
    assert.ok(regularImg > mismatchImg, 'mismatch image before regular evidence');
    assert.match(s5, /`rules`: expected `\["cli-flags"\]`, observed `\[\]`/);

    const s6Start = gallery.indexOf('### 🔴 S6');
    const s6 = gallery.slice(s6Start, gallery.indexOf('### ', s6Start + 4));
    assert.match(s6, /No screenshot: not ingested after 300s/);
    assert.ok(!s6.includes('!['));

    assert.match(gallery, /### 🔴 V5 .*FAIL/);
    assert.match(gallery, /!\[V5 failure\]\(visibility\/V5-fail\.png\)/);
  });

  test('renderIndexHtml embeds every screenshot inline, lists failures first and escapes text', async () => {
    const { renderIndexHtml } = await load('lib/report-html.mjs');
    const { recordSession, recordVisibility } = await load('lib/report.mjs');
    const r = await passingReport();
    recordSession(r, {
      id: 'S5',
      title: 'rule <script>',
      repo: 'js-cli',
      status: 'fail',
      attempts: [{ n: 1, session_id: 'sid-s5' }],
      isolation: { status: 'pass' },
      evidence: [{ label: 'summary', path: 'S5/summary.png' }],
      mismatches: [{ field: 'rules', expected: ['cli-flags'], observed: [], note: 'no rule row', screenshot: 'S5/rules-mismatch.png' }],
    });
    recordVisibility(r, { id: 'V5', viewer: 'U2', view: 'T-restricted', status: 'fail', detail: 'S1 visible', screenshot: 'visibility/V5.png', failScreenshot: 'visibility/V5-fail.png' });
    const html = renderIndexHtml(r);

    assert.match(html, /^<!doctype html>/);
    for (const p of ['S1/summary.png', 'S5/summary.png', 'S5/rules-mismatch.png', 'visibility/V1.png', 'visibility/V5-fail.png']) {
      assert.ok(html.includes(`<img loading="lazy" src="${p}"`), `inline <img> for ${p}`);
    }
    assert.ok(!/src="(?:[A-Za-z]:|\/|https?:)/.test(html), 'only relative image sources, no network');
    assert.ok(html.indexOf('id="failures"') < html.indexOf('id="evidence"'));
    const failures = html.slice(html.indexOf('id="failures"'), html.indexOf('id="infra"'));
    assert.ok(failures.includes('href="#case-S5"') && failures.includes('href="#case-V5"'));
    assert.ok(html.includes('id="case-S5"') && html.includes('class="case fail"'));
    assert.ok(!html.includes('rule <script>') && html.includes('rule &lt;script&gt;'), 'text is escaped');
  });
});

// ---- stand ------------------------------------------------------------------------------------

describe('report feature cases', () => {
  test('a feature case counts toward overall and renders in the table, mismatches and gallery', async () => {
    const { createReport, recordCase, computeOverall, renderIndexMd } = await load('lib/report.mjs');
    const r = createReport({ stamp: '20261012-120000' });
    recordCase(r, { id: 'FC', title: 'file categories', status: 'pass', checked: 'saved and applied', evidence: [{ label: 'settings', path: 'FC/settings.png' }] });
    assert.equal(computeOverall(r), 'PASS');
    let md = renderIndexMd(r);
    assert.ok(md.includes('## Feature checks'));
    assert.ok(md.includes('### 🟢 FC — file categories — PASS'));
    assert.ok(md.includes('![settings](FC/settings.png)'));

    recordCase(r, { id: 'FC', title: 'file categories', status: 'fail', problems: ['category "tests" has 0 file read(s)'], evidence: [] });
    assert.equal(computeOverall(r), 'FAIL');
    md = renderIndexMd(r);
    const gallery = md.slice(md.indexOf('## Evidence'));
    assert.ok(gallery.includes('### 🔴 FC'));
    assert.ok(gallery.indexOf('What is wrong:') < gallery.indexOf('category "tests" has 0'));
    assert.ok(gallery.includes('No screenshot'));
    assert.ok(md.slice(md.indexOf('## Mismatches'), md.indexOf('## Stand')).includes('**FC**'));
  });
});

describe('mcpdb', () => {
  test('DATABASE_URL parsing, database swap and password masking', async () => {
    const { databaseUrlFromEnvText, withDatabase, maskUrl, mcpServerConfig } = await load('lib/mcpdb.mjs');
    const text = ['# comment', 'PORT=3000', 'DATABASE_URL="postgresql://postgres:secret@localhost:5432/a-log"', ''].join('\n');
    const url = databaseUrlFromEnvText(text);
    assert.equal(url, 'postgresql://postgres:secret@localhost:5432/a-log');
    assert.equal(databaseUrlFromEnvText('X=1'), null);
    const dbUrl = withDatabase(url, 'big_test_mcp');
    assert.equal(dbUrl, 'postgresql://postgres:secret@localhost:5432/big_test_mcp');
    assert.equal(maskUrl(dbUrl), 'postgresql://postgres:***@localhost:5432/big_test_mcp');
    assert.ok(!maskUrl(dbUrl).includes('secret'));
    const cfg = mcpServerConfig(dbUrl);
    assert.deepEqual(Object.keys(cfg.mcpServers), ['big-test-pg']);
    assert.equal(cfg.mcpServers['big-test-pg'].args.at(-1), dbUrl);
  });

  test('resolveAdminUrl prefers the env override, then server/.env, and explains a missing URL', async (t) => {
    const { resolveAdminUrl } = await load('lib/mcpdb.mjs');
    const root = tmpDir(t);
    assert.throws(() => resolveAdminUrl({ env: {}, repoRoot: root }), /BIG_TEST_MCP_PG_URL/);
    writeFile(path.join(root, 'server', '.env'), 'DATABASE_URL=postgresql://u:p@h:5432/db');
    assert.equal(resolveAdminUrl({ env: {}, repoRoot: root }).url, 'postgresql://u:p@h:5432/db');
    assert.equal(resolveAdminUrl({ env: { BIG_TEST_MCP_PG_URL: 'postgresql://o:q@h2/x' }, repoRoot: root }).url, 'postgresql://o:q@h2/x');
  });
});

describe('filecategories', () => {
  test('compareCategories and judgeFileStats', async () => {
    const { compareCategories, judgeFileStats } = await load('lib/filecategories.mjs');
    const { FC_CATEGORIES } = await load('lib/config.mjs');
    assert.deepEqual(compareCategories(FC_CATEGORIES.map((c) => ({ name: c.name, patterns: [...c.patterns] }))), []);
    assert.equal(compareCategories([{ name: 'code', patterns: ['.*'] }]).length, 1);
    assert.equal(compareCategories(undefined).length, 1);
    const exp = { sources: { files: 1, bytes: 10 }, tests: { files: 2, bytes: 5 } };
    assert.deepEqual(judgeFileStats({ sources: { files: 1, bytes: 10 }, tests: { files: 2, bytes: 5 } }, exp), []);
    const p = judgeFileStats({ sources: { files: 1, bytes: 10 } }, { sources: { files: 1, bytes: 10 } });
    assert.equal(p.length, 1);
    assert.ok(p[0].includes('"tests" has 0'));
    // Non-zero but wrong numbers fail now: bytes off, an unexpected extra category, no transcript.
    const off = judgeFileStats({ sources: { files: 1, bytes: 9 }, tests: { files: 2, bytes: 5 } }, exp);
    assert.deepEqual(off, ['category "sources" has 1 file(s) / 9 B, the transcript gives 1 / 10 B']);
    assert.equal(judgeFileStats({ ...exp, code: { files: 1, bytes: 3 } }, exp).length, 1);
    assert.match(judgeFileStats(exp, null).join(), /transcript could not be read/);
  });

  test('expectedFileStats mirrors the server rule (Read count, tool-result text length, root strip)', async () => {
    const { expectedFileStats, normaliseReadPath, classifyFile, toolResultBytes } = await load('lib/filecategories.mjs');
    const root = 'C:\\runs\\dotnet-api';
    assert.equal(normaliseReadPath('C:\\runs\\dotnet-api\\src\\Api\\Program.cs', [root]), 'src/Api/Program.cs');
    assert.equal(normaliseReadPath('c:/RUNS/dotnet-api/./tests//A.cs', [`${root}\\`]), 'tests/A.cs', 'case-insensitive, segments cleaned');
    assert.equal(normaliseReadPath('C:\\runs\\dotnet-apiX\\src\\a.cs', [root]), 'C:/runs/dotnet-apiX/src/a.cs', 'only on a / boundary');
    assert.equal(normaliseReadPath('/w/r/wt/src/a.cs', ['/w/r', '/w/r/wt']), 'src/a.cs', 'longest root wins');
    assert.equal(normaliseReadPath('/x/repo/tests/a.cs', []), 'tests/a.cs', 'no root → known top-level dir guess');
    assert.equal(classifyFile('src/a.cs'), 'sources');
    assert.equal(classifyFile('README.md'), 'code');
    assert.equal(classifyFile('x', [{ name: 'bad', patterns: ['('] }, { name: 'all', patterns: ['.'] }]), 'all');
    assert.equal(toolResultBytes('héllo'), 5, '.length, not UTF-8 bytes');
    assert.equal(toolResultBytes([{ type: 'text', text: 'ab' }, { type: 'image', source: {} }, { type: 'text', text: 'cde' }]), 5);
    assert.equal(toolResultBytes(null), 0);

    const read = (id, file) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } });
    const result = (id, content, extra = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });
    const program = '     1\tusing X;\n     2\tclass P {}\n';
    const transcript = jsonl([
      read('r1', `${root}\\src\\Api\\Program.cs`),
      result('r1', program),
      read('r2', `${root}\\tests\\Api.Tests\\HealthTests.cs`),
      result('r2', [{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }]),
      read('r3', `${root}\\src\\Api\\Program.cs`),
      result('r3', program),
      read('r4', `${root}\\src\\missing.cs`),
      result('r4', 'File does not exist.', { is_error: true }),
      read('r5', `${root}\\README.md`),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } },
      result('b1', 'lots of output'),
    ]);
    assert.deepEqual(expectedFileStats(transcript, [root]), {
      sources: { files: 3, bytes: program.length * 2 + 'File does not exist.'.length },
      tests: { files: 1, bytes: 5 },
      code: { files: 1, bytes: 0 },
    });
  });
});

describe('stand', () => {
  test('renderCompose uses the run image, 127.0.0.1 ports and no container_name', async () => {
    const { renderCompose } = await load('lib/stand.mjs');
    const yml = renderCompose('big-test-20261012-101010');
    assert.ok(yml.includes('image: artisyn-log-hub:big-test-20261012-101010'));
    assert.ok(yml.includes('127.0.0.1:3001:3000'));
    assert.ok(yml.includes('127.0.0.1:5433:5432'));
    assert.ok(!yml.includes('container_name'));
    assert.ok(!/\brestart:/.test(yml));
    assert.ok(renderCompose('artisyn-log-hub:big-test-x').includes('image: artisyn-log-hub:big-test-x'));
  });

  test('renderEnv sets AUTH_MODE=password and fresh non-empty secrets', async () => {
    const { renderEnv } = await load('lib/stand.mjs');
    const parse = (text) => Object.fromEntries(text.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const a = parse(renderEnv());
    const b = parse(renderEnv());
    assert.equal(a.AUTH_MODE, 'password');
    // production + AUTH_MODE=password refuses to boot without it
    assert.equal(a.PUBLIC_BASE_URL, 'http://localhost:3001');
    assert.ok(a.POSTGRES_PASSWORD.length > 0);
    assert.ok(a.SESSION_SECRET.length > 0);
    assert.notEqual(a.POSTGRES_PASSWORD, b.POSTGRES_PASSWORD);
    assert.notEqual(a.SESSION_SECRET, b.SESSION_SECRET);
  });
});

// ---- config / scenarios -----------------------------------------------------------------------

describe('config', () => {
  test('every USERS password passes the stand "long" policy', async () => {
    const { USERS } = await load('lib/config.mjs');
    // Re-stated from server/src/auth/utils/password-policy.ts (long policy).
    for (const [key, u] of Object.entries(USERS)) {
      const p = u.password;
      assert.ok(p.length >= 14 && p.length <= 128, `${key}: length`);
      assert.match(p, /\d/, `${key}: digit`);
      assert.match(p, /[A-Z]/, `${key}: upper`);
      assert.match(p, /[a-z]/, `${key}: lower`);
      assert.match(p, /[!-/:-@[-`{-~]/, `${key}: punctuation`);
    }
  });

  test('resolveRun puts the run-dir beside the git root and validates the stamp', async () => {
    const { resolveRun, releaseStamp, RELEASE_STAMP_RE } = await load('lib/config.mjs');
    const stamp = releaseStamp();
    assert.match(stamp, RELEASE_STAMP_RE);
    const root = path.resolve(os.tmpdir(), 'some-repo');
    const run = resolveRun(stamp, root);
    assert.equal(run.runDir, path.resolve(root, '..', `log_hub_big_test-${stamp}`));
    assert.equal(run.composeProject, `log-hub-big-test-${stamp}`);
    assert.equal(run.imageRef, `artisyn-log-hub:big-test-${stamp}`);
    assert.throws(() => resolveRun('bad-stamp', root), /stamp/);
  });

  test('loadModels reads the shipped models.json and rejects bad roles', async (t) => {
    const { loadModels, MODELS, VERIFIER_MODEL, MODELS_FILE } = await load('lib/config.mjs');
    assert.deepEqual({ ...loadModels(MODELS_FILE) }, { analysis: 'opus', verify: 'sonnet' });
    assert.equal(VERIFIER_MODEL, MODELS.verify);

    const dir = tmpDir(t);
    const missing = path.join(dir, 'missing.json');
    fs.writeFileSync(missing, JSON.stringify({ analysis: 'opus' }));
    assert.throws(() => loadModels(missing), /"verify"/);
    const nonString = path.join(dir, 'nonstring.json');
    fs.writeFileSync(nonString, JSON.stringify({ analysis: 42, verify: 'sonnet' }));
    assert.throws(() => loadModels(nonString), /"analysis"/);
  });
});

describe('scenarios', () => {
  test('S1–S11 cover sonnet/haiku/opus and subagent, skill, workflow, rule and MCP', async () => {
    const { SCENARIOS } = await load('scenarios.mjs');
    const { MCP_SERVER_NAME, FC_SCENARIO, FC_REPO } = await load('lib/config.mjs');
    assert.deepEqual(SCENARIOS.map((s) => s.id), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11']);
    const s7 = SCENARIOS.find((s) => s.id === 'S7');
    assert.deepEqual([...s7.mcp], [MCP_SERVER_NAME]);
    assert.deepEqual([...s7.requires.mcp], [MCP_SERVER_NAME]);
    assert.equal(FC_SCENARIO, 'S7');
    assert.equal(s7.repo, FC_REPO);
    assert.ok(SCENARIOS.filter((s) => s.id !== 'S7').every((s) => s.mcp.length === 0), 'only S7 starts an MCP server');
    assert.deepEqual([...new Set(SCENARIOS.map((s) => s.model))].sort(), ['haiku', 'opus', 'sonnet']);
    const reqs = SCENARIOS.map((s) => s.requires);
    assert.ok(reqs.some((r) => r.subagent >= 1), 'subagent');
    assert.ok(reqs.some((r) => r.skills && r.skills.length), 'skill');
    assert.ok(reqs.some((r) => r.workflows && r.workflows.length), 'workflow');
    assert.ok(reqs.some((r) => r.rules && r.rules.length), 'rule');
    assert.ok(reqs.some((r) => r.mcp && r.mcp.length), 'mcp');
  });

  test('L1 is kept outside SCENARIOS, on the legacy repo with its own owner and checks', async () => {
    const { SCENARIOS, LEGACY_SCENARIO, scenarioById } = await load('scenarios.mjs');
    const { LEGACY_OWNER, LEGACY_REPO, REPOS } = await load('lib/config.mjs');
    assert.ok(!SCENARIOS.some((s) => s.id === 'L1'));
    assert.equal(LEGACY_SCENARIO.id, 'L1');
    assert.equal(LEGACY_SCENARIO.repo, LEGACY_REPO);
    assert.ok(!(LEGACY_REPO in REPOS), 'the legacy repo is not one of REPOS');
    assert.equal(LEGACY_SCENARIO.owner, LEGACY_OWNER);
    assert.equal(LEGACY_SCENARIO.model, 'haiku');
    assert.deepEqual({ ...LEGACY_SCENARIO.requires }, { noHarness: true });
    assert.deepEqual([...LEGACY_SCENARIO.verifyChecks], ['model', 'prompt']);
    assert.equal(scenarioById('L1'), LEGACY_SCENARIO);
    assert.equal(scenarioById('S8').id, 'S8');
    assert.throws(() => scenarioById('S99'), /unknown scenario/);
  });

  test('every scenario carries the new fields with their defaults', async () => {
    const { SCENARIOS, LEGACY_SCENARIO, DEFAULT_VERIFY_CHECKS } = await load('scenarios.mjs');
    const { REPOS } = await load('lib/config.mjs');
    for (const s of [...SCENARIOS, LEGACY_SCENARIO]) {
      assert.ok(Object.isFrozen(s), `${s.id} frozen`);
      assert.ok(s.permissionArgs === null || Array.isArray(s.permissionArgs), `${s.id}.permissionArgs`);
      assert.equal(typeof s.cwdRel, 'string', `${s.id}.cwdRel`);
      assert.equal(typeof s.env, 'object', `${s.id}.env`);
      assert.equal(typeof s.useWorktree, 'boolean', `${s.id}.useWorktree`);
      assert.equal(typeof s.rootSettings, 'boolean', `${s.id}.rootSettings`);
      assert.equal(typeof s.expect, 'object', `${s.id}.expect`);
      assert.ok(s.verifyChecks.length > 0, `${s.id}.verifyChecks`);
      if (s.id !== 'L1') {
        assert.equal(s.owner, REPOS[s.repo], `${s.id}.owner`);
        assert.deepEqual([...s.verifyChecks.slice(0, 4)], [...DEFAULT_VERIFY_CHECKS], `${s.id} starts with the default checks`);
      }
    }
    const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
    const s3 = byId.S3;
    assert.equal(s3.permissionArgs, null);
    assert.equal(s3.cwdRel, '');
    assert.deepEqual({ ...s3.env }, {});
    assert.equal(s3.useWorktree, false);
    assert.equal(s3.rootSettings, false);
    assert.deepEqual([...s3.verifyChecks], [...DEFAULT_VERIFY_CHECKS]);

    assert.deepEqual([...byId.S1.verifyChecks.slice(4)], ['bashTab', 'contextGrowth']);
    assert.deepEqual({ ...byId.S1.requires }, { bash: 1, noHarness: true });
    assert.deepEqual(byId.S1.expect.bash.map((r) => ({ ...r })), [{ command: 'node --test tests/calc.test.js', status: 'ok', workDir: '.' }]);
    assert.deepEqual([...byId.S2.verifyChecks.slice(4)], ['systemContext']);
    assert.deepEqual([...byId.S5.verifyChecks.slice(4)], ['systemContext']);
    assert.deepEqual(byId.S5.expect.sysctx.rules, ['cli-flags']);
    assert.deepEqual([...byId.S4.verifyChecks.slice(4)], ['agentsTable']);
    assert.equal(byId.S4.expect.agents.count, 2);
  });

  test('S8–S11 fields: permission args, denied call, background agent, root-cwd Bash paths and worktree', async () => {
    const { SCENARIOS, S8_DENIED } = await load('scenarios.mjs');
    const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
    for (const id of ['S8', 'S9', 'S10', 'S11']) assert.equal(byId[id].model, 'haiku', `${id} model`);

    const s8 = byId.S8;
    assert.deepEqual({ ...S8_DENIED }, { tool: 'Write', target: 'denied.txt' });
    assert.equal(s8.repo, 'js-cli');
    assert.deepEqual([...s8.permissionArgs], ['--permission-mode', 'default', '--allowedTools', '"Read"', '"Bash(node:*)"']);
    assert.equal(s8.requires.bash, 2);
    assert.equal(s8.requires.bashError, true);
    assert.deepEqual([...s8.requires.denied], ['Write']);
    assert.deepEqual([...s8.verifyChecks.slice(4)], ['bashTab', 'denied']);
    assert.deepEqual(s8.expect.bash.map((r) => r.status), ['ok', 'error']);
    assert.ok(s8.expect.bash.every((r) => r.workDir === null));
    assert.deepEqual({ ...s8.expect.denied }, { tool: 'Write', target: 'denied.txt', status: 'rejected' });
    assert.ok(s8.prompt.includes('denied.txt'));

    const s9 = byId.S9;
    assert.equal(s9.repo, 'ts-webapp');
    assert.deepEqual({ ...s9.requires }, { background: true, subagent: 1 });
    assert.deepEqual([...s9.verifyChecks.slice(4)], ['workTime']);
    assert.match(s9.prompt, /run_in_background/);

    for (const id of ['S10', 'S11']) {
      const s = byId[id];
      assert.equal(s.repo, 'ts-webapp');
      assert.equal(s.cwdRel, '', `${id} starts at the project root (subdirectory cwd is out of scope)`);
      assert.equal(s.rootSettings, false);
      assert.deepEqual({ ...s.requires }, { bash: 1 });
      assert.deepEqual([...s.verifyChecks.slice(4)], ['bashPaths']);
      assert.deepEqual({ ...s.expect.bashPaths }, { read: 'packages/core/src/index.ts' });
    }
    assert.equal(byId.S10.useWorktree, false);
    assert.deepEqual({ ...byId.S10.env }, {});
    assert.equal(byId.S11.useWorktree, true);
    assert.deepEqual({ ...byId.S11.env }, { ARTISYN_PROJECT_ROOT: '{{REPO_ROOT}}' });
    assert.equal(SCENARIOS.filter((s) => s.useWorktree).length, 1, 'only S11 runs in the worktree');
    assert.equal(SCENARIOS.at(-1).id, 'S11', 'S11 stays the last session (ts-webapp sweep ordering)');
  });

  test('{{REPO_ROOT}} never appears within the first PROMPT_PREFIX_LEN characters and is always quoted', async () => {
    const { SCENARIOS, LEGACY_SCENARIO, REPO_ROOT_PLACEHOLDER } = await load('scenarios.mjs');
    const { PROMPT_PREFIX_LEN } = await load('lib/config.mjs');
    assert.equal(PROMPT_PREFIX_LEN, 40);
    const users = [];
    for (const s of [...SCENARIOS, LEGACY_SCENARIO]) {
      const at = s.prompt.indexOf(REPO_ROOT_PLACEHOLDER);
      if (at < 0) continue;
      users.push(s.id);
      assert.ok(at >= PROMPT_PREFIX_LEN, `${s.id}: placeholder at ${at}`);
      assert.ok(!s.prompt.slice(0, PROMPT_PREFIX_LEN).includes('{{'), `${s.id}: no partial placeholder in the prefix`);
      for (let i = s.prompt.indexOf(REPO_ROOT_PLACEHOLDER); i >= 0; i = s.prompt.indexOf(REPO_ROOT_PLACEHOLDER, i + 1)) {
        assert.equal(s.prompt[i - 1], '"', `${s.id}: placeholder quoted`);
      }
    }
    assert.deepEqual(users, ['S1', 'S10', 'S11']);
  });

  test('promptFor / envFor fill every {{REPO_ROOT}} with the forward-slash root', async () => {
    const { SCENARIOS, LEGACY_SCENARIO, promptFor, envFor } = await load('scenarios.mjs');
    const { PROMPT_PREFIX_LEN } = await load('lib/config.mjs');
    const { promptPrefix } = await load('lib/visibility.mjs');
    const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
    const winRoot = 'D:\\runs\\log_hub_big_test-x\\node-service';

    const s1 = promptFor(byId.S1, winRoot);
    assert.ok(s1.endsWith('cd "D:/runs/log_hub_big_test-x/node-service"; node --test tests/calc.test.js'), s1);
    assert.ok(!s1.includes('{{') && !s1.includes('\\'));
    assert.equal(promptPrefix(s1), promptPrefix(byId.S1.prompt), 'the filled prompt keeps the visibility prefix');
    assert.ok(promptPrefix(s1).length <= PROMPT_PREFIX_LEN);

    const s10 = promptFor(byId.S10, '/tmp/run/ts-webapp');
    assert.ok(s10.includes('cat "/tmp/run/ts-webapp/packages/core/src/index.ts"'), s10);

    const s11 = promptFor(byId.S11, 'D:\\runs\\ts-webapp-wt');
    assert.ok(s11.includes('cat "D:/runs/ts-webapp-wt/packages/core/src/index.ts"'), s11);
    assert.deepEqual(envFor(byId.S11, 'D:\\runs\\ts-webapp-wt'), { ARTISYN_PROJECT_ROOT: 'D:/runs/ts-webapp-wt' });
    assert.deepEqual(envFor(byId.S10, 'D:\\x'), {});

    // A prompt without the placeholder is returned unchanged and needs no root.
    assert.equal(promptFor(byId.S2, undefined), byId.S2.prompt);
    assert.equal(promptFor(LEGACY_SCENARIO, ''), LEGACY_SCENARIO.prompt);
    assert.throws(() => promptFor(byId.S1, ''), /needs a session root/);
    assert.throws(() => envFor(byId.S11, null), /needs a session root/);
  });
});

// ---- browser / verify -------------------------------------------------------------------------

describe('browser.parseOneLiner', () => {
  test('extracts --server-url and --api-key', async () => {
    const { parseOneLiner } = await load('lib/browser.mjs');
    const text =
      'Run this in your repo:\n' +
      'npx --yes "http://localhost:3001/static/artisyn-hooks-installer.tgz" install --server-url http://localhost:3001 --api-key "ak_123abc"\n';
    const r = parseOneLiner(text);
    assert.equal(r.serverUrl, 'http://localhost:3001');
    assert.equal(r.apiKey, 'ak_123abc');
    assert.ok(r.command.startsWith('npx '));
  });

  test('throws on a missing key', async () => {
    const { parseOneLiner } = await load('lib/browser.mjs');
    assert.throws(() => parseOneLiner('npx --yes x install --server-url http://localhost:3001'), /api-key/);
    assert.throws(() => parseOneLiner('npx --yes x install --server-url http://localhost:3001 --api-key'), /api-key/);
    assert.throws(() => parseOneLiner(''), /empty/);
  });
});

describe('verify', () => {
  function validVerdict() {
    const field = (name) => ({ status: 'pass', observed: 'ok', note: '', screenshot: `S1/${name}.png` });
    return {
      session: 'S1',
      overall: 'pass',
      fields: Object.fromEntries(['model', 'skills', 'rules', 'workflows', 'subagents', 'mcp', 'prompt', 'cost'].map((k) => [k, field(k)])),
    };
  }

  test('validateVerdict accepts a complete verdict', async () => {
    const { validateVerdict } = await load('lib/verify.mjs');
    assert.deepEqual(validateVerdict(validVerdict()), { ok: true, errors: [] });
  });

  test('validateVerdict rejects a missing field key or a bad status', async () => {
    const { validateVerdict } = await load('lib/verify.mjs');
    const missing = validVerdict();
    delete missing.fields.rules;
    const r1 = validateVerdict(missing);
    assert.equal(r1.ok, false);
    assert.ok(r1.errors.some((e) => e.includes('fields.rules')));

    const bad = validVerdict();
    bad.fields.model.status = 'ok';
    const r2 = validateVerdict(bad);
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => e.includes('fields.model.status')));

    const badOverall = validVerdict();
    badOverall.overall = 'maybe';
    assert.equal(validateVerdict(badOverall).ok, false);

    const noShot = validVerdict();
    noShot.fields.prompt.screenshot = null;
    assert.equal(validateVerdict(noShot).ok, false);

    const noMcp = validVerdict();
    delete noMcp.fields.mcp;
    const r3 = validateVerdict(noMcp);
    assert.equal(r3.ok, false);
    assert.ok(r3.errors.some((e) => e.includes('fields.mcp')));
  });

  test('the default checks yield the seven harness fields plus cost', async () => {
    const { fieldsFor, DEFAULT_CHECKS } = await load('lib/verify.mjs');
    assert.deepEqual(fieldsFor(DEFAULT_CHECKS), ['model', 'skills', 'rules', 'workflows', 'subagents', 'mcp', 'prompt', 'cost']);
  });

  test('fieldsFor / shotsFor / verifierCallBudget for S1, S4 and L1', async () => {
    const { fieldsFor, shotsFor, verifierCallBudget, CHECKS, DEFAULT_CHECKS } = await load('lib/verify.mjs');
    const { DEFAULT_VERIFY_CHECKS, SCENARIOS, LEGACY_SCENARIO } = await load('scenarios.mjs');
    const { VERIFIER_TOOL_BUDGET_BASE } = await load('lib/config.mjs');
    assert.deepEqual([...DEFAULT_VERIFY_CHECKS], [...DEFAULT_CHECKS]);
    const checks = (id) => [...(id === 'L1' ? LEGACY_SCENARIO : SCENARIOS.find((s) => s.id === id)).verifyChecks];
    const base = ['model', 'skills', 'rules', 'workflows', 'subagents', 'mcp', 'prompt', 'cost'];
    const baseShots = ['summary.png', 'harness-usage.png', 'logs.png', 'cost.png'];

    assert.deepEqual(fieldsFor(checks('S1')), [...base, 'bash', 'contextGrowth']);
    assert.deepEqual(shotsFor(checks('S1')), [...baseShots, 'bash.png', 'context-growth.png']);
    // 4 (login) + (3+8+3+4+5+5) calls + 6 shots + 2
    assert.equal(VERIFIER_TOOL_BUDGET_BASE, 4);
    assert.equal(verifierCallBudget(checks('S1')), 40);

    assert.deepEqual(fieldsFor(checks('S4')), [...base, 'agentsTable']);
    assert.deepEqual(shotsFor(checks('S4')), [...baseShots, 'agents-table.png', 'agent-modal.png']);
    // 4 + (3+8+3+4+6) + 6 + 2
    assert.equal(verifierCallBudget(checks('S4')), 36);

    assert.deepEqual(fieldsFor(checks('L1')), ['model', 'prompt']);
    assert.deepEqual(shotsFor(checks('L1')), ['summary.png', 'logs.png']);
    // 4 + (3+3) + 2 + 2
    assert.equal(verifierCallBudget(checks('L1')), 14);

    for (const id of Object.keys(CHECKS)) assert.equal(CHECKS[id].fragment, `checks/${id}.md`);
    assert.throws(() => fieldsFor(['model', 'nope']), /unknown verifier check "nope"/);
    assert.throws(() => shotsFor([]), /non-empty/);
  });

  test('validateVerdict with per-check keys and the skipped status', async () => {
    const { validateVerdict, fieldsFor, SKIPPABLE_FIELDS } = await load('lib/verify.mjs');
    assert.deepEqual([...SKIPPABLE_FIELDS], ['cost']);

    const skippedCost = validVerdict();
    skippedCost.fields.cost.status = 'skipped';
    assert.deepEqual(validateVerdict(skippedCost), { ok: true, errors: [] }, 'cost may be skipped, overall stays pass');

    const skippedModel = validVerdict();
    skippedModel.fields.model.status = 'skipped';
    const r1 = validateVerdict(skippedModel);
    assert.equal(r1.ok, false);
    assert.ok(r1.errors.some((e) => e.includes('fields.model.status must be pass|fail,')), r1.errors.join('; '));

    const skippedFail = validVerdict();
    skippedFail.fields.cost.status = 'skipped';
    skippedFail.overall = 'fail';
    assert.ok(validateVerdict(skippedFail).errors.includes('"overall" is fail but no field failed'));

    const s1Keys = fieldsFor(['model', 'harness', 'prompt', 'cost', 'bashTab', 'contextGrowth']);
    const s1 = validVerdict();
    assert.ok(validateVerdict(s1, s1Keys).errors.some((e) => e.includes('fields.bash is missing')));
    s1.fields.bash = { status: 'fail', observed: 'no row', note: '', screenshot: 'S1/bash.png' };
    s1.fields.contextGrowth = { status: 'pass', observed: '2 calls', note: '', screenshot: 'S1/context-growth.png' };
    s1.overall = 'fail';
    assert.deepEqual(validateVerdict(s1, s1Keys), { ok: true, errors: [] });

    const l1 = validVerdict();
    const r2 = validateVerdict(l1, ['model', 'prompt']);
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.includes('fields.cost is not expected for this scenario'));
    for (const k of ['skills', 'rules', 'workflows', 'subagents', 'mcp', 'cost']) delete l1.fields[k];
    assert.deepEqual(validateVerdict(l1, ['model', 'prompt']), { ok: true, errors: [] });
  });

  test('composeVerifyPrompt leaves no {{…}} placeholder for every scenario', async (t) => {
    const { composeVerifyPrompt, verifierCallBudget, shotVars, shotsFor, fieldsFor, expectedForChecks, sessionUrl } = await load('lib/verify.mjs');
    const { SCENARIOS, LEGACY_SCENARIO } = await load('scenarios.mjs');
    const shotDir = path.join(tmpDir(t), '_report', 'Sx');
    for (const s of [...SCENARIOS, LEGACY_SCENARIO]) {
      const checks = [...s.verifyChecks];
      const vars = {
        TOOL_BUDGET: verifierCallBudget(checks),
        SCENARIO_ID: s.id,
        STAND_URL: 'http://localhost:3001',
        EMAIL: 'u@example.test',
        PASSWORD: 'pw',
        SESSION_URL: sessionUrl(7, `sid-${s.id}`, 'http://localhost:3001'),
        EXPECTED_JSON: JSON.stringify(expectedForChecks(checks, { session_id: `sid-${s.id}`, model: s.model, ...s.expect }), null, 2),
        VERDICT_PATH: path.join(shotDir, 'verdict.json'),
        SHOT_DIR: shotDir,
        SHOT_REL: s.id,
        ...shotVars(checks, shotDir),
        SHOT_MISMATCH_EXAMPLE: path.join(shotDir, `${fieldsFor(checks)[0]}-mismatch.png`),
      };
      const out = composeVerifyPrompt(checks, vars);
      assert.ok(!/\{\{[^{}]*\}\}/.test(out), `${s.id}: placeholder left`);
      assert.ok(out.includes(String(vars.TOOL_BUDGET)), `${s.id}: budget`);
      for (const f of shotsFor(checks)) assert.ok(out.includes(path.join(shotDir, f)), `${s.id}: ${f}`);
      for (const k of fieldsFor(checks)) assert.ok(out.includes(`"${k}"`), `${s.id}: verdict field ${k}`);
      for (let n = 2; n <= checks.length + 1; n++) assert.match(out, new RegExp(`^${n}\\. `, 'm'), `${s.id}: step ${n}`);
    }
  });

  test('judgeCost table', async () => {
    const { judgeCost } = await load('lib/verify.mjs');
    const rows = [
      { text: 'Telemetry total $1.0000', cost: null, want: 'skipped' },
      { text: null, cost: 0.5, want: 'skipped' },
      { text: 'Telemetry total —', cost: 0.5, want: 'skipped' },
      { text: 'Telemetry total $1.0000', cost: 0.9501, want: 'pass' }, // Δ 0.0499 < 0.05
      { text: 'Telemetry total $1.0000', cost: 0.95, want: 'fail' }, // Δ 0.0500
      { text: 'Telemetry total $1.0000', cost: 1.0499, want: 'pass' },
      { text: 'Telemetry total $10.0000', cost: 9.9001, want: 'pass' }, // Δ 0.0999 < 1 % of 10
      { text: 'Telemetry total $10.0000', cost: 9.9, want: 'fail' }, // Δ 0.1000
      { text: 'Telemetry total $10.0000', cost: 10.1, want: 'fail' },
    ];
    for (const r of rows) {
      const j = judgeCost(r.text, r.cost);
      assert.equal(j.status, r.want, `${r.text} vs ${r.cost}: ${j.note}`);
    }
    assert.equal(judgeCost('Telemetry total $10.0000', 9.9001).telemetry, 10);
  });

  test('judgeWorkTime table', async () => {
    const { judgeWorkTime } = await load('lib/verify.mjs');
    assert.equal(judgeWorkTime('0:00:41', 41).status, 'pass');
    assert.equal(judgeWorkTime('0:00:41', 42).status, 'fail');
    assert.equal(judgeWorkTime('turn 1 · 0:01:05', 64).seconds, 65);
    assert.equal(judgeWorkTime('no duration', 1).status, 'fail');
    assert.equal(judgeWorkTime('0:00:41', null).status, 'fail');
  });

  test('collectStrayShots moves screenshots saved in the verifier cwd into the shot dir', async (t) => {
    const { collectStrayShots, clearStrayShots } = await load('lib/verify.mjs');
    const root = tmpDir(t);
    const verifyDir = path.join(root, '_verify');
    const shotDir = path.join(root, '_report', 'S1');
    writeFile(path.join(verifyDir, 'summary.png'), 'a');
    writeFile(path.join(verifyDir, 'logs.png'), 'new');
    writeFile(path.join(verifyDir, 'mcp-S1.json'), '{}');
    writeFile(path.join(shotDir, 'logs.png'), 'kept');
    assert.deepEqual(collectStrayShots(verifyDir, shotDir), ['summary.png']);
    assert.ok(fs.existsSync(path.join(shotDir, 'summary.png')));
    assert.equal(fs.readFileSync(path.join(shotDir, 'logs.png'), 'utf8'), 'kept');
    assert.deepEqual(fs.readdirSync(verifyDir), ['mcp-S1.json']);

    writeFile(path.join(verifyDir, 'old.png'), 'x');
    clearStrayShots(verifyDir);
    assert.deepEqual(fs.readdirSync(verifyDir), ['mcp-S1.json']);
  });

  test('the template fill leaves no {{…}} placeholders', async () => {
    const { fillTemplate, VERIFY_TEMPLATE_FILE } = await load('lib/verify.mjs');
    const tpl = fs.readFileSync(VERIFY_TEMPLATE_FILE, 'utf8');
    const keys = [...new Set([...tpl.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))];
    assert.ok(keys.length > 0);
    const vars = Object.fromEntries(keys.map((k) => [k, `value-of-${k}`]));
    const out = fillTemplate(tpl, vars);
    assert.ok(!/\{\{[^{}]*\}\}/.test(out));
    for (const k of keys) assert.ok(out.includes(`value-of-${k}`));
    assert.throws(() => fillTemplate(tpl, {}), /no value/);
  });
});

// ---- preflight / proc -------------------------------------------------------------------------

describe('preflight', () => {
  function freePort() {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
  }

  test('dockerfileBaseImages / mirrorImageRef / prePullBaseImages', async () => {
    const { dockerfileBaseImages, mirrorImageRef, prePullBaseImages } = await load('lib/preflight.mjs');
    const dockerfile = [
      'ARG BASE=node:20',
      'FROM node:22.23.4-slim AS client-build',
      'from --platform=linux/amd64 node:22.23.4-slim as hooks-build',
      'FROM client-build AS again',
      'FROM $BASE',
      'FROM scratch',
      'FROM ghcr.io/acme/tool:1 AS tool',
      '  FROM postgres:18.2-alpine',
      '# FROM ignored:1',
    ].join('\r\n');
    assert.deepEqual(dockerfileBaseImages(dockerfile), ['node:22.23.4-slim', 'ghcr.io/acme/tool:1', 'postgres:18.2-alpine']);
    const real = fs.readFileSync(path.resolve(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    assert.ok(dockerfileBaseImages(real).length >= 1, 'the repo Dockerfile has a base image');

    assert.equal(mirrorImageRef('node:22.23.4-slim'), 'public.ecr.aws/docker/library/node:22.23.4-slim');
    assert.equal(mirrorImageRef('postgres'), 'public.ecr.aws/docker/library/postgres:latest');
    for (const no of ['acme/tool:1', 'ghcr.io/acme/tool:1', 'node@sha256:abc', '', null]) assert.equal(mirrorImageRef(no), null, String(no));

    const calls = [];
    const runner = (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'image') return { status: args.at(-1) === 'node:1' ? 0 : 1 };
      if (args[0] === 'pull' && args.at(-1).includes('postgres')) throw new Error('docker pull exited with 1:\n429');
      return { status: 0 };
    };
    const res = prePullBaseImages(['node:1', 'alpine:3', 'postgres:18', 'acme/x:1'], { runner });
    assert.deepEqual(res.map((r) => r.action), ['present', 'pulled', 'failed', 'not mirrored']);
    assert.ok(calls.includes('pull --platform linux/amd64 public.ecr.aws/docker/library/alpine:3'));
    assert.ok(calls.includes('tag public.ecr.aws/docker/library/alpine:3 alpine:3'));
    assert.match(res[2].detail, /postgres:18: docker pull exited with 1: 429$/);
  });

  test('checkPortsFree passes on a free port', async () => {
    const { checkPortsFree } = await load('lib/preflight.mjs');
    const port = await freePort();
    await checkPortsFree([port]);
  });

  test('checkPortsFree throws the busy-port message when a local server holds the port', async (t) => {
    const { checkPortsFree } = await load('lib/preflight.mjs');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    await assert.rejects(checkPortsFree([port]), new RegExp(`port ${port} is busy — free it or stop the other stand; nothing was stopped`));
  });

  test('childEnv scrubs the parent session vars, keeps PATH and credentials, sets CLAUDE_CONFIG_DIR', async () => {
    const { childEnv } = await load('lib/preflight.mjs');
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      ARTISYN_HOOK_SERVICE: '1',
      ANTHROPIC_BASE_URL: 'http://proxy',
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
    };
    const env = childEnv({ claudeConfigDir: '/run/_claude-config' }, base);
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'ARTISYN_HOOK_SERVICE', 'ANTHROPIC_BASE_URL']) {
      assert.ok(!(k in env), `${k} removed`);
    }
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/x');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-test');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-test');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/run/_claude-config');

    const noCreds = childEnv({ claudeConfigDir: '/c' }, { PATH: '/p', CLAUDECODE: '1' });
    assert.ok(!('ANTHROPIC_API_KEY' in noCreds));
    assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in noCreds));
  });
});

describe('proc.runAsync', () => {
  test('a timed-out child resolves with timedOut and is killed', async () => {
    const { runAsync } = await load('lib/proc.mjs');
    const res = await runAsync(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 500 });
    assert.equal(res.timedOut, true);
    assert.ok(res.pid > 0);
    assert.equal(isAlive(res.pid), false);
  });

  test('input reaches the child stdin', async () => {
    const { runAsync } = await load('lib/proc.mjs');
    const res = await runAsync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'hello from stdin',
      timeoutMs: 20000,
    });
    assert.equal(res.timedOut, false);
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, 'hello from stdin');
  });
});

// ---- api.waitForIngestion ---------------------------------------------------------------------

describe('api.waitForIngestion', () => {
  async function stub(t, handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  test('keeps polling while subagents are short, resolves once they reach the expected count', async (t) => {
    const { createApiClient } = await load('lib/api.mjs');
    let logCalls = 0;
    let repoCalls = 0;
    const url = await stub(t, (req, res) => {
      if (req.url === '/api/v1/repositories') {
        repoCalls += 1;
        // The repo only appears on the second lookup.
        return send(res, 200, repoCalls < 2 ? [] : [{ id: 7, repoUrl: 'https://example.test/big-test/js-cli' }]);
      }
      if (req.url === '/api/v1/repositories/7/sessions/sid-1/logs') {
        logCalls += 1;
        if (logCalls === 1) return send(res, 404, { message: 'not found' });
        return send(res, 200, { main: [{}], subagents: Array.from({ length: logCalls - 1 }, () => ({})) });
      }
      return send(res, 404, {});
    });
    const api = createApiClient(url);
    const r = await api.waitForIngestion({
      storedUrl: 'https://example.test/big-test/js-cli',
      sid: 'sid-1',
      expectedSubagents: 2,
      pollMs: 20,
      timeoutMs: 5000,
    });
    assert.equal(r.rid, 7);
    assert.equal(r.logs.subagents.length, 2);
    assert.equal(logCalls, 3, 'polled past the 404 and the short subagent list');
  });

  test('rejects with "not ingested" at the timeout', async (t) => {
    const { createApiClient } = await load('lib/api.mjs');
    const url = await stub(t, (req, res) => send(res, 200, { main: [{}], subagents: [] }));
    const api = createApiClient(url);
    await assert.rejects(
      api.waitForIngestion({ rid: 3, sid: 'sid-2', expectedSubagents: 1, pollMs: 20, timeoutMs: 200 }),
      (err) => /^not ingested/.test(err.message) && err.code === 'NOT_INGESTED',
    );
  });
});

// ---- repos.createRepos ------------------------------------------------------------------------

describe('repos.createRepos', () => {
  test('creates committed git repos with origin, .claude/ mapped from dot-claude and no CLAUDE.md', async (t) => {
    const { createRepos, findClaudeMd } = await load('lib/repos.mjs');
    const { REMOTE_URL, REPO_NAMES } = await load('lib/config.mjs');
    const runDir = tmpDir(t);
    const runPaths = { runDir, repoDir: (repo) => path.join(runDir, repo) };
    const created = createRepos(runPaths);
    assert.deepEqual(created.map((r) => r.repo), [...REPO_NAMES]);

    const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    for (const repo of REPO_NAMES) {
      const dir = runPaths.repoDir(repo);
      assert.ok(fs.existsSync(path.join(dir, '.git')), `${repo}/.git`);
      assert.ok(fs.statSync(path.join(dir, '.claude')).isDirectory(), `${repo}/.claude`);
      assert.ok(!fs.existsSync(path.join(dir, 'dot-claude')), `${repo}: no dot-claude left`);
      assert.deepEqual(findClaudeMd(dir), [], `${repo}: no CLAUDE.md`);
      assert.equal(git(dir, ['remote', 'get-url', 'origin']), REMOTE_URL(repo));
      assert.equal(git(dir, ['rev-list', '--count', 'HEAD']), '1');
    }
    assert.ok(fs.existsSync(path.join(runDir, 'js-cli', '.claude', 'rules', 'cli-flags.md')));
    assert.ok(fs.existsSync(path.join(runDir, 'node-service', '.claude', 'skills', 'add-jsdoc', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(runDir, 'java-lib', '.claude', 'workflows', 'java-refactor.js')));
  });

  const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  test('beforeCommit writes the generated CLAUDE.md into the committed tree', async (t) => {
    const { createRepos, findClaudeMd } = await load('lib/repos.mjs');
    const { CLAUDE_MD_REPO, GENERATED_CLAUDE_MD } = await load('lib/config.mjs');
    const runDir = tmpDir(t);
    const runPaths = { runDir, repoDir: (repo) => path.join(runDir, repo) };
    const calls = [];
    createRepos(runPaths, {
      repos: [CLAUDE_MD_REPO, 'node-service'],
      beforeCommit: (repo, dir) => {
        calls.push(repo);
        if (repo === CLAUDE_MD_REPO) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), GENERATED_CLAUDE_MD);
      },
    });
    assert.deepEqual(calls, [CLAUDE_MD_REPO, 'node-service']);
    const dir = runPaths.repoDir(CLAUDE_MD_REPO);
    assert.deepEqual(findClaudeMd(dir), ['CLAUDE.md']);
    assert.equal(git(dir, ['rev-list', '--count', 'HEAD']), '1', 'in the fixture commit, not a second one');
    assert.equal(git(dir, ['show', 'HEAD:CLAUDE.md']).replace(/\r\n/g, '\n'), GENERATED_CLAUDE_MD.trimEnd());
    assert.equal(git(dir, ['status', '--porcelain']), '', 'nothing left uncommitted');
    assert.deepEqual(findClaudeMd(runPaths.repoDir('node-service')), []);
  });

  test('a fixture CLAUDE.md still throws, before beforeCommit runs', async (t) => {
    const { createRepos } = await load('lib/repos.mjs');
    const root = tmpDir(t);
    const fixturesDir = path.join(root, 'fixtures');
    writeFile(path.join(fixturesDir, 'js-cli', 'index.js'), 'console.log(1);\n');
    writeFile(path.join(fixturesDir, 'js-cli', 'lib', 'CLAUDE.md'), '# leaked\n');
    const runDir = path.join(root, 'run');
    const runPaths = { runDir, repoDir: (repo) => path.join(runDir, repo) };
    let called = false;
    assert.throws(
      () => createRepos(runPaths, { repos: ['js-cli'], fixturesDir, beforeCommit: () => { called = true; } }),
      /repo js-cli must not contain CLAUDE\.md, found: lib[\\/]CLAUDE\.md/,
    );
    assert.equal(called, false);
    assert.ok(!fs.existsSync(path.join(runDir, 'js-cli', '.git')), 'no commit made');
  });

  test('seedLegacyLogHub commits the pre-split log-hub.json as a second commit', async (t) => {
    const { createRepos, seedLegacyLogHub, LEGACY_LOG_HUB_COMMIT_MSG } = await load('lib/repos.mjs');
    const { LEGACY_LOG_HUB_JSON } = await load('lib/config.mjs');
    const runDir = tmpDir(t);
    const runPaths = { runDir, repoDir: (repo) => path.join(runDir, repo) };
    const [{ dir, head: first }] = createRepos(runPaths, { repos: ['java-lib'] });
    const head = seedLegacyLogHub(dir, LEGACY_LOG_HUB_JSON);
    assert.notEqual(head, first);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head);
    assert.equal(git(dir, ['rev-list', '--count', 'HEAD']), '2');
    assert.equal(git(dir, ['log', '-1', '--format=%s']), LEGACY_LOG_HUB_COMMIT_MSG);
    assert.equal(git(dir, ['diff', '--name-only', 'HEAD~1', 'HEAD']), '.artisyn/config/log-hub.json');
    assert.deepEqual(JSON.parse(git(dir, ['show', 'HEAD:.artisyn/config/log-hub.json'])), { ...LEGACY_LOG_HUB_JSON });
    assert.equal(git(dir, ['status', '--porcelain']), '');
  });
});

// ---- hooks ------------------------------------------------------------------------------------

describe('node-lts', () => {
  const schedule = {
    v18: { start: '2022-04-19', lts: '2022-10-25', maintenance: '2023-10-18', end: '2025-04-30' },
    v20: { start: '2023-04-18', lts: '2023-10-24', maintenance: '2024-10-22', end: '2026-04-30' },
    v22: { start: '2024-04-24', lts: '2024-10-29', maintenance: '2025-10-21', end: '2027-04-30' },
    v24: { start: '2025-05-06', lts: '2025-10-28', maintenance: '2026-10-20', end: '2028-04-30' },
    v25: { start: '2025-10-15', maintenance: '2026-04-01', end: '2026-06-01' },
    v26: { start: '2026-04-22', lts: '2026-10-28', maintenance: '2027-10-20', end: '2029-04-30' },
    v27: { start: '2026-10-20', maintenance: '2027-04-01', end: '2027-06-01' },
  };

  test('liveLtsLines keeps only even lines alive today that are or will become LTS', async () => {
    const { liveLtsLines } = await load('lib/node-lts.mjs');
    const lines = liveLtsLines(schedule, '2026-10-24');
    assert.deepEqual(lines.map((l) => l.major), ['22', '24', '26'], 'v18/v20 are EOL, v25/v27 are odd');
    assert.deepEqual(lines.map((l) => l.status), ['Maintenance LTS', 'Maintenance LTS', 'Current (LTS from 2026-10-28)']);
    assert.deepEqual(liveLtsLines(schedule, '2026-11-01').map((l) => l.status).at(-1), 'Active LTS');
    assert.deepEqual(liveLtsLines({}, '2026-10-24'), []);
  });

  test('nodeTags adds the engines floor and falls back when the schedule cannot be fetched', async () => {
    const { nodeTags, NODE_ENGINES_FLOOR, NODE_FALLBACK_MAJORS } = await load('lib/node-lts.mjs');
    const ok = await nodeTags({ today: '2026-10-24', fetchImpl: async () => ({ ok: true, json: async () => schedule }) });
    assert.deepEqual(ok.tags, [NODE_ENGINES_FLOOR, '22', '24', '26']);
    assert.equal(ok.scheduleError, null);
    const down = await nodeTags({ fetchImpl: async () => { throw new Error('offline'); } });
    assert.deepEqual(down.tags, [NODE_ENGINES_FLOOR, ...NODE_FALLBACK_MAJORS]);
    assert.equal(down.scheduleError, 'offline');
  });

  test('judgeNodeMatrix passes only when every row ran and every cell passed', async () => {
    const { judgeNodeMatrix } = await load('lib/node-lts.mjs');
    const good = (tag) => ({ tag, node: `v${tag}.0.0`, algo: { ok: true }, smoke: { cjs: { ok: true }, esm: { ok: true }, none: { ok: true } } });
    const pass = judgeNodeMatrix([good('22'), good('24')]);
    assert.equal(pass.ok, true);
    assert.equal(pass.cells, 8);

    const esmCrash = good('24');
    esmCrash.smoke.esm = { ok: false, steps: [{ event: 'SessionStart', script: 'lifecycle-hook.js', errors: ['exit 1: ReferenceError: require is not defined in ES module scope'] }] };
    const fail = judgeNodeMatrix([good('22'), esmCrash]);
    assert.equal(fail.ok, false);
    assert.match(fail.problems[0], /^24 \(v24\.0\.0\) smoke esm: SessionStart\/lifecycle-hook\.js: exit 1: ReferenceError/);

    assert.equal(judgeNodeMatrix([{ tag: '26', error: 'pull failed' }]).ok, false, 'an image that could not run fails');
    assert.equal(judgeNodeMatrix([{ ...good('22'), smoke: { cjs: { ok: true } } }]).ok, false, 'a missing cell fails');
    assert.equal(judgeNodeMatrix([]).ok, false, 'nothing tested fails');
  });
});

describe('hooks', () => {
  function configRepo(t, base, local) {
    const dir = tmpDir(t);
    if (base !== undefined) writeFile(path.join(dir, '.artisyn', 'config', 'log-hub.json'), JSON.stringify(base));
    if (local !== undefined) writeFile(path.join(dir, '.artisyn', 'config', 'log-hub.local.json'), JSON.stringify(local));
    return dir;
  }

  test('readLogHubConfig merges local over base; readServerUrl reads the merged value', async (t) => {
    const { readLogHubConfig, readServerUrl } = await load('lib/hooks.mjs');
    const dir = configRepo(t, { serverUrl: '', fileCategories: [] }, { serverUrl: 'http://localhost:3001', apiKey: 'k' });
    const cfg = readLogHubConfig(dir);
    assert.deepEqual(cfg.merged, { serverUrl: 'http://localhost:3001', fileCategories: [], apiKey: 'k' });
    assert.equal(readServerUrl(dir), 'http://localhost:3001');
    const empty = readLogHubConfig(tmpDir(t));
    assert.deepEqual(empty, { base: null, local: null, merged: {} });
    assert.equal(readServerUrl(configRepo(t, { serverUrl: 'http://old' })), 'http://old');
  });

  test('checkLocalConfig over the template, installed and legacy shapes', async (t) => {
    const { checkLocalConfig } = await load('lib/hooks.mjs');
    const { STAND_URL, LEGACY_LOG_HUB_JSON } = await load('lib/config.mjs');
    const local = { serverUrl: STAND_URL, otelReceiverPort: 4318, apiKey: 'ak_x' };

    // The tracked template alone (before install): no local file yet.
    const template = checkLocalConfig(configRepo(t, { serverUrl: '' }));
    assert.equal(template.ok, false);
    assert.ok(template.problems.some((p) => p.includes('missing or unreadable')), template.problems.join('; '));

    // Installed by the current installer: per-machine values only in the local file.
    const installed = configRepo(t, { serverUrl: '' }, local);
    assert.deepEqual(checkLocalConfig(installed).problems, []);
    assert.equal(checkLocalConfig(installed).ok, true);
    assert.equal(checkLocalConfig(configRepo(t, {}, local)).ok, true, 'base without serverUrl');
    const wrongUrl = checkLocalConfig(configRepo(t, { serverUrl: '' }, { ...local, serverUrl: 'http://elsewhere' }));
    assert.equal(wrongUrl.ok, false);
    const noPort = checkLocalConfig(configRepo(t, { serverUrl: '' }, { ...local, otelReceiverPort: '4318' }));
    assert.ok(noPort.problems.some((p) => p.includes('otelReceiverPort')));

    // Legacy (FR-12): the committed pre-split serverUrl stays, the port must have moved out.
    const upgraded = configRepo(t, { serverUrl: STAND_URL }, local);
    assert.equal(checkLocalConfig(upgraded, { legacy: true }).ok, true);
    const notLegacy = checkLocalConfig(upgraded);
    assert.equal(notLegacy.ok, false);
    assert.ok(notLegacy.problems.some((p) => p.includes('has serverUrl')));
    const portLeft = checkLocalConfig(configRepo(t, { ...LEGACY_LOG_HUB_JSON }, local), { legacy: true });
    assert.equal(portLeft.ok, false);
    assert.ok(portLeft.problems.some((p) => p.includes('has otelReceiverPort 4318')));

    // The 1.0.69 installer shape (serverUrl + port in base, only apiKey local) never passes.
    const old = checkLocalConfig(configRepo(t, { serverUrl: STAND_URL, otelReceiverPort: 4318 }, { apiKey: 'k' }), { legacy: true });
    assert.equal(old.ok, false);
    assert.equal(old.problems.length, 3);
  });
});

// ---- visibility -------------------------------------------------------------------------------

describe('visibility', () => {
  test('V8: the admin sees no test repo and opens another owner session directly', async () => {
    const { VISIBILITY_ROWS, judgePersonal } = await load('lib/visibility.mjs');
    const { REPO_NAMES, LEGACY_REPO, STORED_URL } = await load('lib/config.mjs');
    assert.deepEqual(VISIBILITY_ROWS.map((r) => r.id), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8']);
    const v8 = VISIBILITY_ROWS.find((r) => r.id === 'V8');
    assert.equal(v8.viewer, 'admin');
    assert.equal(v8.view, 'personal');
    assert.deepEqual([...v8.directSession], ['S1', 'S5', 'S6', 'S3']);
    const { SCENARIOS } = await load('scenarios.mjs');
    const { REPOS } = await load('lib/config.mjs');
    const owners = v8.directSession.map((sid) => REPOS[SCENARIOS.find((x) => x.id === sid).repo]);
    assert.deepEqual([...new Set(owners)].sort(), ['U1', 'U2', 'U3'], 'candidates span every owner');
    assert.deepEqual(v8.see, []);
    assert.deepEqual([...v8.notSee].sort(), [...REPO_NAMES, LEGACY_REPO].sort());

    const clean = judgePersonal(v8, ['https://example.test/other-repo']);
    assert.equal(clean.status, 'pass', clean.detail);
    assert.match(clean.detail, /no test repo/);
    assert.equal(judgePersonal(v8, []).status, 'pass');
    const leaked = judgePersonal(v8, [STORED_URL('node-service'), STORED_URL(LEGACY_REPO)]);
    assert.equal(leaked.status, 'fail');
    assert.deepEqual(leaked.leaked, ['node-service', LEGACY_REPO]);
    assert.deepEqual(leaked.missing, []);
  });

  test('S8 and legacy-hook are in the V rows', async () => {
    const { VISIBILITY_ROWS } = await load('lib/visibility.mjs');
    const { LEGACY_REPO } = await load('lib/config.mjs');
    const row = (id) => VISIBILITY_ROWS.find((r) => r.id === id);
    for (const id of ['V4', 'V7']) {
      assert.ok(row(id).see.includes('S8'), `${id} sees S8`);
      assert.ok(row(id).prompts.includes('S8'), `${id} prompt S8`);
    }
    assert.ok(row('V3').see.includes(LEGACY_REPO));
    assert.ok(row('V1').notSee.includes(LEGACY_REPO));
    assert.ok(row('V2').notSee.includes(LEGACY_REPO));
  });

  test('blockedBy / withBlockedBy explain a failed row whose every expected item was not ingested', async () => {
    const { VISIBILITY_ROWS, blockedBy, indexSessions, withBlockedBy } = await load('lib/visibility.mjs');
    const row = (id) => VISIBILITY_ROWS.find((r) => r.id === id);
    const state = { repos: { 'js-cli': { repoId: 7 }, 'dotnet-api': { repoId: null }, 'node-service': { repoId: 3 } } };
    const idx = indexSessions([
      { id: 'S5', status: 'fail: not ingested', expected: { session_id: 'a' } },
      { id: 'S8', status: 'fail: not ingested', expected: { session_id: 'b' } },
      { id: 'S6', status: 'pass', expected: { session_id: 'c' } },
    ]);
    assert.deepEqual(blockedBy(row('V4'), state, idx), ['S5', 'S8']);
    assert.deepEqual(blockedBy(row('V6'), state, idx), ['S6', 'S7'], 'dotnet-api has no repo id');
    assert.equal(blockedBy(row('V5'), state, idx), null, 'nothing to see → never blocked');
    const partial = indexSessions([{ id: 'S5', status: 'fail: not ingested' }, { id: 'S8', status: 'pass' }]);
    assert.equal(blockedBy(row('V4'), state, partial), null);
    assert.equal(blockedBy(row('V1'), state, idx), null, 'ts-webapp / java-lib unknown, node-service has an id');
    assert.deepEqual(blockedBy(row('V3'), { repos: {} }, idx), ['dotnet-api', 'legacy-hook']);

    assert.equal(withBlockedBy('S5 session a is not in the session list', 'fail', ['S5', 'S8']),
      'blocked by S5, S8 (not ingested) — S5 session a is not in the session list');
    assert.equal(withBlockedBy('ok', 'pass', ['S5']), 'ok');
    assert.equal(withBlockedBy('x', 'fail', null), 'x');
  });

  test('ownerVisibilityCheck covers legacy-hook through V3', async () => {
    const { ownerVisibilityCheck } = await load('lib/visibility.mjs');
    const { LEGACY_REPO } = await load('lib/config.mjs');
    const pass = (id) => ({ id, status: 'pass', missing: [], detail: '' });
    assert.equal(ownerVisibilityCheck([pass('V1'), pass('V2'), pass('V3')]).status, 'pass');

    const v3 = { id: 'V3', status: 'fail', missing: [LEGACY_REPO], detail: 'not shown: legacy-hook' };
    const r = ownerVisibilityCheck([pass('V1'), pass('V2'), v3]);
    assert.equal(r.status, 'fail');
    assert.equal(r.detail, `U3 does not see own ${LEGACY_REPO}`);

    const missingRow = ownerVisibilityCheck([pass('V1'), pass('V2')]);
    assert.equal(missingRow.detail, 'V3 not evaluated');
  });
});
