#!/usr/bin/env node
// Reads `.claude/repo_config/project-env.json` -- once, with every default and
// every validation rule declared in one table.
//
// This module exists because the defaults are the part a model gets wrong. Today
// "granularReview defaults to false" is asserted in the repo_config README, in
// adlc-lh:review-deep's prose, and in a workflow's schema description; "the file
// count threshold is 20" exists only in adlc-lh:plan's prose. Every one of those is
// a rule some skill has to remember to apply. SCHEMA below is the single place
// they live, so a caller asking for a key gets the resolved value and has
// nothing left to decide.
//
// Two rules the API deliberately enforces:
//
//   1. A key not in SCHEMA is an error, not an empty value. A typo like
//      "appURL" would otherwise read as "not configured" forever.
//   2. Path PARTS (paths.tasksRoot and friends) are marked internal and cannot
//      be fetched at all. Callers get finished paths from taskPaths(), because a
//      caller holding `tasksRoot` will eventually join `/todo/` onto it, and that
//      is the bug this whole layer exists to prevent.
//
// Consumed by scripts/adlc-task.js (task doc paths) and, once dynamic context
// injection lands, by the per-skill config digests.
const fs = require('fs');
const path = require('path');

const CONFIG_DIR_RELATIVE_PATH = ['.claude', 'repo_config'];
const CONFIG_RELATIVE_PATH = [...CONFIG_DIR_RELATIVE_PATH, 'project-env.json'];

// type: string | boolean | number | relpath (a path relative to the repo root).
// internal: not reachable through get() -- only through a derived view.
const SCHEMA = {
  appUrl: { type: 'string', default: null },
  tmpDir: { type: 'string', default: null },
  credentialsNote: { type: 'string', default: null },
  kbIndexPath: { type: 'string', default: null },
  taskDetailsSkill: { type: 'string', default: null },
  granularReview: { type: 'boolean', default: false },
  preImplHealthCheck: { type: 'boolean', default: false },
  'simpleTrack.fileCountWarnThreshold': { type: 'number', default: 20 },
  'paths.tasksRoot': { type: 'relpath', default: 'docs/tasks', internal: true },
  'paths.todoDir': { type: 'relpath', default: null, internal: true },
  'paths.doneDir': { type: 'relpath', default: null, internal: true },
  'paths.todoIndex': { type: 'relpath', default: null, internal: true },
  'paths.doneIndex': { type: 'relpath', default: null, internal: true },
  'paths.requirementsFile': { type: 'relpath', default: 'requirements.md', internal: true },
  'paths.implPlanFile': { type: 'relpath', default: 'impl-plan.md', internal: true },
};

const INDEX_FILE = 'index.md';

// An unsubstituted "${...}" placeholder reaching us as a literal must not be
// treated as a real value -- it would silently resolve to nothing.
function clean(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.includes('${')) return '';
  return trimmed;
}

function readAt(source, dottedName) {
  return dottedName.split('.').reduce(
    (node, part) => (node && typeof node === 'object' ? node[part] : undefined),
    source,
  );
}

// A path from config is joined into shell commands and file writes, so a value
// that climbs out of the project (or names an absolute location) is rejected
// rather than normalized into something that merely looks contained.
function asRelativePath(raw, dottedName) {
  const posix = String(raw).replace(/\\/g, '/').replace(/\/+$/, '');
  if (path.posix.isAbsolute(posix) || /^[A-Za-z]:/.test(posix)) {
    throw new Error(`${dottedName} must be relative to the project root, got "${raw}"`);
  }
  if (posix.split('/').includes('..')) {
    throw new Error(`${dottedName} must not contain "..", got "${raw}"`);
  }
  return posix;
}

// Wrong-typed values warn and fall back, rather than throwing: a stray
// `"granularReview": "yes"` should not stop a task skill at step 1. A bad
// relpath is the exception -- there the project named a specific location, and
// quietly writing somewhere else is worse than stopping.
function coerce(value, dottedName, spec, warn) {
  if (spec.type === 'relpath') return asRelativePath(value, dottedName);
  if (spec.type === 'string') return clean(value) || spec.default;
  if (spec.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    warn(`${dottedName} should be true or false, got ${JSON.stringify(value)} -- using ${spec.default}`);
    return spec.default;
  }
  if (spec.type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    warn(`${dottedName} should be a number, got ${JSON.stringify(value)} -- using ${spec.default}`);
    return spec.default;
  }
  throw new Error(`SCHEMA bug: unknown type "${spec.type}" for ${dottedName}`);
}

// Keys the file sets that SCHEMA has never heard of. Reported so a typo surfaces
// as a warning the user can act on instead of as a value that is silently absent.
function findUnknownKeys(raw) {
  const known = new Set(Object.keys(SCHEMA));
  const containers = new Set(
    Object.keys(SCHEMA).filter((k) => k.includes('.')).map((k) => k.split('.')[0]),
  );
  const unknown = [];
  for (const [key, value] of Object.entries(raw)) {
    if (containers.has(key)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const nested of Object.keys(value)) {
          if (!known.has(`${key}.${nested}`)) unknown.push(`${key}.${nested}`);
        }
      }
      continue;
    }
    if (!known.has(key)) unknown.push(key);
  }
  return unknown;
}

// Claude Code can be started in a subdirectory of the project -- it finds skills
// and CLAUDE.md by walking up, so a session in `apps/web` is normal. Every path
// this module produces is rooted somewhere, so getting that root wrong does not
// fail loudly: it reports the task as not-found, or resolves a path into
// `apps/web/docs/tasks/...`. So walk up from wherever we start.
//
// A directory carrying `.claude/repo_config` wins over the git root, and the
// nearest one wins, so a monorepo package that keeps its own task docs still
// gets them. Failing that, the git root is the project -- the same answer Claude
// Code itself resolves settings and auto memory to.
function findProjectRoot(candidate) {
  let dir = path.resolve(candidate);
  for (;;) {
    if (fs.existsSync(path.join(dir, ...CONFIG_DIR_RELATIVE_PATH))) return { root: dir, via: 'repo_config' };
    if (fs.existsSync(path.join(dir, '.git'))) return { root: dir, via: 'git-root' };
    const parent = path.dirname(dir);
    if (parent === dir) return { root: path.resolve(candidate), via: 'as-given' };
    dir = parent;
  }
}

function load(projectRootArg) {
  const fromArgument = clean(projectRootArg);
  const fromEnv = clean(process.env.CLAUDE_PROJECT_DIR);
  const candidate = fromArgument || fromEnv || process.cwd();
  const source = fromArgument ? 'argument' : fromEnv ? 'CLAUDE_PROJECT_DIR' : 'cwd';
  const found = findProjectRoot(candidate);
  const projectRoot = found.root;
  const configFile = path.join(projectRoot, ...CONFIG_RELATIVE_PATH);
  // Resolution is lazy, so the same key can be read more than once in a run --
  // and a caller should see each problem once, not once per read.
  const warnings = [];
  const warn = (message) => { if (!warnings.includes(message)) warnings.push(message); };
  let raw = {};
  let hasConfig = false;

  if (fs.existsSync(configFile)) {
    hasConfig = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
    } catch (err) {
      // A syntax error anywhere in this file would otherwise break every skill
      // that reads any key from it. Fall back to the declared defaults -- which
      // is what an absent file means anyway -- and say so loudly.
      warn(`could not parse ${configFile} (${err.message}) -- using declared defaults`);
    }
    for (const key of findUnknownKeys(raw)) {
      warn(`unknown key "${key}" in ${CONFIG_RELATIVE_PATH.join('/')} -- no skill reads it; check the spelling`);
    }
  }

  function resolve(dottedName) {
    const spec = SCHEMA[dottedName];
    if (!spec) throw new Error(`unknown config key "${dottedName}" -- add it to SCHEMA in repo-config.js`);
    const value = readAt(raw, dottedName);
    if (value === undefined || value === null) return spec.default;
    return coerce(value, dottedName, spec, warn);
  }

  function get(dottedName) {
    const spec = SCHEMA[dottedName];
    if (spec && spec.internal) {
      throw new Error(`${dottedName} is internal: build paths with taskPaths(), never from its parts`);
    }
    return resolve(dottedName);
  }

  // The derived view. Callers get whole paths and nothing they could join:
  // `tasksRoot` alone never leaves this function.
  function taskPaths() {
    const tasksRoot = resolve('paths.tasksRoot');
    const todoDir = resolve('paths.todoDir') || `${tasksRoot}/todo`;
    const doneDir = resolve('paths.doneDir') || `${tasksRoot}/done`;
    return {
      todoDir,
      doneDir,
      todoIndex: resolve('paths.todoIndex') || `${todoDir}/${INDEX_FILE}`,
      doneIndex: resolve('paths.doneIndex') || `${doneDir}/${INDEX_FILE}`,
      requirementsFile: resolve('paths.requirementsFile'),
      implPlanFile: resolve('paths.implPlanFile'),
    };
  }

  const posixRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');

  return {
    projectRoot: posixRoot,
    projectRootSource: source,
    projectRootVia: found.via,
    configFile,
    hasConfig,
    warnings,
    get,
    taskPaths,
    // Both take a path relative to the project root, so callers never join one
    // themselves. absolute() is what any consumer should print or hand to a
    // tool: a session started in a subdirectory resolves a relative path
    // against ITS directory, not the project's.
    exists: (relativePath) => fs.existsSync(path.join(projectRoot, relativePath)),
    absolute: (relativePath) => path.posix.join(posixRoot, relativePath.replace(/\\/g, '/')),
  };
}

module.exports = { load, clean, SCHEMA };
