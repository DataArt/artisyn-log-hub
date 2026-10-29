'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/harness-snapshot.md against the hook's catalog
 * scanner (`buildSkillCatalog`) and snapshot id (`computeSnapshotId` via `buildHarnessSnapshot`).
 *
 * Each row's `kind` ("catalog" | "compare" | "probe" | "git") picks which of four input shapes the
 * doc describes (see its "Examples" prose). This file only materialises the virtual file tree on
 * disk (for `git` rows also a `git init` repo, as in okf-snapshot.algo.test.js) and dispatches;
 * the doc is the only place the numbers live.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const { buildSkillCatalog } = require('../skill-catalog');
const { buildHarnessSnapshot, computeSnapshotId } = require('../harness-snapshot');

let dirCounter = 0;
function freshDir() {
  dirCounter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `hs-algo-${dirCounter}-`));
}

function writeFile(root, rel, content) {
  const filePath = path.join(root, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Materializes one `{tree, settings, installedPlugins, mtimeOverride}` spec (the doc's "Examples"
 * prose) on disk and returns `{project, env}`, ready for `buildSkillCatalog` / `buildHarnessSnapshot`.
 */
function prepareDir(spec) {
  const root = freshDir();
  const project = path.join(root, 'project');
  const userRoot = path.join(root, 'user');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });

  const pluginPathByKey = new Map();
  const resolvePluginKey = (key) => {
    if (!pluginPathByKey.has(key)) pluginPathByKey.set(key, path.join(root, 'plugin', key));
    return pluginPathByKey.get(key);
  };

  const writtenFiles = {};
  for (const [key, content] of Object.entries(spec.tree || {})) {
    let filePath;
    if (key.startsWith('user:')) {
      filePath = writeFile(userRoot, key.slice('user:'.length), content);
    } else {
      const pluginMatch = key.match(/^plugin:([^/]+)\/(.*)$/);
      if (pluginMatch) {
        filePath = writeFile(resolvePluginKey(pluginMatch[1]), pluginMatch[2], content);
      } else {
        filePath = writeFile(project, key, content);
      }
    }
    writtenFiles[key] = filePath;
  }

  for (const [key, epochMs] of Object.entries(spec.mtimeOverride || {})) {
    const d = new Date(epochMs);
    fs.utimesSync(writtenFiles[key], d, d);
  }

  if (spec.settings) {
    if (spec.settings.user) writeFile(userRoot, 'settings.json', JSON.stringify(spec.settings.user));
    if (spec.settings.project) writeFile(project, '.claude/settings.json', JSON.stringify(spec.settings.project));
    if (spec.settings.local) writeFile(project, '.claude/settings.local.json', JSON.stringify(spec.settings.local));
  }

  if (spec.installedPlugins) {
    const plugins = {};
    for (const [id, entries] of Object.entries(spec.installedPlugins)) {
      plugins[id] = entries.map((entry) => {
        const out = { scope: entry.scope };
        if (entry.projectPath === 'self') out.projectPath = project;
        else if (entry.projectPath === 'foreign') out.projectPath = path.join(root, 'foreign-project');
        else if (entry.projectPath !== undefined) out.projectPath = entry.projectPath;
        if (entry.installPath !== undefined) out.installPath = resolvePluginKey(entry.installPath);
        if (entry.version !== undefined) out.version = entry.version;
        if (entry.gitCommitSha !== undefined) out.gitCommitSha = entry.gitCommitSha;
        return out;
      });
    }
    writeFile(userRoot, 'plugins/installed_plugins.json', JSON.stringify({ plugins }));
  }

  return { root, project, env: { CLAUDE_CONFIG_DIR: userRoot } };
}

function buildSnapshotFor(spec) {
  const dirs = prepareDir(spec);
  return buildHarnessSnapshot({ projectRoot: dirs.project, cwd: dirs.project, env: dirs.env, log: () => {} });
}

function runCatalogRow(input, expected) {
  const dirs = prepareDir(input);
  const log = [];
  const catalog = buildSkillCatalog({
    projectRoot: dirs.project,
    cwd: dirs.project,
    env: dirs.env,
    log: (line) => log.push(line),
  });

  for (const want of expected.present || []) {
    const found = catalog.find((e) => e.name === want.name && e.kind === (want.kind || 'skill'));
    assert.ok(found, `expected present: ${JSON.stringify(want)}`);
    for (const key of Object.keys(want)) {
      assert.equal(found[key], want[key], `field "${key}" of ${want.name}`);
    }
  }
  for (const name of expected.absentNames || []) {
    assert.ok(!catalog.some((e) => e.name === name), `expected absent: ${name}`);
  }
  for (const name of expected.exactlyOne || []) {
    assert.equal(catalog.filter((e) => e.name === name).length, 1, `expected exactly one: ${name}`);
  }
  if (expected.logContains) {
    assert.ok(
      log.some((line) => line.includes(expected.logContains)),
      `expected log containing "${expected.logContains}", got ${JSON.stringify(log)}`,
    );
  }
}

function runCompareRow(input, expected) {
  const before = buildSnapshotFor(input.before);
  const after = buildSnapshotFor(input.after);
  assert.equal(before.snapshotId === after.snapshotId, expected.sameId);
}

function runProbeRow(input, expected) {
  const snapshot = buildSnapshotFor({ tree: input.tree });
  const idBefore = snapshot.snapshotId;
  const mutatedMcpServers = snapshot.mcpServers.map((server) =>
    server.name === input.probeServerName ? { ...server, ...input.probeFields } : server,
  );
  const idAfter = computeSnapshotId({
    skills: snapshot.skills,
    agents: snapshot.agents,
    mcpServers: mutatedMcpServers,
    systemContext: snapshot.systemContext,
  });
  assert.equal(idBefore === idAfter, expected.sameId);
}

/**
 * Runs `fn` with git isolated from the machine: no global/system config (so no personal
 * `core.excludesFile` marks a file ignored) and `GIT_CEILING_DIRECTORIES` at the temp root, so a
 * non-repo row stays "outside any git repository" even when the temp folder lives inside one.
 */
function withIsolatedGit(root, fn) {
  const keys = ['GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const emptyConfig = path.join(root, 'empty.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  process.env.GIT_CEILING_DIRECTORIES = root;
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/**
 * One `git`-kind spec `{tree, git?, gitAdd?, gitignore?}`: materialise, `git init` the project
 * (unless `git: false`), write `.gitignore`, `git add` the listed paths, build the snapshot.
 * @returns {{ statuses: Record<string, string|null>, snapshotId: string }}
 */
function runGitSpec(spec) {
  const dirs = prepareDir(spec);
  try {
    return withIsolatedGit(dirs.root, () => {
      const run = (args) => {
        const r = spawnSync('git', args, { cwd: dirs.project, env: process.env });
        assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
      };
      if (spec.git !== false) {
        run(['init', '-q']);
        if (spec.gitignore) writeFile(dirs.project, '.gitignore', spec.gitignore.join('\n') + '\n');
        if (spec.gitAdd && spec.gitAdd.length > 0) run(['add', '--', ...spec.gitAdd]);
      }
      const snapshot = buildHarnessSnapshot({
        projectRoot: dirs.project,
        cwd: dirs.project,
        env: dirs.env,
        log: () => {},
      });
      const statuses = {};
      const entries = [
        ...snapshot.skills,
        ...(snapshot.agents || []),
        ...(snapshot.systemContext ? snapshot.systemContext.files : []),
      ];
      for (const e of entries) statuses[e.path] = e.gitStatus === undefined ? null : e.gitStatus;
      return { statuses, snapshotId: snapshot.snapshotId };
    });
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
}

function runGitRow(input, expected) {
  if (input.before && input.after) {
    const before = runGitSpec(input.before);
    const after = runGitSpec(input.after);
    assert.equal(before.snapshotId === after.snapshotId, expected.sameId);
    return;
  }
  const result = runGitSpec(input);
  assert.deepEqual(result.statuses, expected.statuses);
  if (expected.snapshotId) assert.equal(result.snapshotId, expected.snapshotId);
}

for (const row of loadExamples('harness-snapshot')) {
  test(row.id, () => {
    if (row.kind === 'compare') {
      runCompareRow(row.input, row.expected);
    } else if (row.kind === 'probe') {
      runProbeRow(row.input, row.expected);
    } else if (row.kind === 'git') {
      runGitRow(row.input, row.expected);
    } else {
      runCatalogRow(row.input, row.expected);
    }
  });
}
