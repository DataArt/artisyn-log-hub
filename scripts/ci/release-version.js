#!/usr/bin/env node
'use strict';

// Version and run state of one release run (FR-4) for the `plan` job of
// .github/workflows/release.yml. Algorithm and examples:
// docs/knowledgebase/algorithms/release-version.md.
//
// The root package.json `version` names the release line X.Y; its PATCH field is
// ignored. The released version is computed from the strict git tags:
// vX.Y.(highest PATCH on the line + 1), or vX.Y.0 when the line has no tags yet.
//
// planRun, evaluated in this order:
//   1. package.json version is not X.Y.Z               -> fail
//   2. a strict tag at HEAD whose release is published  -> fail (nothing to release)
//   3. a strict tag at HEAD (release none or draft)     -> resume with that tag (highest if several)
//   4. line X.Y lower than the line of the highest tag  -> fail (no going back)
//   5. computed tag already exists on another commit    -> fail (never overwrite)
//   6. otherwise                                        -> full
// previousTag is the highest strict tag lower than the version, or ''.
// Non-strict v* tags (v1.2, v1.2.3-rc1, v01.2.3) are ignored everywhere.
//
// Modes:
//   GH_TOKEN=... node scripts/ci/release-version.js
//     Reads the root package.json, `git for-each-ref refs/tags` (peeled commit for
//     annotated tags), `git rev-parse HEAD` and, for a strict tag at HEAD,
//     `gh release view <tag> --json isDraft` (non-zero exit = no release).
//     Writes mode, version, tag, line, previous_tag to $GITHUB_OUTPUT (stdout when unset).
//
//   require('scripts/ci/release-version.js') exports the pure functions
//   parseLine, nextVersion, planRun plus the constants.
//
// Exit codes: 0 for mode full / resume, 1 for mode fail (prints ::error::<reason>)
// or an I/O error.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const IMAGE = 'ghcr.io/dataart/artisyn-log-hub';
const RELEASES_URL = 'https://github.com/DataArt/artisyn-log-hub/releases';
const STRICT_TAG_RE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const LINE_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const repoRoot = path.resolve(__dirname, '..', '..');

// ------------------------------------------------------------ pure part ----

/**
 * Release line from the root package.json version: `{ major, minor, line: 'X.Y' }`,
 * or null when the value is not X.Y.Z.
 */
function parseLine(version) {
  if (typeof version !== 'string' || !LINE_RE.test(version)) return null;
  const [major, minor] = version.split('.').map((n) => Number.parseInt(n, 10));
  return { major, minor, line: `${major}.${minor}` };
}

/** `[major, minor, patch]` of a strict tag name, or null for anything else. */
function parseTag(name) {
  const m = STRICT_TAG_RE.exec(String(name));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareParts(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Strict tags only, with their parsed parts, sorted ascending by semver. */
function strictTags(tags) {
  return (tags || [])
    .map((t) => ({ name: t.name, commit: t.commit, parts: parseTag(t.name) }))
    .filter((t) => t.parts !== null)
    .sort((a, b) => compareParts(a.parts, b.parts));
}

/**
 * Next version on the line `{major, minor}`: X.Y.(max PATCH of the strict tags on
 * that line + 1), or X.Y.0 when the line has no strict tags. Returns 'X.Y.Z'.
 */
function nextVersion(line, tags) {
  const onLine = strictTags(tags)
    .filter((t) => t.parts[0] === line.major && t.parts[1] === line.minor);
  const patch = onLine.length === 0 ? 0 : onLine[onLine.length - 1].parts[2] + 1;
  return `${line.major}.${line.minor}.${patch}`;
}

function previousTagOf(version, tags) {
  const parts = version.split('.').map(Number);
  const lower = strictTags(tags).filter((t) => compareParts(t.parts, parts) < 0);
  return lower.length === 0 ? '' : lower[lower.length - 1].name;
}

function failResult(reason) {
  return { mode: 'fail', version: '', tag: '', line: '', previousTag: '', reason };
}

/**
 * Run state of one release run (Design Decision 5).
 *   packageVersion  root package.json `version`
 *   tags            [{name, commit}] — commit is the peeled commit of the tag
 *   head            commit SHA of HEAD
 *   releases        {<tag>: 'none' | 'draft' | 'published'}; a missing tag is 'none'
 * Returns { mode: 'full' | 'resume' | 'fail', version, tag, line, previousTag, reason }.
 */
function planRun({ packageVersion, tags, head, releases }) {
  const line = parseLine(packageVersion);
  if (!line) {
    return failResult(`root package.json version must be X.Y.Z, got "${packageVersion}"`);
  }
  const strict = strictTags(tags);
  const states = releases || {};

  const atHead = strict.filter((t) => t.commit === head);
  if (atHead.length > 0) {
    const tag = atHead[atHead.length - 1];
    const version = tag.parts.join('.');
    const state = states[tag.name] || 'none';
    if (state === 'published') {
      return failResult(`nothing to release: ${tag.name} is already published`);
    }
    return {
      mode: 'resume',
      version,
      tag: tag.name,
      line: `${tag.parts[0]}.${tag.parts[1]}`,
      previousTag: previousTagOf(version, tags),
      reason: `${tag.name} points at HEAD, release is ${state}`,
    };
  }

  if (strict.length > 0) {
    const highest = strict[strict.length - 1];
    const lineParts = [line.major, line.minor, 0];
    const highestLine = [highest.parts[0], highest.parts[1], 0];
    if (compareParts(lineParts, highestLine) < 0) {
      return failResult(`version line ${line.line} is lower than ${highest.name} — no going back`);
    }
  }

  const version = nextVersion(line, tags);
  const tag = `v${version}`;
  const existing = strict.find((t) => t.name === tag);
  if (existing) {
    return failResult(`${tag} already exists on commit ${existing.commit} — not overwriting`);
  }
  return {
    mode: 'full',
    version,
    tag,
    line: line.line,
    previousTag: previousTagOf(version, tags),
    reason: `new release ${tag} on line ${line.line}`,
  };
}

// ----------------------------------------------------------------- I/O ----

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/** `<name> <objectname> <*objectname>` lines -> [{name, commit}], peeled commit when present. */
function readTags() {
  const out = git(['for-each-ref', 'refs/tags', '--format=%(refname:short) %(objectname) %(*objectname)']);
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, object, peeled] = line.trim().split(/\s+/);
    return { name, commit: peeled || object };
  });
}

/** 'none' | 'draft' | 'published' of the GitHub release for `tag`. */
function releaseState(tag) {
  const res = spawnSync('gh', ['release', 'view', tag, '--json', 'isDraft'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) return 'none';
  const json = JSON.parse(String(res.stdout));
  return json.isDraft ? 'draft' : 'published';
}

function writeOutputs(result) {
  const lines = [
    `mode=${result.mode}`,
    `version=${result.version}`,
    `tag=${result.tag}`,
    `line=${result.line}`,
    `previous_tag=${result.previousTag}`,
  ].join('\n');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`, 'utf8');
  } else {
    process.stdout.write(`${lines}\n`);
  }
}

function main() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const tags = readTags();
    const head = git(['rev-parse', 'HEAD']);
    const releases = {};
    for (const t of tags) {
      if (t.commit === head && parseTag(t.name)) releases[t.name] = releaseState(t.name);
    }
    const result = planRun({ packageVersion: pkg.version, tags, head, releases });
    process.stdout.write(`release-version: ${result.mode} — ${result.reason}\n`);
    if (result.mode === 'fail') {
      process.stdout.write(`::error::${result.reason}\n`);
      process.exit(1);
    }
    writeOutputs(result);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`release-version: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  IMAGE,
  RELEASES_URL,
  STRICT_TAG_RE,
  LINE_RE,
  parseLine,
  nextVersion,
  planRun,
};

if (require.main === module) main();
