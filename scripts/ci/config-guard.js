#!/usr/bin/env node
'use strict';

// Executable-config guard (FR-4) for the security-scans CI workflow.
//
// Checks the repo files that make a developer's machine run code or talk to
// a server as soon as the repo is opened in Claude Code:
//   .artisyn/config/log-hub.json   serverUrl, model names, telemetryDir
//   .claude/settings.json          hooks, OTEL endpoints, marketplaces, plugins
//   .mcp.json                      MCP servers (stdio allowlist, local URLs)
// plus that .artisyn/config/log-hub.local.json is not tracked by git.
// The rules are Design Decision 24 of
// docs/tasks/todo/2026-10-23-ci-cd-scans/impl-plan.md; the stdio allowlist is
// .github/security/config-guard-allowlist.json.
//
// Modes:
//   require('scripts/ci/config-guard.js').checkConfigGuard({files, tracked, allowlist})
//     Pure function, returns { findings: [{ file, key, rule }] }.
//   node scripts/ci/config-guard.js --out <dir> [--link <url>]
//     Reads the guarded files from the repo root (a missing file is null),
//     `git ls-files` and the allowlist, prints one
//     `::warning file=<file>::<key> <rule>` line per finding and writes
//     <dir>/row-config-guard-repo.json (the unified scan row).
//
// Exit codes: 0 always after writing the row (report-only; findings and
// runtime failures become the row status), 1 only on a usage error.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ALLOWLIST_PATH = '.github/security/config-guard-allowlist.json';

const LOG_HUB = '.artisyn/config/log-hub.json';
const SETTINGS = '.claude/settings.json';
const MCP = '.mcp.json';
const LOCAL_CONFIG = '.artisyn/config/log-hub.local.json';
/** The files whose content is read and checked, in table order. */
const GUARDED_FILES = [LOG_HUB, SETTINGS, MCP];

const LOCAL_SERVER_URL = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/;
const MODEL_NAME = /^[A-Za-z0-9._:\-[\]]+$/;
const OTEL_ENDPOINT_KEY = /^OTEL_EXPORTER_OTLP_([A-Z]+_)?ENDPOINT$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const LOCAL_MARKETPLACE_PATH = './.artisyn/marketplace';
const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
const MODEL_KEYS = ['turnEndCostAdvisorModel', 'sessionAttributionLlmModel'];

const NOTE_MAX = 200;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Object entries of `obj[key]` when it is a plain object, otherwise []. */
function entriesOf(obj, key) {
  return isPlainObject(obj[key]) ? Object.entries(obj[key]) : [];
}

function isLocalUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return LOCAL_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isRelativeDir(value) {
  if (typeof value !== 'string') return false;
  if (/^[/\\~]/.test(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[/\\]/).includes('..');
}

function serverUrlOk(cfg) {
  if (!has(cfg, 'serverUrl')) return true;
  const v = cfg.serverUrl;
  return v === '' || (typeof v === 'string' && LOCAL_SERVER_URL.test(v));
}

function telemetryDirOk(cfg) {
  if (!has(cfg, 'telemetryDir')) return true;
  return cfg.telemetryDir === '' || isRelativeDir(cfg.telemetryDir);
}

function localMarketplaces(settings) {
  const names = new Set();
  for (const [name, entry] of entriesOf(settings, 'extraKnownMarketplaces')) {
    const src = isPlainObject(entry) ? entry.source : null;
    if (isPlainObject(src) && src.source === 'directory' && src.path === LOCAL_MARKETPLACE_PATH) {
      names.add(name);
    }
  }
  return names;
}

function stdioAllowed(server, allowlist) {
  const args = Array.isArray(server.args) ? server.args : [];
  const firstArg = args.find((a) => typeof a !== 'string' || !a.startsWith('-'));
  const entries = isPlainObject(allowlist) && Array.isArray(allowlist.mcpStdio) ? allowlist.mcpStdio : [];
  return entries.some((e) => isPlainObject(e)
    && Array.isArray(e.commands)
    && e.commands.includes(server.command)
    && firstArg === e.package);
}

/** Parses each guarded file; returns { parsed: {file: object|null}, invalid: [file] }. */
function parseFiles(files) {
  const parsed = {};
  const invalid = [];
  for (const file of GUARDED_FILES) {
    const content = files && has(files, file) ? files[file] : null;
    if (content === null || content === undefined) {
      parsed[file] = null;
      continue;
    }
    try {
      const value = JSON.parse(content);
      // A top-level value that is not an object cannot hold any config key.
      if (!isPlainObject(value)) throw new Error('not an object');
      parsed[file] = value;
    } catch {
      parsed[file] = null;
      invalid.push(file);
    }
  }
  return { parsed, invalid };
}

function normalizeTracked(tracked) {
  if (Array.isArray(tracked)) return tracked;
  if (typeof tracked === 'string') return tracked.split(/\r?\n/).filter(Boolean);
  return [];
}

/**
 * FR-4 rules (Design Decision 24). Findings are ordered by rule-table row,
 * then by key in file order. A missing file passes; a file that fails
 * `invalid-json` gets no other findings.
 */
function checkConfigGuard({ files, tracked, allowlist } = {}) {
  const findings = [];
  const add = (file, key, rule) => findings.push({ file, key, rule });
  const { parsed, invalid } = parseFiles(files);
  const cfg = parsed[LOG_HUB];
  const settings = parsed[SETTINGS];
  const mcp = parsed[MCP];

  if (cfg) {
    if (!serverUrlOk(cfg)) add(LOG_HUB, 'serverUrl', 'server-url-not-local');
    for (const key of Object.keys(cfg)) {
      if (MODEL_KEYS.includes(key) && !(typeof cfg[key] === 'string' && MODEL_NAME.test(cfg[key]))) {
        add(LOG_HUB, key, 'model-name-invalid');
      }
    }
    if (!telemetryDirOk(cfg)) add(LOG_HUB, 'telemetryDir', 'telemetry-dir-not-relative');
  }

  if (settings) {
    if (has(settings, 'hooks')) add(SETTINGS, 'hooks', 'hooks-present');
    for (const [name, value] of entriesOf(settings, 'env')) {
      if (OTEL_ENDPOINT_KEY.test(name) && !isLocalUrl(value)) {
        add(SETTINGS, `env.${name}`, 'otel-endpoint-not-local');
      }
    }
    const okMarketplaces = localMarketplaces(settings);
    for (const [name] of entriesOf(settings, 'extraKnownMarketplaces')) {
      if (!okMarketplaces.has(name)) add(SETTINGS, `extraKnownMarketplaces.${name}`, 'marketplace-not-local');
    }
    for (const [name] of entriesOf(settings, 'enabledPlugins')) {
      const at = name.lastIndexOf('@');
      const suffix = at < 0 ? null : name.slice(at + 1);
      if (suffix !== OFFICIAL_MARKETPLACE && !okMarketplaces.has(suffix)) {
        add(SETTINGS, `enabledPlugins.${name}`, 'plugin-marketplace-unknown');
      }
    }
  }

  if (mcp) {
    const servers = entriesOf(mcp, 'mcpServers');
    const withCommand = (s) => isPlainObject(s) && has(s, 'command');
    const withUrl = (s) => isPlainObject(s) && has(s, 'url');
    for (const [name, server] of servers) {
      if (withCommand(server) && !stdioAllowed(server, allowlist)) {
        add(MCP, `mcpServers.${name}`, 'mcp-command-not-allowed');
      }
    }
    for (const [name, server] of servers) {
      if (withUrl(server) && !withCommand(server) && !isLocalUrl(server.url)) {
        add(MCP, `mcpServers.${name}`, 'mcp-url-not-local');
      }
    }
    for (const [name, server] of servers) {
      if (!withCommand(server) && !withUrl(server)) add(MCP, `mcpServers.${name}`, 'mcp-server-invalid');
    }
  }

  if (normalizeTracked(tracked).includes(LOCAL_CONFIG)) add(LOCAL_CONFIG, '', 'local-config-tracked');

  for (const file of invalid) add(file, '', 'invalid-json');

  return { findings };
}

// ---------------------------------------------------------------- CLI ----

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--out' || a === '--link') && i + 1 < argv.length) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${a}`);
    }
  }
  if (!args.out) throw new Error('--out <dir> is required');
  return args;
}

function readOptional(rel) {
  const abs = path.join(ROOT, ...rel.split('/'));
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function truncateNote(note) {
  return note.length <= NOTE_MAX ? note : `${note.slice(0, NOTE_MAX - 3)}...`;
}

function buildRow(findings, link, errorNote) {
  const row = {
    tool: 'config-guard',
    scope: 'repo',
    status: 'pass',
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    note: '',
  };
  if (errorNote) {
    row.status = 'error';
    row.note = truncateNote(errorNote);
  } else if (findings.length > 0) {
    row.status = 'findings';
    row.counts.high = findings.length;
    row.note = truncateNote(findings.map((f) => (f.key ? `${f.file}:${f.key}` : f.file)).join(', '));
  }
  if (link) row.link = link;
  return row;
}

function writeRow(outDir, row) {
  const dir = path.resolve(outDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'row-config-guard-repo.json'), `${JSON.stringify(row, null, 2)}\n`, 'utf8');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`config-guard: ${err.message}\nUsage: node scripts/ci/config-guard.js --out <dir> [--link <url>]\n`);
    process.exit(1);
  }

  let row;
  try {
    const files = {};
    for (const file of GUARDED_FILES) files[file] = readOptional(file);
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const allowlist = JSON.parse(fs.readFileSync(path.join(ROOT, ...ALLOWLIST_PATH.split('/')), 'utf8'));
    const { findings } = checkConfigGuard({ files, tracked: normalizeTracked(tracked), allowlist });
    for (const f of findings) {
      process.stdout.write(`::warning file=${f.file}::${f.key ? `${f.key} ` : ''}${f.rule}\n`);
    }
    process.stdout.write(`config-guard: ${findings.length} finding(s)\n`);
    row = buildRow(findings, args.link, null);
  } catch (err) {
    process.stderr.write(`config-guard error: ${err.message}\n`);
    row = buildRow([], args.link, `config guard failed: ${err.message}`);
  }
  writeRow(args.out, row);
  process.exit(0);
}

module.exports = { checkConfigGuard };

if (require.main === module) main();
