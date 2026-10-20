#!/usr/bin/env node
/**
 * Claude Code Hook — Stop / Interrupt events
 * Uploads collected JSONL telemetry files to the artisyn-log-hub server.
 *
 * Collects four namespaces:
 *   artisyn         — files from TELEMETRY_DIR (default <cwd>/.artisyn/ai_work_dir/telemetry)
 *   claude          — files from ~/.claude/projects/<slug>/<session>.jsonl
 *   claude-subagent — files from ~/.claude/projects/<slug>/<session>/subagents/<agent-id>.jsonl
 *                     (also .../subagents/workflows/<wf-id>/<agent-id>.jsonl). Parent linkage
 *                     (parentSessionId) is derived from the sibling <agent-id>.meta.json's
 *                     parentAgentId when present, so nested agents (agent spawns agent spawns
 *                     agent) upload with their true immediate parent, not always flattened onto
 *                     the root session. Falls back to the root session id when .meta.json is
 *                     missing, has no parentAgentId (older Claude Code / true depth-1 agents), or
 *                     fails to parse.
 *   claude-otel     — chunk files from <TELEMETRY_DIR>/otel/<session-id>/, written by this
 *                     project's own OTLP receiver (otel-receiver.js). The directory belongs to
 *                     exactly one project, so every file in it is uploaded unfiltered. Gated on
 *                     the `otelEnabled` config key, and pruned by `otelRetentionDays` at the end
 *                     of each run.
 *
 * Manifest (<telemetry_dir>/.claude-logs.sent) tracks already-uploaded files
 * by size so unchanged files are skipped on subsequent runs.
 *
 * Configure in .artisyn/config/log-hub.json / log-hub.local.json:
 *   serverUrl: "https://..."
 *   apiKey: "..."
 *   sendLogsTimeoutMs: 10000   (optional, default 10000)
 */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadConfig, resolveTelemetryDir, resolveOtelDir, resolveOtelNumber } = require('./env-context');
const { getGitRoot } = require('./git-context');
const { hookLog, getHookVersion, readLogTail } = require('./hook-log');
const { readRecommendations, upsertRecommendation, removeRecommendation } = require('./recommendations');
const { maybeReArmOtelSession } = require('./otel-register');
const { uploadFile, uploadFileChunked, CHUNK_SIZE_BYTES, acquireUploadLock, releaseUploadLock, formatServerOrigin } = require('./upload-logs');

const HOOK_FILE = 'send-logs-hook.js';

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

/** @param {string} manifestPath @returns {Map<string, number>} */
function readManifest(manifestPath) {
  const map = new Map();
  try {
    const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.lastIndexOf(' ');
      if (spaceIdx === -1) continue;
      const key = trimmed.slice(0, spaceIdx);
      const sizeStr = trimmed.slice(spaceIdx + 1);
      const size = parseInt(sizeStr, 10);
      if (!key || isNaN(size)) continue;
      map.set(key, size);
    }
  } catch {
    // file missing or unreadable — start fresh
  }
  return map;
}

/**
 * Rewrite the manifest file from the current map.
 * @param {string} telemetryDir
 * @param {string} manifestPath
 * @param {Map<string, number>} map
 */
function writeManifest(telemetryDir, manifestPath, map, sessionId, cwd) {
  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
    let content = '';
    for (const [key, size] of map) {
      content += `${key} ${size}\n`;
    }
    fs.writeFileSync(manifestPath, content, 'utf8');
  } catch (err) {
    const msg = `failed to write manifest: ${err.message}`;
    process.stderr.write(`send-logs-hook: ${msg}\n`);
    hookLog(HOOK_FILE, sessionId, 'error', msg, cwd);
  }
}

// ---------------------------------------------------------------------------
// CLAUDE.md context helpers
// ---------------------------------------------------------------------------

/**
 * Scan the project directory for CLAUDE.md / CLAUDE.local.md files and return
 * their sizes.  Looks in cwd, common sub-directories, and up to one parent dir.
 * @param {string|null} cwd
 * @returns {{ totalBytes: number, files: { path: string, bytes: number }[] }|null}
 */
function buildClaudeMdContext(cwd) {
  if (!cwd) return null;

  const candidates = new Set();
  const roots = [cwd, path.dirname(cwd)];
  const subs = ['', 'client', 'server', 'hook'];
  for (const root of roots) {
    for (const sub of subs) {
      const dir = sub ? path.join(root, sub) : root;
      candidates.add(path.join(dir, 'CLAUDE.md'));
      candidates.add(path.join(dir, 'CLAUDE.local.md'));
    }
  }

  const found = [];
  for (const filePath of candidates) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.size > 0) {
        found.push({ path: filePath, bytes: stat.size, lastModified: stat.mtimeMs });
      }
    } catch {
      // file absent
    }
  }

  // Also scan .claude/rules/*.md — include content for rule files
  const rulesDir = path.join(cwd, '.claude', 'rules');
  try {
    const entries = fs.readdirSync(rulesDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const rp = path.join(rulesDir, e.name);
        try {
          const stat = fs.statSync(rp);
          if (stat.isFile() && stat.size > 0) {
            let content;
            try { content = fs.readFileSync(rp, 'utf8'); } catch { /* skip */ }
            found.push({ path: rp, bytes: stat.size, lastModified: stat.mtimeMs, ...(content !== undefined ? { content } : {}) });
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
// Skill / Agent / MCP helpers
// ---------------------------------------------------------------------------

/**
 * Parse YAML-style frontmatter from a markdown string.
 * Returns { fm: Record<string,string>, body: string }.
 * @param {string} text
 * @returns {{ fm: Record<string, string>, body: string }}
 */
function parseFrontmatter(text) {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/m);
  const fm = fmMatch ? fmMatch[1] : '';
  const result = {};
  const re = /^([\w-]+):\s*["']?(.+?)["']?\s*$/gm;
  let m;
  while ((m = re.exec(fm)) !== null) result[m[1]] = m[2];
  return {
    fm: result,
    body: fmMatch ? text.slice(text.indexOf(fmMatch[0]) + fmMatch[0].length).trimStart() : text,
  };
}

/**
 * Recursively find all SKILL.md files under a directory, up to maxDepth.
 * @param {string} dir
 * @param {number} maxDepth
 * @returns {string[]}
 */
function findSkillFiles(dir, maxDepth) {
  const results = [];
  if (maxDepth <= 0) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === 'SKILL.md') {
      results.push(full);
    } else if (e.isDirectory()) {
      results.push(...findSkillFiles(full, maxDepth - 1));
    }
  }
  return results;
}

/**
 * Collect skill definitions from .claude/skills/<name>/SKILL.md (project)
 * and ~/.claude/plugins/ (plugin).
 * @param {string} cwd
 * @returns {Array<{ name: string, description: string, argumentHint: string, body: string, path: string, bytes: number, source: string }>|null}
 */
function buildSkillDefinitions(cwd) {
  const skillsDir = path.join(cwd, '.claude', 'skills');
  let subdirs;
  try {
    subdirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    subdirs = [];
  }

  const skills = [];
  const projectNames = new Set();

  for (const subdir of subdirs) {
    const skillFile = path.join(skillsDir, subdir.name, 'SKILL.md');
    try {
      const stat = fs.statSync(skillFile);
      if (!stat.isFile() || stat.size === 0) continue;
      const text = fs.readFileSync(skillFile, 'utf8');
      const { fm, body } = parseFrontmatter(text);
      const name = fm['name'] || subdir.name;
      projectNames.add(name);
      skills.push({
        name,
        description: fm['description'] || '',
        argumentHint: fm['argument-hint'] || '',
        body,
        path: skillFile,
        bytes: stat.size,
        lastModified: stat.mtimeMs,
        source: 'project',
      });
    } catch (err) {
      process.stderr.write(`[skill-definitions] skipping ${skillFile}: ${err.message}\n`);
    }
  }

  // Scan ~/.claude/plugins/ for plugin skills
  const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');
  const pluginDepth = parseInt(process.env.PLUGIN_SKILL_MAX_DEPTH || '30', 10) || 30;
  const pluginSkillFiles = findSkillFiles(pluginsDir, pluginDepth);
  for (const skillFile of pluginSkillFiles) {
    try {
      const stat = fs.statSync(skillFile);
      if (!stat.isFile() || stat.size === 0) continue;
      const text = fs.readFileSync(skillFile, 'utf8');
      const { fm, body } = parseFrontmatter(text);
      // Derive name from directory or frontmatter
      const dirName = path.basename(path.dirname(skillFile));
      const name = fm['name'] || dirName;
      if (projectNames.has(name)) continue; // project takes priority
      skills.push({
        name,
        description: fm['description'] || '',
        argumentHint: fm['argument-hint'] || '',
        body,
        path: skillFile,
        bytes: stat.size,
        lastModified: stat.mtimeMs,
        source: 'plugin',
      });
    } catch (err) {
      process.stderr.write(`[skill-definitions] skipping plugin ${skillFile}: ${err.message}\n`);
    }
  }

  return skills.length > 0 ? skills : null;
}

/**
 * Collect agent definitions from .claude/agents/<name>/AGENT.md.
 * @param {string} cwd
 * @returns {Array<{ name: string, description: string, body: string, path: string, bytes: number }>|null}
 */
function buildAgentDefinitions(cwd) {
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
        path: agentFile,
        bytes: stat.size,
        lastModified: stat.mtimeMs,
      });
    } catch (err) {
      process.stderr.write(`[agent-definitions] skipping ${agentFile}: ${err.message}\n`);
    }
  }

  return agents.length > 0 ? agents : null;
}

/**
 * Extract MCP servers from a parsed JSON object (mcpServers key), with scrubbed credentials.
 * @param {Record<string, unknown>} mcpServers
 * @param {'project'|'user'} configSource
 * @returns {Array<{ name: string, command: string, args: string, configSource: string }>}
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
 * Read .mcp.json (project) and ~/.claude/settings.json (user) for MCP server definitions.
 * @param {string} cwd
 * @returns {Array<{ name: string, command: string, args: string, configSource: string }>|null}
 */
function buildMcpConfig(cwd) {
  const servers = [];

  // Project-level .mcp.json
  try {
    const raw = fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const mcpServers = parsed && typeof parsed === 'object' ? parsed.mcpServers : null;
    if (mcpServers && typeof mcpServers === 'object') {
      servers.push(...extractMcpServers(mcpServers, 'project'));
    }
  } catch { /* absent or invalid */ }

  // User-level ~/.claude/mcp.json (dedicated MCP config; higher priority than settings.json)
  try {
    const userMcpJson = path.join(os.homedir(), '.claude', 'mcp.json');
    const raw = fs.readFileSync(userMcpJson, 'utf8');
    const parsed = JSON.parse(raw);
    const mcpServers = parsed && typeof parsed === 'object' ? parsed.mcpServers : null;
    if (mcpServers && typeof mcpServers === 'object') {
      const knownNames = new Set(servers.map((s) => s.name));
      const userServers = extractMcpServers(mcpServers, 'user').filter(
        (s) => !knownNames.has(s.name),
      );
      servers.push(...userServers);
    }
  } catch { /* absent or invalid */ }

  // User-level ~/.claude/settings.json (fallback; deduplicates against project + mcp.json)
  try {
    const userSettings = path.join(os.homedir(), '.claude', 'settings.json');
    const raw = fs.readFileSync(userSettings, 'utf8');
    const parsed = JSON.parse(raw);
    const mcpServers = parsed && typeof parsed === 'object' ? parsed.mcpServers : null;
    if (mcpServers && typeof mcpServers === 'object') {
      const knownNames = new Set(servers.map((s) => s.name));
      const userServers = extractMcpServers(mcpServers, 'user').filter(
        (s) => !knownNames.has(s.name),
      );
      servers.push(...userServers);
    }
  } catch { /* absent or invalid */ }

  return servers.length > 0 ? servers : null;
}

// ---------------------------------------------------------------------------
// File collection helpers
// ---------------------------------------------------------------------------

/**
 * List non-empty *.jsonl files in a directory (top-level only).
 * @param {string} dir
 * @returns {{ name: string, size: number }[]}
 */
function listJsonlFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => {
        try {
          const stat = fs.statSync(path.join(dir, e.name));
          return { name: e.name, size: stat.size };
        } catch {
          return null;
        }
      })
      .filter((f) => f !== null && f.size > 0);
  } catch {
    return [];
  }
}

/**
 * List OTEL chunk files across every session directory under `<otelDir>/<sessionId>/`, in write
 * order.
 *
 * The receiver names each chunk `<epochMs>-<seq>.jsonl` with a fixed-width stamp and a zero-padded
 * sequence, so sorting the basenames lexicographically across all sessions reproduces the order
 * the chunks were received — which is the order they must be uploaded in. `.tmp` files (a receiver
 * killed mid-write) are ignored by the `.jsonl` filter and swept by the prune.
 *
 * Fail-open like `listJsonlFiles`: an absent or unreadable directory yields nothing.
 *
 * @param {string} otelDir
 * @returns {{ sessionId: string, name: string, size: number, filePath: string }[]}
 */
function listOtelChunks(otelDir) {
  let sessionDirs;
  try {
    sessionDirs = fs
      .readdirSync(otelDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // directory absent or unreadable — nothing to collect
  }

  const chunks = [];
  for (const sessionId of sessionDirs) {
    const sessionDir = path.join(otelDir, sessionId);
    for (const { name, size } of listJsonlFiles(sessionDir)) {
      chunks.push({ sessionId, name, size, filePath: path.join(sessionDir, name) });
    }
  }
  // Global write order, not per-session: the epoch-ms prefix is comparable across sessions.
  chunks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return chunks;
}

/**
 * Read the sibling <agent-id>.meta.json file for a sub-agent JSONL file and return its
 * parentAgentId, if present. Fail-open: a missing file, unreadable file, malformed JSON, or a
 * parentAgentId field that isn't a non-empty string all resolve to null so the caller falls back
 * to root-session flattening (the pre-existing behavior).
 * @param {string} metaPath
 * @returns {string|null}
 */
function readParentAgentId(metaPath) {
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.parentAgentId === 'string' && parsed.parentAgentId) {
      return parsed.parentAgentId;
    }
  } catch {
    // missing/unreadable file or malformed JSON — fail open, caller falls back to the root
  }
  return null;
}

/**
 * Prune this project's OTEL directory, walking each `<otelDir>/<sessionId>/` chunk directory.
 *
 * Deletes every chunk whose mtime is older than `retentionDays`, plus any zero-byte `*.jsonl`
 * (which `listJsonlFiles` filters out, so it would otherwise never be uploaded and never be
 * reconsidered) and any leftover `*.tmp` from a receiver killed mid-write.
 *
 * The current session's chunks are never deleted — its receiver is still producing them. Unlike
 * the old one-file-per-session layout, chunks are immutable once renamed into place, so an
 * already-uploaded chunk of the current session is still retained here; retention age, not upload
 * state, is what governs deletion.
 *
 * An emptied session directory is removed too, so the otel dir does not accumulate stale dirs.
 *
 * Call sites must already hold the telemetryDir upload lock: the otel directory lives
 * inside telemetryDir, so that lock already serialises this against another Stop run of
 * the same project (Design Decision 10 — no new lock).
 *
 * Fail-open throughout: a missing/unreadable directory prunes nothing, and each unlink is
 * individually try/catched so one locked file (a Windows anti-virus scan, an editor
 * holding a handle) cannot abort the sweep.
 *
 * @param {string} otelDir
 * @param {number} retentionDays
 * @param {string|null} hookSessionId
 * @param {string|null} cwd - project dir, so an unlink failure can be surfaced in hook.log
 * @returns {{ deleted: number, failed: number, kept: number }}
 */
function pruneOtelDir(otelDir, retentionDays, hookSessionId, cwd) {
  const result = { deleted: 0, failed: 0, kept: 0 };
  const cutoffMs = Date.now() - retentionDays * 86400000;

  let sessionDirs;
  try {
    sessionDirs = fs
      .readdirSync(otelDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result; // directory absent or unreadable — nothing to prune
  }

  for (const sessionId of sessionDirs) {
    const sessionDir = path.join(otelDir, sessionId);
    const isCurrent = hookSessionId !== null && sessionId === hookSessionId;

    let entries;
    try {
      entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    } catch {
      continue; // vanished or unreadable — skip this session
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isChunk = entry.name.endsWith('.jsonl');
      const isTemp = entry.name.endsWith('.tmp');
      if (!isChunk && !isTemp) continue;

      const filePath = path.join(sessionDir, entry.name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue; // vanished between readdir and stat
      }

      const expired = stat.mtimeMs < cutoffMs;
      const empty = stat.size === 0;
      // A .tmp older than the cutoff is abandoned; a fresh one may be a write in flight.
      const abandonedTemp = isTemp && expired;
      const shouldDelete = isTemp ? abandonedTemp : !isCurrent && (expired || empty);
      if (!shouldDelete) {
        result.kept++;
        continue;
      }

      try {
        fs.unlinkSync(filePath);
        result.deleted++;
      } catch (err) {
        result.failed++;
        hookLog(HOOK_FILE, hookSessionId, 'warn', `otel prune: cannot delete ${sessionId}/${entry.name}: ${err.message}`, cwd);
      }
    }

    // Drop the directory once it holds nothing — never the current session's, which is still live.
    if (!isCurrent) {
      try {
        fs.rmdirSync(sessionDir);
      } catch {
        // not empty, or locked — inert either way, retried next run
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Read stdin
  let input = {};
  if (!process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync(process.stdin.fd, 'utf8');
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      // malformed or empty stdin
    }
  }

  const hookEvent = input.hook_event_name;
  if (hookEvent !== 'Stop' && hookEvent !== 'Interrupt') process.exit(0);

  const cwd = input.cwd || null;
  const hookSessionId = input.session_id || null;

  hookLog(HOOK_FILE, hookSessionId, 'activate', `${hookEvent} event received`, cwd);

  const config = loadConfig(cwd);

  // Re-arm the OTEL receiver at the END of a prompt turn — deliberately before the serverUrl/apiKey
  // check and the upload lock below, so a project that has telemetry enabled but uploading
  // unconfigured (or whose upload is currently locked) still keeps its receiver alive.
  //
  // This is the moment that matters most: the turn's telemetry has just been flushed and the next
  // turn is about to start, so a receiver that died during the turn is revived before it can lose
  // any more. `gitContext` is passed as null on purpose — buildOwnerPayload resolves the git root
  // itself from cwd, and the receiver's owner check compares only that root, so this avoids the
  // four git subprocesses a full getGitContext() would cost on every Stop.
  maybeReArmOtelSession(config, hookSessionId, cwd, null, HOOK_FILE);

  const serverUrl = (config.serverUrl || '').trim().replace(/\/$/, '');
  const apiKey = (config.apiKey || '').trim();
  const timeoutMs = config.sendLogsTimeoutMs;

  if (!serverUrl || !apiKey) process.exit(0);

  const telemetryDir = resolveTelemetryDir(cwd, config);

  const lockResult = acquireUploadLock(telemetryDir, 2 * config.sendLogsOnPromptTimeoutMs);
  if (!lockResult.acquired) {
    hookLog(HOOK_FILE, hookSessionId, 'result', 'skipped: upload lock held', cwd);
    process.exit(0);
  }

  try {
    await runUpload(cwd, hookSessionId, serverUrl, apiKey, timeoutMs, telemetryDir, config);
  } finally {
    releaseUploadLock(telemetryDir);
  }
  process.exit(0);
}

/**
 * The full Stop/Interrupt upload run — file scanning, manifest, upload loop, and hook-status
 * reporting. Split out from `main()` so the shared-lock acquire/release (Decision 19/25) can
 * wrap it in a `try/finally` without the trailing `process.exit(0)` (which never returns
 * control to JS, so a `finally` around it would never run) short-circuiting cleanup.
 *
 * `config` is the loaded project config (trailing parameter — older call sites that omit it
 * simply get no otel collection and no otel prune, which is the correct fail-open behaviour).
 */
async function runUpload(cwd, hookSessionId, serverUrl, apiKey, timeoutMs, telemetryDir, config) {
  const manifestPath = path.join(telemetryDir, '.claude-logs.sent');

  // Load manifest
  const manifest = readManifest(manifestPath);

  // -------------------------------------------------------------------------
  // §2.1 Artisyn files
  // -------------------------------------------------------------------------
  /** @type {{ namespace: string, sessionId: string, filePath: string, size: number, isCurrentSession: boolean }[]} */
  const filesToProcess = [];

  if (fs.existsSync(telemetryDir)) {
    const artisynFiles = listJsonlFiles(telemetryDir);
    for (const { name, size } of artisynFiles) {
      const sessionId = name.slice(0, -'.jsonl'.length);
      filesToProcess.push({
        namespace: 'artisyn',
        sessionId,
        filePath: path.join(telemetryDir, name),
        size,
        isCurrentSession: hookSessionId !== null && sessionId === hookSessionId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // §2.2 Claude files
  // -------------------------------------------------------------------------
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

  if (fs.existsSync(claudeProjectsDir)) {
    // Find all project slug dirs that belong to this git repo.
    // Claude Code names project dirs by slugifying the CWD path
    // (every non-alphanumeric-non-hyphen char → '-'). We collect:
    //   • the exact root-project slug
    //   • any slug that starts with root-slug + '-' (subdirectory projects, e.g. root/dist)
    // Fallback: locate by current session ID when the slug match finds nothing.
    const projectSlugDirs = [];
    try {
      const subdirs = fs
        .readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());

      const gitRoot = getGitRoot(cwd || process.cwd());
      const gitRootSlug = gitRoot.replace(/[^a-zA-Z0-9-]/g, '-');

      for (const subdir of subdirs) {
        const name = subdir.name;
        if (name === gitRootSlug || name.startsWith(gitRootSlug + '-')) {
          projectSlugDirs.push(path.join(claudeProjectsDir, name));
        }
      }

      // Fallback: search by current session ID
      if (projectSlugDirs.length === 0 && hookSessionId) {
        for (const subdir of subdirs) {
          const candidate = path.join(claudeProjectsDir, subdir.name, `${hookSessionId}.jsonl`);
          if (fs.existsSync(candidate)) {
            projectSlugDirs.push(path.join(claudeProjectsDir, subdir.name));
            break;
          }
        }
      }
    } catch {
      // skip
    }

    for (const projectSlugDir of projectSlugDirs) {
      // Main session files
      const claudeFiles = listJsonlFiles(projectSlugDir);
      for (const { name, size } of claudeFiles) {
        const sessionId = name.slice(0, -'.jsonl'.length);
        filesToProcess.push({
          namespace: 'claude',
          sessionId,
          filePath: path.join(projectSlugDir, name),
          size,
          isCurrentSession: hookSessionId !== null && sessionId === hookSessionId,
        });
      }

      // Subagent files: <projectSlugDir>/<session-id>/subagents/<agent-id>.jsonl
      let sessionDirs;
      try {
        sessionDirs = fs
          .readdirSync(projectSlugDir, { withFileTypes: true })
          .filter((e) => e.isDirectory());
      } catch {
        sessionDirs = [];
      }

      for (const sessionDir of sessionDirs) {
        const subagentsDir = path.join(projectSlugDir, sessionDir.name, 'subagents');
        if (!fs.existsSync(subagentsDir)) continue;
        const subagentFiles = listJsonlFiles(subagentsDir);
        for (const { name, size } of subagentFiles) {
          const agentId = name.slice(0, -'.jsonl'.length);
          const parentAgentId = readParentAgentId(path.join(subagentsDir, `${agentId}.meta.json`));
          const parentSessionId = parentAgentId ? `agent-${parentAgentId}` : sessionDir.name;
          filesToProcess.push({
            namespace: 'claude-subagent',
            sessionId: agentId,
            filePath: path.join(subagentsDir, name),
            size,
            // parent session dir name matches current hook session
            isCurrentSession: hookSessionId !== null && sessionDir.name === hookSessionId,
            manifestKey: `claude-subagent/${sessionDir.name}/${name}`,
            parentSessionId,
          });
        }

        // Workflow subagent files: subagents/workflows/<wf-id>/agent-*.jsonl
        const workflowsSubdir = path.join(subagentsDir, 'workflows');
        if (fs.existsSync(workflowsSubdir)) {
          let wfDirs = [];
          try {
            wfDirs = fs
              .readdirSync(workflowsSubdir, { withFileTypes: true })
              .filter((e) => e.isDirectory());
          } catch { /* skip */ }
          for (const wfDir of wfDirs) {
            // journal.jsonl is the workflow runtime's own bookkeeping file (one per
            // wf-id folder, one line per completed agent's return value) — it is not
            // an agent transcript and must not be uploaded as a fake claude-subagent.
            const wfAgentFiles = listJsonlFiles(
              path.join(workflowsSubdir, wfDir.name),
            ).filter(({ name: wfName }) => wfName !== 'journal.jsonl');
            for (const { name: wfName, size: wfSize } of wfAgentFiles) {
              const agentId = wfName.slice(0, -'.jsonl'.length);
              const parentAgentId = readParentAgentId(
                path.join(workflowsSubdir, wfDir.name, `${agentId}.meta.json`),
              );
              const parentSessionId = parentAgentId ? `agent-${parentAgentId}` : sessionDir.name;
              filesToProcess.push({
                namespace: 'claude-subagent',
                sessionId: agentId,
                filePath: path.join(workflowsSubdir, wfDir.name, wfName),
                size: wfSize,
                isCurrentSession: hookSessionId !== null && sessionDir.name === hookSessionId,
                manifestKey: `claude-subagent/${sessionDir.name}/workflows/${wfDir.name}/${wfName}`,
                parentSessionId,
                workflowRunId: wfDir.name,
              });
            }
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // §2.3 OTEL files
  // -------------------------------------------------------------------------
  // <telemetryDir>/otel/ belongs to exactly one project — its own receiver is the only
  // writer (Design Decision 2) — so every chunk in it is collected unfiltered: no ownership
  // check, no adoption, no watermark, no tenancy guard.
  //
  // Layout is <otelDir>/<sessionId>/<epochMs>-<seq>.jsonl, one file per inbound OTLP request.
  // Chunks are shipped in write order: the basename starts with a fixed-width epoch-ms stamp and
  // a zero-padded sequence, so a plain lexicographic sort across every session equals time order.
  if (config && config.otelEnabled) {
    const otelDir = resolveOtelDir(cwd, config);
    for (const { sessionId, name, size, filePath } of listOtelChunks(otelDir)) {
      filesToProcess.push({
        namespace: 'claude-otel',
        sessionId,
        filePath,
        size,
        manifestKey: `claude-otel/${sessionId}/${name}`,
        isCurrentSession: hookSessionId !== null && sessionId === hookSessionId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Upload loop
  // -------------------------------------------------------------------------
  let uploadedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  /**
   * Upload a single collected file: applies skip logic, artisyn-only project-context
   * prepends (+ any extraEvents), size-warns, uploads, and records manifest/hook.log
   * outcome. Shared by the main pass and the deferred current-session-artisyn pass
   * (the latter carries the hook-status event as an extra prepend).
   * @param {object} entry - one of filesToProcess
   * @param {object[]} extraEvents - extra JSON objects to prepend to an artisyn body
   * @returns {Promise<{ success: boolean, reason: string|null, warnings?: string[] }>}
   */
  async function processFile(entry, extraEvents) {
    const { namespace, sessionId, filePath, size, isCurrentSession, manifestKey: mkOverride, parentSessionId, workflowRunId } = entry;
    const manifestKey = mkOverride ?? `${namespace}/${path.basename(filePath)}`;

    // Skip logic (only for non-current-session files)
    if (!isCurrentSession) {
      const recorded = manifest.get(manifestKey);
      if (recorded !== undefined && recorded === size) {
        skippedCount++;
        return { success: true, reason: null };
      }
    }

    // Read file content
    let body;
    try {
      body = fs.readFileSync(filePath);
    } catch (err) {
      process.stderr.write(`send-logs-hook: cannot read ${filePath}: ${err.message}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'fail', `${manifestKey}: cannot read file: ${err.message}`, cwd);
      failedCount++;
      return { success: false, reason: `cannot read file: ${err.message}` };
    }

    // No trailing-partial-line trim for otel any more: the receiver writes each chunk to a .tmp
    // and renames it into place, so a `.jsonl` chunk is always complete by construction. The old
    // trim existed because the receiver appended to a live file; keeping it now would be worse
    // than useless, since it would silently truncate a genuinely malformed chunk into a
    // "valid" one and hide the corruption instead of failing loudly.

    // For artisyn sessions only, prepend project-context events (system-context, skill/agent/mcp
    // definitions, plus any extraEvents such as the current-session hook-status event). The
    // artisyn log is the metadata carrier; the server merges it with the claude log when
    // serving session data to the viewer.
    if (namespace === 'artisyn') {
      // Resolve the true repo root: cwd is often a monorepo subdirectory (e.g. `client/`),
      // whose own .claude/skills, .claude/agents and .mcp.json don't exist, so scanning raw
      // cwd silently misses every project-level skill/agent/MCP definition that actually
      // lives at the repo root.
      const projectRoot = getGitRoot(cwd || process.cwd());
      const claudeMdCtx = buildClaudeMdContext(cwd);
      if (claudeMdCtx) {
        const line = JSON.stringify({ type: 'system-context', claudeMd: claudeMdCtx }) + '\n';
        body = Buffer.concat([Buffer.from(line, 'utf8'), body]);
      }
      const skillDefs = buildSkillDefinitions(projectRoot);
      if (skillDefs) {
        const line = JSON.stringify({ type: 'skill-definitions', projectRoot, skills: skillDefs }) + '\n';
        body = Buffer.concat([Buffer.from(line, 'utf8'), body]);
      }
      const agentDefs = buildAgentDefinitions(projectRoot);
      if (agentDefs) {
        const line = JSON.stringify({ type: 'agent-definitions', projectRoot, agents: agentDefs }) + '\n';
        body = Buffer.concat([Buffer.from(line, 'utf8'), body]);
      }
      const mcpCfg = buildMcpConfig(projectRoot);
      if (mcpCfg) {
        const line = JSON.stringify({ type: 'mcp-config', servers: mcpCfg }) + '\n';
        body = Buffer.concat([Buffer.from(line, 'utf8'), body]);
      }
      for (const evt of extraEvents) {
        const line = JSON.stringify(evt) + '\n';
        body = Buffer.concat([Buffer.from(line, 'utf8'), body]);
      }
    }

    const bodyBytes = Buffer.byteLength(body);
    const MB40 = 40 * 1024 * 1024;
    if (bodyBytes > MB40) {
      const mb = (bodyBytes / 1024 / 1024).toFixed(1);
      process.stderr.write(`send-logs-hook: payload size=${mb} MB exceeds 40 MB warning threshold for ${namespace}/${sessionId}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'warn', `payload size=${mb} MB exceeds 40 MB warning threshold`, cwd);
    }

    const { success, reason, warnings } = bodyBytes > CHUNK_SIZE_BYTES
      ? await uploadFileChunked(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId || null, workflowRunId || null, telemetryDir, manifestKey)
      : await uploadFile(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId || null, workflowRunId || null);

    if (success) {
      // Don't record current-session files in the manifest: Claude Code appends
      // turn_duration to the JSONL after the Stop hook fires, so the file will
      // grow. Omitting the manifest entry ensures the next Stop re-uploads the
      // file and picks up those late-written events.
      if (!isCurrentSession) {
        manifest.set(manifestKey, size);
        writeManifest(telemetryDir, manifestPath, manifest, hookSessionId, cwd);
      }
      uploadedCount++;
      hookLog(HOOK_FILE, hookSessionId, 'result', `${manifestKey}: uploaded ${(bodyBytes / 1024).toFixed(0)} KB`, cwd);
    } else {
      hookLog(HOOK_FILE, hookSessionId, 'fail', `${manifestKey}: ${reason}`, cwd);
      failedCount++;
    }

    return { success, reason, warnings };
  }

  // The current session's own artisyn file is processed last, once every other
  // file's outcome is known, so the hook-status event it carries can report
  // this run's nonUploadableLogs. (If this specific upload itself fails, the
  // status report is lost until the next successful Stop — accepted trade-off,
  // consistent with the hook's fail-open design.)
  const currentArtisynEntries = filesToProcess.filter((f) => f.namespace === 'artisyn' && f.isCurrentSession);
  const otherEntries = filesToProcess.filter((f) => !(f.namespace === 'artisyn' && f.isCurrentSession));

  /** @type {{ file: string, reason: string }[]} */
  const nonUploadableLogs = [];
  let hadTimeoutFailure = false;

  /** @type {string[]} */
  const allWarnings = [];

  for (const entry of otherEntries) {
    const { success, reason, warnings } = await processFile(entry, []);
    if (warnings && warnings.length > 0) {
      allWarnings.push(...warnings);
    }
    if (!success) {
      nonUploadableLogs.push({ file: entry.filePath, reason });
      if (reason && reason.startsWith('timeout after')) {
        hadTimeoutFailure = true;
        upsertRecommendation(cwd, {
          rule: 'timeout-on-upload',
          message: 'Log uploads are timing out — consider raising sendLogsTimeoutMs in .artisyn/config/log-hub.local.json',
          detectedAt: new Date().toISOString(),
        });
      }
    }
  }

  // A run with no timeout failures means uploads are healthy again — clear a
  // previously recorded warning so it doesn't outlive the condition that caused it.
  if (!hadTimeoutFailure) {
    removeRecommendation(cwd, 'timeout-on-upload');
  }

  const hookStatusEvent = {
    type: 'hook-status',
    hookVersion: getHookVersion(),
    timestamp: new Date().toISOString(),
    logTail: readLogTail(cwd, 50),
    nonUploadableLogs,
    recommendations: readRecommendations(cwd).recommendations,
  };

  for (const entry of currentArtisynEntries) {
    const { warnings } = await processFile(entry, [hookStatusEvent]);
    if (warnings && warnings.length > 0) {
      allWarnings.push(...warnings);
    }
  }

  // Surface any server-reported broken-upload warnings the same way `timeout-on-upload`
  // does: a recommendation while the condition persists, cleared once it no longer does.
  if (allWarnings.length > 0) {
    upsertRecommendation(cwd, {
      rule: 'broken-upload-file',
      message: allWarnings.join('; '),
      detectedAt: new Date().toISOString(),
    });
  } else {
    removeRecommendation(cwd, 'broken-upload-file');
  }

  // Local prune of this project's otel directory. Runs inside the telemetryDir upload lock
  // main() already holds (the otel dir lives inside telemetryDir), so it is serialised
  // against another Stop run of this project without any new lock.
  if (config && config.otelEnabled) {
    const otelDir = resolveOtelDir(cwd, config);
    const retentionDays = resolveOtelNumber(config, 'otelRetentionDays');
    const pruned = pruneOtelDir(otelDir, retentionDays, hookSessionId, cwd);
    hookLog(HOOK_FILE, hookSessionId, 'result',
      `otel prune: deleted=${pruned.deleted} kept=${pruned.kept} failed=${pruned.failed} retentionDays=${retentionDays}`,
      cwd);
  }

  // `target` closes the loop on every run, not just failing ones: the destination is entirely
  // config-driven, so a stale `serverUrl` uploading successfully to the wrong instance is
  // otherwise indistinguishable in the log from a correct one.
  hookLog(HOOK_FILE, hookSessionId, 'result',
    `done: uploaded=${uploadedCount} skipped=${skippedCount} failed=${failedCount} total=${filesToProcess.length}`
    + ` target=${formatServerOrigin(serverUrl)}`,
    cwd);
}

main().catch((err) => {
  hookLog(HOOK_FILE, null, 'error', err.message, null);
  process.stderr.write(`send-logs-hook error: ${err.message}\n`);
  process.exit(0);
});
