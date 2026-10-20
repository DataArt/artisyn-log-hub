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

    assert.equal(isExercised(req.S1, none), true);
    assert.equal(isExercised(req.S1, { ...none, mcp: ['big-test-pg'] }), false, 'S1 with a stray MCP call');
    const s7Reads = ['D:/x/node-service/src/calc.js', 'D:/x/node-service/tests/calc.test.js'];
    assert.equal(isExercised(req.S7, { ...none, mcp: ['big-test-pg'], reads: s7Reads }), true);
    assert.equal(isExercised(req.S7, { ...none, reads: s7Reads }), false, 'S7 without the MCP call');
    assert.equal(isExercised(req.S7, { ...none, mcp: ['big-test-pg'], reads: [s7Reads[0]] }), false, 'S7 missing a read');
    assert.equal(
      isExercised(req.S7, { ...none, mcp: ['big-test-pg'], reads: ['D:/x/node-service/xsrc/calc.js', s7Reads[1]] }),
      false,
      'segment boundary',
    );
    assert.equal(isExercised(req.S1, { ...none, subagents: 1 }), false, 'S1 with stray subagents');
    assert.equal(isExercised(req.S1, { ...none, skills: ['x'] }), false);

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
    assert.deepEqual(judgeFileStats({ sources: { files: 1, bytes: 10 }, tests: { files: 2, bytes: 5 } }), []);
    const p = judgeFileStats({ sources: { files: 1, bytes: 10 } });
    assert.equal(p.length, 1);
    assert.ok(p[0].includes('"tests" has 0'));
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
  test('seven entries cover sonnet/haiku/opus and subagent, skill, workflow, rule and MCP', async () => {
    const { SCENARIOS } = await load('scenarios.mjs');
    const { MCP_SERVER_NAME, FC_SCENARIO, FC_REPO } = await load('lib/config.mjs');
    assert.equal(SCENARIOS.length, 7);
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
      fields: Object.fromEntries(['model', 'skills', 'rules', 'workflows', 'subagents', 'mcp', 'prompt'].map((k) => [k, field(k)])),
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

  test('VERDICT_FIELDS has seven fields including mcp', async () => {
    const { VERDICT_FIELDS } = await load('lib/verify.mjs');
    assert.deepEqual([...VERDICT_FIELDS], ['model', 'skills', 'rules', 'workflows', 'subagents', 'mcp', 'prompt']);
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
});
