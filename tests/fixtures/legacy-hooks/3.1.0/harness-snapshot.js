'use strict';
/**
 * Claude Code Hook helper — builds the static (unprobed) parts of a harness snapshot and computes
 * its DD-2 id (not a hook entry point itself).
 *
 * This is the DD-1 shape of the `2026-10-16-sysctx-skill-source` plan: one `harness-snapshot`
 * NDJSON line describing the harness itself (skill/workflow/command catalog, agents, MCP servers,
 * CLAUDE.md + `.claude/rules/` context) rather than the session. `send-logs-hook.js` is the only
 * caller that assembles a *full* body (it adds `schemaVersion`, `perToolDetailSupported` and the
 * MCP probe results, per DD-7) — everything in this file is the static part: no network call and no
 * MCP probe. The only processes it spawns are at most 2 short `git` calls (`harness-git-status.js`)
 * that set each entry's optional `gitStatus` before the id is computed.
 *
 * @typedef {Object} HarnessSnapshotPlugin
 * @property {string} id
 * @property {string} name
 * @property {string} marketplace
 * @property {string} version
 * @property {string} [gitCommitSha]
 *
 * @typedef {Object} HarnessSnapshotSkillEntry
 * @property {string} name - plugin entries are `<pluginName>:<name>` (DD-1)
 * @property {'skill'|'workflow'|'command'} kind
 * @property {'project'|'user'|'plugin'|'org-synced'} source
 * @property {string} description
 * @property {string} [argumentHint]
 * @property {string} body - file text after frontmatter; a workflow's body is the whole `.js` text
 * @property {string} path - DD-3 path, shaped per `source`
 * @property {number} bytes
 * @property {string} contentHash - sha256 hex of the raw UTF-8 file text
 * @property {HarnessSnapshotPlugin} [plugin] - present only on a `plugin`-source entry
 * @property {'tracked'|'untracked'|'ignored'|'outside-repo'} [gitStatus] - absent when git gave no answer
 *
 * @typedef {Object} HarnessSnapshotAgentEntry
 * @property {string} name
 * @property {string} description
 * @property {string} body
 * @property {string} path - DD-3 `project` path
 * @property {number} bytes
 * @property {string} contentHash
 * @property {'project'} source
 * @property {'tracked'|'untracked'|'ignored'|'outside-repo'} [gitStatus] - absent when git gave no answer
 *
 * @typedef {Object} HarnessSnapshotMcpToolEntry
 * @property {string} name
 * @property {number} schemaSizeTokens
 *
 * @typedef {Object} HarnessSnapshotMcpServerEntry
 * @property {string} name
 * @property {string} command
 * @property {string} args
 * @property {string} [url]
 * @property {'project'|'user'} configSource
 * @property {boolean} [connected] - absent until `send-logs-hook.js` runs the probe
 * @property {HarnessSnapshotMcpToolEntry[]} [tools] - absent until the probe runs
 *
 * @typedef {Object} HarnessSnapshotContextFile
 * @property {string} path - DD-3 `project` path
 * @property {number} bytes
 * @property {string} contentHash
 * @property {string} [content] - kept only for `.claude/rules/` files
 * @property {'tracked'|'untracked'|'ignored'|'outside-repo'} [gitStatus] - absent when git gave no answer
 *
 * @typedef {Object} HarnessSnapshotSystemContext
 * @property {number} totalBytes
 * @property {HarnessSnapshotContextFile[]} files
 *
 * @typedef {Object} HarnessSnapshot
 * @property {'harness-snapshot'} type
 * @property {string} snapshotId - 64 lowercase hex, DD-2
 * @property {number} schemaVersion
 * @property {boolean} perToolDetailSupported - capability flag, NOT part of the id (DD-2)
 * @property {HarnessSnapshotSkillEntry[]} skills
 * @property {HarnessSnapshotAgentEntry[]} agents
 * @property {HarnessSnapshotMcpServerEntry[]} mcpServers
 * @property {HarnessSnapshotSystemContext|null} systemContext
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { claudeConfigDir } = require('./claude-config-dir');
const { buildSkillCatalog, parseFrontmatter } = require('./skill-catalog');
const { annotateGitStatus } = require('./harness-git-status');

/** DD-16: bumped only on an incompatible change to the DD-1 body shape. */
const HARNESS_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * @param {string} text
 * @returns {string} sha256 hex digest of the raw UTF-8 text — DD-2's `contentHash`.
 */
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @param {string} root
 * @param {string} absFile
 * @returns {string} `path.relative(root, absFile)` with forward slashes — the DD-3 `project` path,
 *   including the `../x/CLAUDE.md` case for a `systemContext` file found outside `root`.
 */
function relForwardSlash(root, absFile) {
  return path.relative(root, absFile).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * Collect agent definitions from `<projectRoot>/.claude/agents/<name>/AGENT.md` (DD-1's `agents[]`
 * — project-only, per DD-5's scope: there is no user- or plugin-level agents folder).
 * @param {string} cwd
 * @param {string} [projectRoot] - git root, when known; falls back to `cwd` (same convention as
 *   `buildSystemContext` below) so a bare `cwd` call keeps working.
 * @returns {HarnessSnapshotAgentEntry[]|null}
 */
function buildAgentDefinitions(cwd, projectRoot) {
  const root = projectRoot || cwd;
  const agentsDir = path.join(cwd, '.claude', 'agents');
  let subdirs;
  try {
    subdirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }

  const agents = [];
  for (const subdir of subdirs) {
    const agentFile = path.join(agentsDir, subdir.name, 'AGENT.md');
    try {
      const stat = fs.statSync(agentFile);
      if (!stat.isFile() || stat.size === 0) continue;
      const text = fs.readFileSync(agentFile, 'utf8');
      const { fm, body } = parseFrontmatter(text);
      agents.push({
        name: fm['name'] || subdir.name,
        description: fm['description'] || '',
        body,
        path: relForwardSlash(root, agentFile),
        bytes: stat.size,
        contentHash: sha256Hex(text),
        source: 'project',
      });
    } catch (err) {
      process.stderr.write(`[harness-snapshot] skipping ${agentFile}: ${err.message}\n`);
    }
  }

  return agents.length > 0 ? agents : null;
}

// ---------------------------------------------------------------------------
// System context (CLAUDE.md + .claude/rules/*.md)
// ---------------------------------------------------------------------------

/**
 * Scan the project directory for CLAUDE.md / CLAUDE.local.md files, plus `.claude/rules/*.md`, and
 * return DD-1's `systemContext`. Looks in `cwd`, common sub-directories, and up to one parent dir —
 * unchanged from the hook's original `buildClaudeMdContext` behaviour.
 *
 * `env` is accepted (not currently read) to keep this builder's signature the same shape as the
 * other DD-7 static-section builders (`readMcpServersStatic(projectRoot, env)`,
 * `buildSkillCatalog({..., env})`) that `buildHarnessSnapshot` calls alongside it.
 *
 * @param {string|null} cwd
 * @param {string|null} [projectRoot] - git root, when known — used for both the DD-3 relative
 *   path base and the `.claude/rules/` scan below, so a monorepo-subdirectory `cwd` (e.g.
 *   `client/`, which has no `.claude/rules` of its own) doesn't silently report zero rule files.
 *   Falls back to `cwd` when absent.
 * @param {Record<string, string|undefined>} [env]
 * @returns {HarnessSnapshotSystemContext|null}
 */
function buildSystemContext(cwd, projectRoot, env) { // eslint-disable-line no-unused-vars
  if (!cwd) return null;
  const root = projectRoot || cwd;

  const candidates = new Set();
  const roots = [cwd, path.dirname(cwd)];
  const subs = ['', 'client', 'server', 'hook'];
  for (const r of roots) {
    for (const sub of subs) {
      const dir = sub ? path.join(r, sub) : r;
      candidates.add(path.join(dir, 'CLAUDE.md'));
      candidates.add(path.join(dir, 'CLAUDE.local.md'));
    }
  }

  const found = [];
  for (const filePath of candidates) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.size > 0) {
        const text = fs.readFileSync(filePath, 'utf8');
        found.push({ path: relForwardSlash(root, filePath), bytes: stat.size, contentHash: sha256Hex(text) });
      }
    } catch {
      // file absent, or unreadable once stat'd — skip either way
    }
  }

  // Also scan .claude/rules/*.md — include content for rule files. Uses `root` (the git root when
  // known), not raw `cwd`: `.claude/rules/` lives at the repo root, so a session whose cwd is a
  // monorepo subdirectory (e.g. `client/`) would otherwise find nothing here and silently report
  // zero rules for that session.
  const rulesDir = path.join(root, '.claude', 'rules');
  try {
    const entries = fs.readdirSync(rulesDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const rp = path.join(rulesDir, e.name);
        try {
          const stat = fs.statSync(rp);
          if (stat.isFile() && stat.size > 0) {
            const content = fs.readFileSync(rp, 'utf8');
            found.push({
              path: relForwardSlash(root, rp),
              bytes: stat.size,
              contentHash: sha256Hex(content),
              content,
            });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* rules dir absent */ }

  if (found.length === 0) return null;

  const totalBytes = found.reduce((s, f) => s + f.bytes, 0);
  return { totalBytes, files: found };
}

// ---------------------------------------------------------------------------
// MCP servers (static config only — no probe)
// ---------------------------------------------------------------------------

/**
 * Extract MCP servers from a parsed JSON object (`mcpServers` key), with scrubbed credentials.
 * @param {Record<string, unknown>} mcpServers
 * @param {'project'|'user'} configSource
 * @returns {Array<{ name: string, command: string, args: string, configSource: string, url?: string }>}
 */
function extractMcpServers(mcpServers, configSource) {
  const servers = [];
  for (const [name, cfg] of Object.entries(mcpServers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const command = typeof cfg.command === 'string' ? cfg.command : '';
    const rawArgs = Array.isArray(cfg.args) ? cfg.args : [];
    const scrubbedArgs = rawArgs.map((a) =>
      typeof a === 'string' ? a.replace(/:\/\/[^@]+@/g, '://') : String(a)
    );
    const url = typeof cfg.url === 'string' ? cfg.url.replace(/:\/\/[^@]+@/g, '://') : undefined;
    const entry = { name, command, args: scrubbedArgs.join(' '), configSource };
    if (url !== undefined) entry.url = url;
    servers.push(entry);
  }
  return servers;
}

/**
 * Read `<projectRoot>/.mcp.json` (project), `<claudeConfigDir>/mcp.json` and
 * `<claudeConfigDir>/settings.json` (user) for MCP server definitions — the static part of the old
 * `buildMcpConfig`, with the probe (`connected`/`tools`) split out to `send-logs-hook.js` per DD-7,
 * which runs it only once the DD-2 id turns out to be unknown.
 *
 * Precedence: project wins over user `mcp.json` wins over user `settings.json`, matching the
 * existing dedupe order.
 *
 * @param {string} projectRoot
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ servers: Array<{ name: string, command: string, args: string, configSource: string, url?: string }>, rawConfigByName: Map<string, object> }}
 */
function readMcpServersStatic(projectRoot, env) {
  const servers = [];
  // First-source-wins raw (unscrubbed) config per server name — this is what the probe actually
  // spawns, since scrubbing (extractMcpServers) exists only to sanitize what gets uploaded, not to
  // change what the server is invoked with.
  const rawConfigByName = new Map();

  /**
   * @param {Record<string, unknown>|null} mcpServers
   * @param {'project'|'user'} configSource
   * @param {boolean} dedupe - true for the two user-level sources, which must not shadow an
   *   already-known (higher-priority) server name
   */
  function ingestSource(mcpServers, configSource, dedupe) {
    if (!mcpServers || typeof mcpServers !== 'object') return;
    const knownNames = dedupe ? new Set(servers.map((s) => s.name)) : null;
    const extracted = extractMcpServers(mcpServers, configSource).filter(
      (s) => !knownNames || !knownNames.has(s.name),
    );
    for (const entry of extracted) {
      servers.push(entry);
      if (!rawConfigByName.has(entry.name)) {
        rawConfigByName.set(entry.name, mcpServers[entry.name]);
      }
    }
  }

  // Project-level .mcp.json
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8');
    const parsed = JSON.parse(raw);
    ingestSource(parsed && typeof parsed === 'object' ? parsed.mcpServers : null, 'project', false);
  } catch { /* absent or invalid */ }

  // User-level <claude config dir>/mcp.json (dedicated MCP config; higher priority than settings.json)
  try {
    const userMcpJson = path.join(claudeConfigDir(env), 'mcp.json');
    const raw = fs.readFileSync(userMcpJson, 'utf8');
    const parsed = JSON.parse(raw);
    ingestSource(parsed && typeof parsed === 'object' ? parsed.mcpServers : null, 'user', true);
  } catch { /* absent or invalid */ }

  // User-level <claude config dir>/settings.json (fallback; deduplicates against project + mcp.json)
  try {
    const userSettings = path.join(claudeConfigDir(env), 'settings.json');
    const raw = fs.readFileSync(userSettings, 'utf8');
    const parsed = JSON.parse(raw);
    ingestSource(parsed && typeof parsed === 'object' ? parsed.mcpServers : null, 'user', true);
  } catch { /* absent or invalid */ }

  return { servers, rawConfigByName };
}

// ---------------------------------------------------------------------------
// DD-2 snapshot id
// ---------------------------------------------------------------------------

/**
 * Appends `gitStatus` to an id tuple only when it is a non-empty string, so a snapshot without the
 * field (an older hook, or git gave no answer) keeps its id byte-for-byte.
 * @param {Array<string>} tuple
 * @param {{ gitStatus?: unknown }} entry
 * @returns {Array<string>}
 */
function withGitStatus(tuple, entry) {
  return typeof entry.gitStatus === 'string' && entry.gitStatus ? [...tuple, entry.gitStatus] : tuple;
}

/** @param {string|undefined|null} a @param {string|undefined|null} b */
function cmpStr(a, b) {
  const x = a || '';
  const y = b || '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * DD-2's `snapshotId` algorithm: `sha256Hex(JSON.stringify(canon))`, where `canon` is a fixed,
 * sorted, minimal projection of the four sections — deliberately excluding the MCP probe results
 * (`connected`, `tools`) and `perToolDetailSupported`, so running the probe or getting a different
 * answer from it never changes the id.
 *
 * @param {{
 *   skills?: HarnessSnapshotSkillEntry[],
 *   agents?: HarnessSnapshotAgentEntry[],
 *   mcpServers?: HarnessSnapshotMcpServerEntry[],
 *   systemContext?: HarnessSnapshotSystemContext|null,
 * }} sections
 * @returns {string} 64-char lowercase hex digest
 */
function computeSnapshotId(sections) {
  const skills = Array.isArray(sections.skills) ? sections.skills : [];
  const agents = Array.isArray(sections.agents) ? sections.agents : [];
  const mcpServers = Array.isArray(sections.mcpServers) ? sections.mcpServers : [];
  const contextFiles =
    sections.systemContext && Array.isArray(sections.systemContext.files)
      ? sections.systemContext.files
      : [];

  const canon = {
    v: HARNESS_SNAPSHOT_SCHEMA_VERSION,
    skills: [...skills]
      .sort((a, b) => cmpStr(a.source, b.source) || cmpStr(a.name, b.name))
      .map((s) => withGitStatus([
        s.name,
        s.source,
        s.plugin ? `${s.plugin.id}@${s.plugin.version}` : '',
        s.contentHash,
      ], s)),
    agents: [...agents]
      .sort((a, b) => cmpStr(a.path, b.path))
      .map((a) => withGitStatus([a.name, a.path, a.contentHash], a)),
    mcp: [...mcpServers]
      .sort((a, b) => cmpStr(a.name, b.name))
      .map((m) => [m.name, m.command, m.args, m.url || '', m.configSource]),
    context: [...contextFiles]
      .sort((a, b) => cmpStr(a.path, b.path))
      .map((f) => withGitStatus([f.path, f.contentHash], f)),
  };

  return sha256Hex(JSON.stringify(canon));
}

// ---------------------------------------------------------------------------
// Full static snapshot
// ---------------------------------------------------------------------------

/**
 * Build the static (unprobed) harness snapshot and its DD-2 id — DD-7 step 1. The caller
 * (`send-logs-hook.js`) adds `type`, `schemaVersion`, `perToolDetailSupported` and, only when the
 * id turns out unknown, the MCP probe results over `rawConfigByName` (DD-7 steps 2–3).
 *
 * @param {{ projectRoot: string, cwd?: string, env?: Record<string, string|undefined>, log?: (line: string) => void }} options
 * @returns {{
 *   snapshotId: string,
 *   skills: HarnessSnapshotSkillEntry[],
 *   agents: HarnessSnapshotAgentEntry[]|null,
 *   mcpServers: Array<{ name: string, command: string, args: string, configSource: string, url?: string }>,
 *   systemContext: HarnessSnapshotSystemContext|null,
 *   rawConfigByName: Map<string, object>,
 * }}
 */
function buildHarnessSnapshot({ projectRoot, cwd, env = process.env, log } = {}) {
  const resolvedProjectRoot = typeof projectRoot === 'string' && projectRoot ? projectRoot : cwd || process.cwd();
  const resolvedCwd = typeof cwd === 'string' && cwd ? cwd : resolvedProjectRoot;

  const skills = buildSkillCatalog({ projectRoot: resolvedProjectRoot, cwd: resolvedCwd, env, log });
  const agents = buildAgentDefinitions(resolvedCwd, resolvedProjectRoot);
  const systemContext = buildSystemContext(resolvedCwd, resolvedProjectRoot, env);
  const { servers: mcpServers, rawConfigByName } = readMcpServersStatic(resolvedProjectRoot, env);

  // Before the id: `gitStatus` is part of the skill/agent/context tuples.
  annotateGitStatus({ projectRoot: resolvedProjectRoot, skills, agents, systemContext });

  const snapshotId = computeSnapshotId({ skills, agents, mcpServers, systemContext });

  return { snapshotId, skills, agents, mcpServers, systemContext, rawConfigByName };
}

module.exports = {
  HARNESS_SNAPSHOT_SCHEMA_VERSION,
  buildAgentDefinitions,
  buildSystemContext,
  readMcpServersStatic,
  computeSnapshotId,
  buildHarnessSnapshot,
};
