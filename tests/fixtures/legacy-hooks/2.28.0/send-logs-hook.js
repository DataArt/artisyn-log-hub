#!/usr/bin/env node
/**
 * Claude Code Hook — Stop / SessionEnd events
 * Uploads collected JSONL telemetry files to the artisyn-log-hub server.
 *
 * Two modes, by event:
 *   Stop             — the full multi-session scan described below.
 *   SessionEnd       — a short, scoped flush of just this session's own artisyn + claude files
 *                      (`runSessionEndFlush`). `Stop` is otherwise the only trigger that ships a
 *                      session's own files, so a `Stop` that lost the upload lock used to strand
 *                      them until an unrelated session's later scan picked them up.
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
const { spawn } = require('child_process');

const { loadConfig, resolveTelemetryDir, resolveOtelDir, resolveOtelNumber } = require('./env-context');
const { getGitRoot, getWorkDirPath } = require('./git-context');
const { hookLog, getHookVersion, readLogTail } = require('./hook-log');
const { readRecommendations, upsertRecommendation, removeRecommendation } = require('./recommendations');
const { maybeReArmOtelSession } = require('./otel-register');
const { uploadFile, uploadFileChunked, uploadFileMaybeCompressed, CHUNK_SIZE_BYTES, acquireUploadLockWithWait, releaseUploadLock, formatServerOrigin } = require('./upload-logs');
const { collectScopedFiles, findProjectSlugDirs, transcriptBelongsToRepo } = require('./session-files');
const { sanitizeNdjson, formatDroppedLines } = require('./ndjson-sanitize');
const { buildProcessMarkerEnv, killProcessTree } = require('./process-marker');
const { readKnownSnapshots, rememberSnapshot, forgetSnapshot, recordSessionSnapshot } = require('./harness-state');
const { buildHarnessSnapshot, HARNESS_SNAPSHOT_SCHEMA_VERSION } = require('./harness-snapshot');
const { buildCodeInventory } = require('./code-inventory');
const { buildOkfSnapshot, buildOkfSnapshotRef } = require('./okf-snapshot');
const { readKnownOkfSnapshots, rememberOkfSnapshot, forgetOkfSnapshot } = require('./okf-state');
const { claudeConfigDir } = require('./claude-config-dir');

const HOOK_FILE = 'send-logs-hook.js';

// `--self-check`: the installer's post-install load check — every require above has run.
require('./hook-log').exitIfSelfCheck(HOOK_FILE);

// Upload-lock wait budgets (see `acquireUploadLockWithWait`). `Stop` blocks the interactive turn,
// so it only rides out a lock that is about to be released; `SessionEnd` is the session's last
// trigger and waits long enough to outlast a contending catch-up run.
const LOCK_WAIT_STOP_MS = 2000;
const LOCK_WAIT_SESSION_END_MS = 20000;
const LOCK_POLL_INTERVAL_MS = 250;

// Static, coarse schema-size estimate for the MCP `tools/list` probe.
// Deliberately a separate, fixed constant from the per-model `BYTES_PER_TOKEN` ratios
// (see docs/knowledgebase/token-byte-ratio.md, currently 3.5/2.7) that drive token estimation
// elsewhere in this codebase — the FR mandates one fixed, coarse ÷4 estimate for this specific
// static indicator, not the more accurate per-model ratio.
const MCP_SCHEMA_CHARS_PER_TOKEN = 4;

// Manifest write batching bounds — see `flushManifest()` in `runUpload()`. Both are deliberately
// small: they exist to stop the whole-map rewrite from running once per uploaded file, not to
// defer durability, so the crash window stays a handful of redundant re-uploads.
const MANIFEST_FLUSH_EVERY = 25;
const MANIFEST_FLUSH_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Code-inventory throttle state
// ---------------------------------------------------------------------------

/**
 * How often one repo root may be re-measured. Six hours is a working day quartered: long enough
 * that the `git diff --numstat` walk is invisible next to the upload it rides on (once per window
 * vs. many uploads), short enough that the denominator tracks a day's worth of commits. The
 * snapshot is only ever a denominator, so it needs to be *recent*, not live.
 */
const CODE_INVENTORY_THROTTLE_MS = 6 * 60 * 60 * 1000;

/**
 * Its own state file, separate from `harness-state.json` — the two are throttled on entirely
 * different signals (a harness fingerprint vs. a clock), and sharing a file would couple a
 * once-per-session decision to a six-hourly one.
 */
const CODE_INVENTORY_STATE_FILE = 'code-inventory-state.json';
const CODE_INVENTORY_STATE_VERSION = 1;

/**
 * Read `{ <repoRoot>: <lastReportedAtMs> }`, or `{}` on any problem.
 *
 * Keyed by repo root even though the state file already lives inside one repo's work dir: a
 * monorepo checkout can be reached through more than one path, and a wrong-repo snapshot is worse
 * than a redundant one. Fail-open on every error (missing, unreadable, malformed, wrong version) —
 * the cost is one extra measurement, whereas failing closed would silently stop reporting the
 * denominator with no signal.
 *
 * @param {string} workDir
 * @returns {Record<string, number>}
 */
function readCodeInventoryState(workDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workDir, CODE_INVENTORY_STATE_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    if (parsed.version !== CODE_INVENTORY_STATE_VERSION) return {};
    const roots = parsed.roots;
    if (!roots || typeof roots !== 'object') return {};
    /** @type {Record<string, number>} */
    const out = {};
    for (const [root, at] of Object.entries(roots)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[root] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist the state with a temp-file + rename, so a crash mid-write cannot leave a truncated JSON
 * that the next run would have to treat as "never reported". Never throws: failing to record a
 * report costs one redundant snapshot next run, and must not fail an upload that already succeeded.
 *
 * @param {string} workDir
 * @param {Record<string, number>} roots
 * @returns {boolean} true when the state reached disk
 */
function writeCodeInventoryState(workDir, roots) {
  const target = path.join(workDir, CODE_INVENTORY_STATE_FILE);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const doc = {
      version: CODE_INVENTORY_STATE_VERSION,
      roots,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing left to clean up
    }
    return false;
  }
}

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
  const tmpPath = `${manifestPath}.tmp`;
  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
    let content = '';
    for (const [key, size] of map) {
      content += `${key} ${size}\n`;
    }
    // Temp file + rename, not a direct write: this rewrites the WHOLE map (tens of thousands of
    // lines), and a crash or a full disk partway through a direct `writeFileSync` leaves a
    // truncated manifest. `readManifest()` cannot tell a truncated file from a shorter one, so the
    // entries past the cut would silently look un-uploaded and the next run would re-upload them.
    // `renameSync` over an existing file is atomic on both NTFS and POSIX, so a reader sees either
    // the old manifest or the new one — never a partial one. Same pattern `otel-receiver.js` uses
    // for chunk files and `harness-state.js` for its own state.
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, manifestPath);
  } catch (err) {
    const msg = `failed to write manifest: ${err.message}`;
    process.stderr.write(`send-logs-hook: ${msg}\n`);
    hookLog(HOOK_FILE, sessionId, 'error', msg, cwd);
    // Leaving the temp behind would accumulate one file per failed write, and it is never read.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // never existed, or already gone
    }
  }
}

// ---------------------------------------------------------------------------
// MCP probe helpers
// ---------------------------------------------------------------------------
//
// The static catalog/agents/systemContext/MCP-config builders that used to live here
// (`buildClaudeMdContext`, `buildAgentDefinitions`, `extractMcpServers`, the static half of
// `buildMcpConfig`) moved to `harness-snapshot.js` (`buildHarnessSnapshot`) per DD-1–DD-3 of the
// `2026-10-16-sysctx-skill-source` plan. Only the live MCP probe stays here: DD-7 runs it at most
// once per run, and only when the computed `snapshotId` turns out unknown.

/**
 * On Windows, a bare/extensionless command (e.g. `npx`) or one resolving to a `.cmd`/`.bat`/
 * `.ps1` batch file needs `shell: true` to launch at all — Node's non-shell spawn does not
 * consult `PATHEXT` itself (a bare `npx` throws `ENOENT`, never finding the real `npx.cmd`),
 * and Windows refuses to exec a batch file directly even when given its exact path (`.cmd`
 * throws `EINVAL`). Both are silent to the caller here — they surface only as the child's
 * async `error` event, which this probe already treats as "disconnected", not a thrown
 * exception. A command that already resolves to a real executable (`.exe`, or an absolute
 * path with no extension to spawn's liking) does not need — and must not get — the shell:
 * shell-mode command-line building does not itself quote `command`, so a full path
 * containing spaces (e.g. `C:\Program Files\nodejs\node.exe`) breaks under it.
 */
function needsWindowsShell(command) {
  if (process.platform !== 'win32' || typeof command !== 'string') return false;
  const ext = path.extname(command).toLowerCase();
  return ext === '' || ext === '.cmd' || ext === '.bat' || ext === '.ps1';
}

/**
 * Probe one stdio-transport MCP server: spawn `cfg.command` with `cfg.args`, send a JSON-RPC
 * `initialize` request followed by `tools/list` over its stdin (newline-delimited JSON, per the
 * MCP stdio transport spec), and resolve once a matching `tools/list` response arrives or
 * `timeoutMs` elapses — whichever comes first.
 *
 * Fail-open, always: a spawn failure, a timeout, or a malformed/unexpected response all resolve
 * `{connected: false, tools: []}` rather than throwing or rejecting — a broken/slow MCP server
 * must never fail the Stop-hook upload it happens to ride along with.
 *
 * @param {string} name - server name; used only for parity with the per-server call site (not
 *   sent over the wire).
 * @param {{command?: string, args?: string[]}} cfg - raw (unscrubbed) server config; only
 *   `command`/`args` are used, so a caller may pass the same object it read from disk.
 * @param {number} timeoutMs
 * @param {{sessionId?: string|null}} [markerMeta] - provenance stamped into the probe child's
 *   environment (`process-marker.js`). Optional so older call sites keep working unchanged.
 * @returns {Promise<{connected: boolean, tools: Array<{name: string, schemaSizeTokens: number}>}>}
 */
function probeMcpServerTools(name, cfg, timeoutMs, markerMeta = {}) {
  const INITIALIZE_ID = 1;
  const TOOLS_LIST_ID = 2;

  return new Promise((resolve) => {
    let settled = false;
    let child = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // killProcessTree, not child.kill(): with `shell: true` on Windows `child` is the `cmd.exe`
      // wrapper and the server itself is its grandchild, so killing the child alone orphans a
      // live MCP server that then survives until reboot. Six such orphans (up to five days old)
      // were found on the dev machine before this change.
      killProcessTree(child);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ connected: false, tools: [] }), timeoutMs);

    try {
      child = spawn(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        shell: needsWindowsShell(cfg.command),
        env: Object.assign(
          {},
          process.env,
          buildProcessMarkerEnv(`mcp-probe:${name}`, {
            sessionId: markerMeta.sessionId || null,
            hookFile: HOOK_FILE,
            hookVersion: getHookVersion(),
          }),
        ),
      });
    } catch {
      finish({ connected: false, tools: [] });
      return;
    }

    child.on('error', () => finish({ connected: false, tools: [] }));

    let buffer = '';
    let toolsListSent = false;

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        newlineIdx = buffer.indexOf('\n');
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not a JSON-RPC line (e.g. stray server log line on stdout) — skip it
        }
        if (!msg || typeof msg !== 'object') continue;

        if (msg.id === INITIALIZE_ID && !toolsListSent) {
          toolsListSent = true;
          try {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify({
              jsonrpc: '2.0', id: TOOLS_LIST_ID, method: 'tools/list', params: {},
            }) + '\n');
          } catch {
            finish({ connected: false, tools: [] });
          }
          continue;
        }

        if (msg.id === TOOLS_LIST_ID) {
          const rawTools = msg.result && Array.isArray(msg.result.tools) ? msg.result.tools : [];
          const tools = rawTools
            .filter((t) => t && typeof t.name === 'string')
            .map((t) => ({
              name: t.name,
              schemaSizeTokens: Math.round(
                JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length
                / MCP_SCHEMA_CHARS_PER_TOKEN,
              ),
            }));
          finish({ connected: true, tools });
          return;
        }
      }
    });

    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: INITIALIZE_ID,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'artisyn-log-hub-mcp-probe', version: '1.0.0' },
        },
      }) + '\n');
    } catch {
      finish({ connected: false, tools: [] });
    }
  });
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
 * the same project (no new lock).
 *
 * Fail-open throughout: a missing/unreadable directory prunes nothing, and each unlink is
 * individually try/catched so one locked file (a Windows anti-virus scan, an editor
 * holding a handle) cannot abort the sweep.
 *
 * Chunks listed in `failedPaths` are never deleted either: their upload failed
 * in this very run, so expiring them now would turn a transient server outage that happened to
 * coincide with the retention cutoff into silent data loss. They are reconsidered next run.
 *
 * @param {string} otelDir
 * @param {number} retentionDays
 * @param {string|null} hookSessionId
 * @param {string|null} cwd - project dir, so an unlink failure can be surfaced in hook.log
 * @param {Set<string>} [failedPaths] - absolute chunk paths whose upload failed this run
 * @returns {{ deleted: number, failed: number, kept: number }}
 */
function pruneOtelDir(otelDir, retentionDays, hookSessionId, cwd, failedPaths = new Set()) {
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
      const failedThisRun = isChunk && failedPaths.has(filePath);
      const shouldDelete = isTemp ? abandonedTemp : !isCurrent && !failedThisRun && (expired || empty);
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

/**
 * Parse the `--otel-sweep --cwd <dir>` invocation the OTEL receiver uses to ship its telemetry tail
 * (see `spawnOtelSweep()` in otel-receiver.js). Returns null for every other invocation, including
 * the normal hook one, which carries no arguments at all.
 *
 * @param {string[]} argv - `process.argv`
 * @returns {{ cwd: string|null }|null}
 */
function parseOtelSweepArgs(argv) {
  const args = argv.slice(2);
  if (!args.includes('--otel-sweep')) return null;
  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx >= 0 && typeof args[cwdIdx + 1] === 'string' && args[cwdIdx + 1] && !args[cwdIdx + 1].startsWith('--')
    ? args[cwdIdx + 1]
    : null;
  return { cwd };
}

/**
 * Upload one OTEL chunk and delete it on success — the same read → sanitize → upload → unlink path
 * `runUpload()` applies to a `claude-otel` entry, minus everything manifest-related.
 *
 * @returns {Promise<{ success: boolean, reason: string|null }>}
 */
async function uploadOtelChunkNoManifest(chunk, serverUrl, apiKey, timeoutMs, cwd, telemetryDir) {
  const { sessionId, name, filePath } = chunk;
  const manifestKey = `claude-otel/${sessionId}/${name}`;

  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch (err) {
    hookLog(HOOK_FILE, null, 'fail', `${manifestKey}: cannot read file: ${err.message}`, cwd);
    return { success: false, reason: `cannot read file: ${err.message}` };
  }

  const sanitized = sanitizeNdjson(body);
  for (const msg of formatDroppedLines(manifestKey, sanitized)) {
    hookLog(HOOK_FILE, null, 'warn', msg, cwd);
  }
  body = sanitized.body;
  if (sanitized.dropped.length > 0 && body.length === 0) {
    const reason = 'no valid JSON lines left after sanitizing';
    hookLog(HOOK_FILE, null, 'fail', `${manifestKey}: ${reason}`, cwd);
    return { success: false, reason };
  }

  const bodyBytes = Buffer.byteLength(body);
  const result = bodyBytes > CHUNK_SIZE_BYTES
    ? await uploadFileChunked(serverUrl, apiKey, 'claude-otel', sessionId, body, timeoutMs, null, cwd, null, null, telemetryDir, manifestKey)
    : await uploadFileMaybeCompressed(serverUrl, apiKey, 'claude-otel', sessionId, body, timeoutMs, null, cwd, null, null);

  if (!result.success) {
    hookLog(HOOK_FILE, null, 'fail', `${manifestKey}: ${result.reason}`, cwd);
    return { success: false, reason: result.reason };
  }

  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    // Left on disk: the next Stop run re-uploads it (the server upsert is idempotent) and then
    // deletes or fingerprints it; the retention prune is the final fallback.
    hookLog(HOOK_FILE, null, 'warn', `otel chunk uploaded but not deleted (${manifestKey}): ${err.message}`, cwd);
  }
  hookLog(HOOK_FILE, null, 'result', formatUploadResultLine(manifestKey, result), cwd);
  return { success: true, reason: null };
}

/**
 * `--otel-sweep` mode: ship the OTEL chunks the receiver wrote after the
 * session's last `Stop`, so the telemetry tail of a session is not stranded until the next session
 * in this project runs.
 *
 * Spawned detached by the receiver once a minute of quiet passes with chunks on disk, and once more
 * on idle exit. Deliberately minimal: no manifest read or write, no otel prune, no receiver re-arm,
 * no other namespace. It takes the project's upload lock with the short `Stop` budget; a busy lock
 * means a real upload run is already in progress (and will ship these chunks), so it just exits —
 * the receiver retries on its next quiet tick anyway.
 *
 * @param {string|null} cwd - the project's git root, passed by the receiver as `--cwd`
 */
async function runOtelSweep(cwd) {
  if (!cwd) {
    hookLog(HOOK_FILE, null, 'result', 'otel-sweep: exit, no --cwd given', null);
    process.exit(0);
  }

  const config = loadConfig(cwd);
  const serverUrl = (config.serverUrl || '').trim().replace(/\/$/, '');
  const apiKey = (config.apiKey || '').trim();
  if (!serverUrl || !apiKey) {
    process.exit(0); // quiet: an unconfigured project is not an error for a background sweep
  }

  const telemetryDir = resolveTelemetryDir(cwd, config);
  const lockResult = await acquireUploadLockWithWait(
    telemetryDir, 2 * config.sendLogsOnPromptTimeoutMs, LOCK_WAIT_STOP_MS, LOCK_POLL_INTERVAL_MS);
  if (!lockResult.acquired) {
    hookLog(HOOK_FILE, null, 'result',
      `otel-sweep: skipped, upload lock held (waited ${lockResult.waitedMs}ms)`, cwd);
    process.exit(0);
  }

  let uploaded = 0;
  let failed = 0;
  let total = 0;
  try {
    const otelDir = resolveOtelDir(cwd, config);
    // Write order, exactly as the Stop path ships them (see `listOtelChunks`).
    const chunks = listOtelChunks(otelDir);
    total = chunks.length;
    for (const chunk of chunks) {
      const { success } = await uploadOtelChunkNoManifest(
        chunk, serverUrl, apiKey, config.sendLogsTimeoutMs, cwd, telemetryDir);
      if (success) uploaded++;
      else failed++;
    }
  } finally {
    releaseUploadLock(telemetryDir);
  }

  hookLog(HOOK_FILE, null, 'result',
    `otel-sweep done: uploaded=${uploaded} failed=${failed} total=${total}`
    + ` target=${formatServerOrigin(serverUrl)}`, cwd);
  process.exit(0);
}

async function main() {
  // `--otel-sweep` is a receiver-spawned background run with no hook payload on stdin — branch
  // before the stdin read so it never blocks on, or misparses, an absent payload.
  const sweepArgs = parseOtelSweepArgs(process.argv);
  if (sweepArgs) {
    await runOtelSweep(sweepArgs.cwd);
    return;
  }

  // Read stdin
  let input = {};
  if (!process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync(process.stdin.fd, 'utf8');
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      // Exit here rather than falling through with `input = {}`: every main() path must write
      // exactly one hook.log line, and falling through would emit a second one at the event guard
      // below. `cwd` is unknowable when the payload did not parse, so the log dir is resolved from
      // process.cwd() — the same resolution hookLog itself will use for this line.
      hookLog(HOOK_FILE, null, 'warn',
        `exit: stdin unreadable or not JSON: ${err.message} (logDir=${getWorkDirPath(null)})`, null);
      process.exit(0);
    }
  }

  const cwd = input.cwd || null;
  const hookSessionId = input.session_id || null;
  // The directory hookLog writes into (hook-log.js resolves it exactly the same way). Naming it on
  // every main() line is what distinguishes "the hook never ran" from "its lines went to another
  // repo's hook.log" when a payload cwd resolves to an unexpected git root.
  const logDir = getWorkDirPath(cwd);

  const hookEvent = input.hook_event_name;
  if (hookEvent !== 'Stop' && hookEvent !== 'SessionEnd') {
    // Previously a silent `process.exit(0)`, which made "this script produced no hook.log lines
    // at all" indistinguishable from a crash on require or a hook that never fired.
    hookLog(HOOK_FILE, hookSessionId, 'result',
      `exit: hook_event_name=${hookEvent || '<none>'} is not Stop/SessionEnd (logDir=${logDir})`, cwd);
    process.exit(0);
  }

  hookLog(HOOK_FILE, hookSessionId, 'activate', `${hookEvent} event received (logDir=${logDir})`, cwd);

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
  await maybeReArmOtelSession(config, hookSessionId, cwd, null, HOOK_FILE);

  const serverUrl = (config.serverUrl || '').trim().replace(/\/$/, '');
  const apiKey = (config.apiKey || '').trim();
  const timeoutMs = config.sendLogsTimeoutMs;

  if (!serverUrl || !apiKey) {
    hookLog(HOOK_FILE, hookSessionId, 'result',
      `exit: serverUrl or apiKey not configured (logDir=${logDir})`, cwd);
    process.exit(0);
  }

  const telemetryDir = resolveTelemetryDir(cwd, config);

  // A `Stop` run blocks the interactive turn ("Uploading logs..."), so it waits only briefly for a
  // contending run and otherwise defers to the next trigger. `SessionEnd` is this session's last
  // trigger — nothing downstream will retry it — so it waits long enough to outlast a typical
  // contending `Stop` catch-up run rather than stranding the session's own files.
  const isSessionEnd = hookEvent === 'SessionEnd';
  const lockWaitMs = isSessionEnd ? LOCK_WAIT_SESSION_END_MS : LOCK_WAIT_STOP_MS;

  const lockResult = await acquireUploadLockWithWait(
    telemetryDir, 2 * config.sendLogsOnPromptTimeoutMs, lockWaitMs, LOCK_POLL_INTERVAL_MS);
  if (!lockResult.acquired) {
    hookLog(HOOK_FILE, hookSessionId, 'result',
      `skipped: upload lock held (waited ${lockResult.waitedMs}ms)`, cwd);
    process.exit(0);
  }

  try {
    if (isSessionEnd) {
      await runSessionEndFlush(cwd, hookSessionId, serverUrl, apiKey, timeoutMs, telemetryDir);
    } else {
      await runUpload(cwd, hookSessionId, serverUrl, apiKey, timeoutMs, telemetryDir, config);
    }
  } finally {
    releaseUploadLock(telemetryDir);
  }
  process.exit(0);
}

/**
 * Format the `hook.log` `result` message for a successful upload.
 *
 * Reports both counts — what the file weighs and what actually crossed the wire — so a slow upload
 * can be attributed to size vs. request count without re-running anything. An upload that had to
 * fall back to plain after the peer rejected a gzipped body is marked, since that is the one case
 * where the wire cost is higher than this hook version normally produces.
 *
 * @param {string} manifestKey
 * @param {{ wireBytes: number, plainBytes: number, requests: number, fallback: boolean }} result
 *   the reporting fields returned by `uploadFileMaybeCompressed()` / `uploadFileChunked()`
 * @returns {string}
 */
function formatUploadResultLine(manifestKey, result) {
  const { wireBytes, plainBytes, requests, fallback } = result;
  const kb = (bytes) => (bytes / 1024).toFixed(0);
  const reqs = `${requests} request${requests === 1 ? '' : 's'}`;
  const suffix = fallback ? ' [gzip fallback]' : '';
  const compressed = wireBytes > 0 && wireBytes < plainBytes;
  return compressed
    ? `${manifestKey}: uploaded ${kb(plainBytes)} KB → ${kb(wireBytes)} KB gz`
      + ` (${(plainBytes / wireBytes).toFixed(1)}x) in ${reqs}${suffix}`
    : `${manifestKey}: uploaded ${kb(plainBytes)} KB uncompressed in ${reqs}${suffix}`;
}

/**
 * The `SessionEnd` flush — upload just this session's own `artisyn` and `claude` files, plus its
 * `tool-calls` upload when the CLI tool wrapper recorded anything (`collectScopedFiles`).
 *
 * Deliberately *not* the full `runUpload()` scan: this fires as the session is tearing down, so it
 * must stay short and bounded. The full multi-session scan, manifest bookkeeping, context-injection
 * prepends, `hook-status` reporting and otel prune all stay on the `Stop` path.
 *
 * Like `prompt-upload-hook.js` this writes no `.claude-logs.sent` entry: the manifest
 * records what a *full* run has shipped, and a scoped flush that wrote to it would make the next
 * full run skip a file it never really processed. The server's upsert is idempotent, so the overlap
 * is free.
 *
 * @param {string|null} cwd
 * @param {string} sessionId
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {number} timeoutMs
 * @param {string} telemetryDir
 */
async function runSessionEndFlush(cwd, sessionId, serverUrl, apiKey, timeoutMs, telemetryDir) {
  if (!sessionId) {
    hookLog(HOOK_FILE, null, 'result', 'session-end flush: skipped, no session_id in payload', cwd);
    return;
  }

  const files = collectScopedFiles(cwd, sessionId, telemetryDir);
  let uploaded = 0;
  let failed = 0;

  for (const { namespace, filePath } of files) {
    const manifestKey = `${namespace}/${path.basename(filePath)}`;

    let body;
    try {
      body = fs.readFileSync(filePath);
    } catch (err) {
      failed++;
      hookLog(HOOK_FILE, sessionId, 'fail', `${manifestKey}: cannot read file: ${err.message}`, cwd);
      continue;
    }

    const bodyBytes = Buffer.byteLength(body);
    const { success, reason } = bodyBytes > CHUNK_SIZE_BYTES
      ? await uploadFileChunked(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, sessionId, cwd, null, null, telemetryDir, manifestKey)
      : await uploadFile(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, sessionId, cwd, null, null);

    if (success) {
      uploaded++;
      hookLog(HOOK_FILE, sessionId, 'result', `${manifestKey}: uploaded ${(bodyBytes / 1024).toFixed(0)} KB`, cwd);
    } else {
      failed++;
      hookLog(HOOK_FILE, sessionId, 'fail', `${manifestKey}: ${reason}`, cwd);
    }
  }

  hookLog(HOOK_FILE, sessionId, 'result',
    `session-end flush done: uploaded=${uploaded} failed=${failed} total=${files.length}`
    + ` target=${formatServerOrigin(serverUrl)}`, cwd);
}

/**
 * The full Stop upload run — file scanning, manifest, upload loop, and hook-status
 * reporting. Split out from `main()` so the shared-lock acquire/release can
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

  /**
   * Namespaces whose root was enumerated successfully this run, and whose manifest entries may
   * therefore be pruned against what the scan found (see `pruneManifest()`).
   *
   * This gate is the whole safety of pruning. Pruning is a set difference — "manifest keys the scan
   * did not see" — so a namespace whose root failed to resolve would look completely empty and take
   * every one of its entries with it, re-uploading thousands of files on the next run. A namespace
   * is only added here once its root has actually been read.
   * @type {Set<string>}
   */
  const prunableNamespaces = new Set();

  if (fs.existsSync(telemetryDir)) {
    prunableNamespaces.add('artisyn');
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
  const claudeProjectsDir = path.join(claudeConfigDir(), 'projects');

  if (fs.existsSync(claudeProjectsDir)) {
    // Find all project slug dirs that belong to this git repo (shared with session-files.js):
    //   • the exact root-project slug
    //   • any slug that starts with root-slug + '-' (subdirectory projects, e.g. root/dist) —
    //     `prefixOnly`, so each transcript in it is kept only when its recorded cwd is inside the
    //     git root (or it records none); an unrelated sibling such as root-other is skipped
    // Fallback: locate by current session ID when the slug match finds nothing.
    const gitRoot = getGitRoot(cwd || process.cwd());
    let projectSlugDirs = [];
    try {
      projectSlugDirs = findProjectSlugDirs(claudeProjectsDir, gitRoot, hookSessionId);
    } catch {
      // skip
    }

    if (projectSlugDirs.length > 0) {
      // Both namespaces come from these directories, so one successful resolve makes both safe to
      // prune. Zero resolved dirs means "could not find this repo's Claude projects folder", which
      // must never be read as "this repo has no claude logs".
      prunableNamespaces.add('claude');
      prunableNamespaces.add('claude-subagent');
    }

    for (const { dir: projectSlugDir, prefixOnly } of projectSlugDirs) {
      // Prefix-only folders: decide per session from its main transcript's cwd (memoised so the
      // subagent files below reuse it); a session dir with no main transcript falls back to each
      // subagent file's own cwd.
      const sessionKept = new Map();
      const keepSession = (sessionName, fallbackFilePath) => {
        if (!prefixOnly) return true;
        if (sessionKept.has(sessionName)) return sessionKept.get(sessionName);
        const mainTranscript = path.join(projectSlugDir, `${sessionName}.jsonl`);
        if (fs.existsSync(mainTranscript)) {
          const kept = transcriptBelongsToRepo(mainTranscript, gitRoot);
          sessionKept.set(sessionName, kept);
          return kept;
        }
        return transcriptBelongsToRepo(fallbackFilePath, gitRoot);
      };

      // Main session files
      const claudeFiles = listJsonlFiles(projectSlugDir);
      for (const { name, size } of claudeFiles) {
        const sessionId = name.slice(0, -'.jsonl'.length);
        if (!keepSession(sessionId, path.join(projectSlugDir, name))) continue;
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
          if (!keepSession(sessionDir.name, path.join(subagentsDir, name))) continue;
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
              if (!keepSession(sessionDir.name, path.join(workflowsSubdir, wfDir.name, wfName))) continue;
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
  // writer — so every chunk in it is collected unfiltered: no ownership
  // check, no adoption, no watermark, no tenancy guard.
  //
  // Layout is <otelDir>/<sessionId>/<epochMs>-<seq>.jsonl, one file per inbound OTLP request.
  // Chunks are shipped in write order: the basename starts with a fixed-width epoch-ms stamp and
  // a zero-padded sequence, so a plain lexicographic sort across every session equals time order.
  if (config && config.otelEnabled) {
    const otelDir = resolveOtelDir(cwd, config);
    if (fs.existsSync(otelDir)) prunableNamespaces.add('claude-otel');
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
  // §2.4 CLI tool-wrap call records (`tool-calls`)
  // -------------------------------------------------------------------------
  // <workDir>/tool-wrap/<sessionId>/ holds the per-call files the CLI tool wrapper wrote
  // (tool-wrap-records.js). Each session is assembled into one NDJSON file and uploaded as log kind
  // `tool-calls`; the server keeps one such log per session, so every upload re-sends the whole set.
  // The manifest "size" of `tool-calls/<sessionId>` is a fingerprint of the source files, so an
  // unchanged session is skipped without being assembled again. An old server stores the upload as
  // an inert generic log. Fail-open: a failure here never affects the other namespaces.
  try {
    const toolWrapRecords = require('./tool-wrap-records');
    const twWorkDir = getWorkDirPath(cwd);
    const twSessions = toolWrapRecords.listToolWrapSessionsChecked(twWorkDir);
    if (twSessions !== null) {
      prunableNamespaces.add('tool-calls');
      for (const sessionId of twSessions) {
        const size = toolWrapRecords.toolCallsSourceSize(twWorkDir, sessionId);
        if (size === 0) continue;
        const manifestKey = `tool-calls/${sessionId}`;
        const filePath = manifest.get(manifestKey) === size
          ? toolWrapRecords.uploadFilePath(twWorkDir, sessionId)
          : toolWrapRecords.assembleToolCallsUpload(twWorkDir, sessionId);
        if (!filePath) continue;
        filesToProcess.push({
          namespace: 'tool-calls',
          sessionId,
          filePath,
          size,
          manifestKey,
          isCurrentSession: hookSessionId !== null && sessionId === hookSessionId,
        });
      }
      toolWrapRecords.pruneUploadFiles(twWorkDir);
    }
  } catch (err) {
    hookLog(HOOK_FILE, hookSessionId, 'warn',
      `tool-calls: collection skipped (${err && err.message ? err.message : String(err)})`, cwd);
  }

  // -------------------------------------------------------------------------
  // Upload loop
  // -------------------------------------------------------------------------
  let uploadedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  // Manifest write batching. `writeManifest()` serialises and rewrites the WHOLE map, which on
  // this repo is 37,469 entries / 3.0 MB — doing that after every single uploaded file made the
  // per-file cost scale with total history rather than with the file being uploaded.
  //
  // Batched, not deferred to the end: a run that dies mid-way (hook timeout, machine sleep) must
  // still keep credit for what it already shipped, or the next run re-uploads from the top and a
  // large backlog can never converge. The bound is whichever comes first — `MANIFEST_FLUSH_EVERY`
  // new entries or `MANIFEST_FLUSH_INTERVAL_MS` since the last write — so the worst case lost on
  // a hard kill is a bounded number of redundant re-uploads, never a skipped upload (the
  // fingerprint is written only after a successful upload either way).
  let manifestDirtyCount = 0;
  let manifestLastFlushMs = Date.now();

  /**
   * Drop manifest entries whose file is gone, so the store stays bounded.
   *
   * Files really do disappear: `claude-otel` chunks are now deleted the moment they upload, the
   * retention job deletes expired ones, and users delete old `~/.claude/projects/<slug>/*.jsonl`
   * transcripts. Without this the manifest only ever grows, and since every write rewrites the whole
   * map, dead entries cost time on every single run forever.
   *
   * Implemented as a set difference against what this run's scan actually found, gated on
   * `prunableNamespaces` — a namespace whose root failed to resolve is skipped entirely rather than
   * having all its entries dropped. Entries in an unknown namespace (e.g. written by a future hook
   * version, or the legacy `otel/` prefix) are always kept: this must never delete something it does
   * not understand.
   *
   * @param {Set<string>} seenKeys - every manifestKey the scan saw on disk
   * @returns {number} entries removed
   */
  function pruneManifest(seenKeys) {
    let removed = 0;
    for (const key of Array.from(manifest.keys())) {
      if (seenKeys.has(key)) continue;
      const slashIdx = key.indexOf('/');
      if (slashIdx <= 0) continue; // malformed key — leave it alone
      const namespace = key.slice(0, slashIdx);
      if (!prunableNamespaces.has(namespace)) continue;
      manifest.delete(key);
      removed++;
    }
    return removed;
  }

  /** @param {boolean} force - true at the end of the run, to write whatever is still pending */
  function flushManifest(force) {
    if (!force) {
      manifestDirtyCount++;
      const dueByCount = manifestDirtyCount >= MANIFEST_FLUSH_EVERY;
      const dueByTime = Date.now() - manifestLastFlushMs >= MANIFEST_FLUSH_INTERVAL_MS;
      if (!dueByCount && !dueByTime) return;
    } else if (manifestDirtyCount === 0) {
      return;
    }
    writeManifest(telemetryDir, manifestPath, manifest, hookSessionId, cwd);
    manifestDirtyCount = 0;
    manifestLastFlushMs = Date.now();
  }

  /**
   * The harness-snapshot prepends (`harness-snapshot-ref`, plus `harness-snapshot` when the id is
   * unknown) — built at most ONCE PER RUN and attached to at most ONE upload per SESSION: the
   * current session's own artisyn body (DD-7 of the `2026-10-16-sysctx-skill-source` plan).
   *
   * Two separate limits, for two separate costs:
   *
   * 1. Once per run, lazily. The MCP probe (`probeMcpServerTools`) spawns every stdio MCP server
   *    and waits for a JSON-RPC `initialize` + `tools/list` handshake, sequentially, bounded by
   *    `mcpProbeTimeoutMs` each — measured at 4,690 ms for 4 servers under the old once-per-run
   *    scheme this replaces. `getHarnessPrefix()` memoises its result so the probe never runs
   *    twice in one run, and DD-7 step 2 skips it entirely when the snapshot id is already known
   *    (`harness-state.json`'s `knownSnapshotIds`).
   * 2. Once per session, and only on the CURRENT session's `artisyn` body. `harness-snapshot`
   *    describes the harness, not the session, and the server stores it once per (user, id) and
   *    upserts `harness_elements` per REPOSITORY — prepending the full body to every file would
   *    repeat the same bytes across a whole backlog for one identical upsert.
   *
   * `snapshotQuery` is threaded into `uploadFile`/`uploadFileChunked` (DD-7 step 6) so the server
   * can answer `unknownSnapshotId` (DD-8); `commitHarnessReport()` is what
   * `rememberSnapshot`/`forgetSnapshot`/`recordSessionSnapshot` key off, after the upload that
   * carried `harnessPrefix` actually succeeded.
   */
  const workDir = getWorkDirPath(cwd);

  /** The snapshot id `getHarnessPrefix()` computed this run, or null until it has run. */
  let resolvedSnapshotId = null;
  /** True once `getHarnessPrefix()` decided the id was unknown and shipped the full body. */
  let sentFullSnapshot = false;
  /**
   * Query params for the current-session artisyn upload: the harness pair (set by
   * `getHarnessPrefix()`) plus the OKF pair (set by `getOkfPrefix()`).
   * @type {{ snapshotId?: string, snapshotFull?: boolean, okfSnapshotId?: string, okfSnapshotFull?: boolean }|null}
   */
  let snapshotQuery = null;
  /** @type {Buffer|null} */
  let harnessPrefix = null;

  /** The OKF snapshot id `getOkfPrefix()` computed this run, or null (not run, or no snapshot). */
  let resolvedOkfSnapshotId = null;
  /** True once `getOkfPrefix()` decided the OKF id was unknown and shipped the full body. */
  let sentFullOkfSnapshot = false;
  /** @type {Buffer|null} */
  let okfPrefix = null;

  // The code-inventory prepend — its own throttle, its own state file, its own commit point.
  /** @type {Buffer|null} */
  let codeInventoryPrefix = null;
  /** Repo root the pending snapshot was measured for; the state file's key. @type {string|null} */
  let codeInventoryRoot = null;
  let codeInventoryPending = false;

  /**
   * Build the harness-snapshot prefix for the current session's artisyn body (DD-7 steps 1–4),
   * or an empty buffer when there is no current session to pin it to. Memoised, so the static
   * build and the MCP probe each run at most once per run.
   * @returns {Promise<Buffer>}
   */
  async function getHarnessPrefix() {
    if (harnessPrefix) return harnessPrefix;
    if (hookSessionId === null) {
      harnessPrefix = Buffer.alloc(0);
      return harnessPrefix;
    }

    // Resolve the true repo root: cwd is often a monorepo subdirectory (e.g. `client/`), whose
    // own .claude/skills, .claude/agents and .mcp.json don't exist, so scanning raw cwd silently
    // misses every project-level skill/agent/MCP definition that actually lives at the repo root.
    const projectRoot = getGitRoot(cwd || process.cwd());
    const snapshot = buildHarnessSnapshot({
      projectRoot,
      cwd,
      env: process.env,
      log: (line) => hookLog(HOOK_FILE, hookSessionId, 'result', line, cwd),
    });
    resolvedSnapshotId = snapshot.snapshotId;

    const parts = [
      Buffer.from(JSON.stringify({ type: 'harness-snapshot-ref', snapshotId: snapshot.snapshotId }) + '\n', 'utf8'),
    ];

    if (readKnownSnapshots(workDir).includes(snapshot.snapshotId)) {
      // DD-7 step 2: already known — ship only the cheap ref, never probe.
      snapshotQuery = { snapshotId: snapshot.snapshotId, snapshotFull: false };
      harnessPrefix = Buffer.concat(parts);
      return harnessPrefix;
    }

    // DD-7 step 3: unknown — probe every stdio-transport MCP server, sequentially (bounded total
    // latency by `mcpProbeTimeoutMs × serverCount`), before shipping the full body.
    const mcpServers = [];
    for (const entry of snapshot.mcpServers) {
      const rawCfg = snapshot.rawConfigByName.get(entry.name);
      const hasCommand = !!(rawCfg && typeof rawCfg.command === 'string' && rawCfg.command.trim());
      if (!hasCommand) {
        mcpServers.push(entry); // url/SSE-based server — out of scope for the probe, left undefined
        continue;
      }
      const { connected, tools } = await probeMcpServerTools(
        entry.name, rawCfg, config.mcpProbeTimeoutMs, { sessionId: hookSessionId },
      );
      mcpServers.push({ ...entry, connected, tools });
    }

    parts.push(Buffer.from(JSON.stringify({
      type: 'harness-snapshot',
      snapshotId: snapshot.snapshotId,
      schemaVersion: HARNESS_SNAPSHOT_SCHEMA_VERSION,
      // perToolDetailSupported: true is the capability flag — its presence, not the hookVersion
      // string, is what lets the server tell "old hook, per-tool detail never attempted" apart
      // from "capable hook, this server had zero tools / failed to connect".
      perToolDetailSupported: true,
      skills: snapshot.skills,
      agents: snapshot.agents || [],
      mcpServers,
      systemContext: snapshot.systemContext,
    }) + '\n', 'utf8'));

    sentFullSnapshot = true;
    snapshotQuery = { snapshotId: snapshot.snapshotId, snapshotFull: true };
    harnessPrefix = Buffer.concat(parts);
    return harnessPrefix;
  }

  /**
   * Record the outcome of the current-session artisyn upload that just carried `getHarnessPrefix()`
   * (DD-7/DD-19), after that upload succeeded — same commit-after-success rule the manifest uses,
   * so a failed upload is retried by the next run instead of being silently marked as delivered.
   * @param {string|undefined} unknownSnapshotId - from the server's response (DD-8).
   */
  function commitHarnessReport(unknownSnapshotId) {
    if (resolvedSnapshotId === null) return;
    const id12 = resolvedSnapshotId.slice(0, 12);

    if (unknownSnapshotId === resolvedSnapshotId) {
      // DD-21's self-heal: a purge raced the controller's "known" answer. Forget it so the next
      // upload of this session resends the full body.
      forgetSnapshot(workDir, resolvedSnapshotId);
      hookLog(HOOK_FILE, hookSessionId, 'result', `harness: snapshot ${id12} unknown on server — will resend`, cwd);
    } else if (sentFullSnapshot) {
      rememberSnapshot(workDir, resolvedSnapshotId);
      hookLog(HOOK_FILE, hookSessionId, 'result', `harness: snapshot ${id12} sent`, cwd);
    } else {
      hookLog(HOOK_FILE, hookSessionId, 'result', `harness: snapshot ${id12} known`, cwd);
    }

    // DD-19: always recorded, regardless of the outcome above, so prompt-upload-hook.js's fast
    // path can prepend this session's ref without recomputing anything.
    if (hookSessionId !== null) {
      recordSessionSnapshot(workDir, hookSessionId, resolvedSnapshotId);
    }
  }

  /**
   * The OKF snapshot prepend for the current session's artisyn body (plan
   * `2026-10-27-okf-usage-tab`, DD-20): always the `okf-snapshot-ref` line, plus the full
   * `okf-snapshot` line when `okf-state.json` does not list the id yet. Detection runs only here,
   * at upload, never at SessionStart. Memoised per run.
   *
   * Fail-open: any failure (detection, git, state) is logged and yields an empty buffer, so the
   * upload goes out without OKF lines — OKF can never fail an upload.
   * @returns {Buffer}
   */
  function getOkfPrefix() {
    if (okfPrefix) return okfPrefix;
    okfPrefix = Buffer.alloc(0);
    if (hookSessionId === null) return okfPrefix;
    const log = (line) => hookLog(HOOK_FILE, hookSessionId, 'result', line, cwd);
    try {
      const projectRoot = getGitRoot(cwd || process.cwd());
      const snapshot = buildOkfSnapshot({ projectRoot, config, log, workDir });
      if (!snapshot) return okfPrefix;

      const id = snapshot.okfSnapshotId;
      const parts = [Buffer.from(JSON.stringify(buildOkfSnapshotRef(id)) + '\n', 'utf8')];
      const known = readKnownOkfSnapshots(workDir).includes(id);
      if (!known) parts.push(Buffer.from(JSON.stringify(snapshot) + '\n', 'utf8'));

      resolvedOkfSnapshotId = id;
      sentFullOkfSnapshot = !known;
      snapshotQuery = { ...(snapshotQuery || {}), okfSnapshotId: id, okfSnapshotFull: !known };
      okfPrefix = Buffer.concat(parts);
    } catch (err) {
      hookLog(HOOK_FILE, hookSessionId, 'warn',
        `okf: snapshot skipped (${err && err.message ? err.message : String(err)})`, cwd);
      resolvedOkfSnapshotId = null;
      sentFullOkfSnapshot = false;
      okfPrefix = Buffer.alloc(0);
    }
    return okfPrefix;
  }

  /**
   * Record the OKF outcome after the upload that carried `getOkfPrefix()` succeeded (DD-20):
   * forget the id when the server echoed it as `unknownOkfSnapshotId` (next upload resends the full
   * body), remember it when the full body was sent. Never throws.
   * @param {string|undefined} unknownOkfSnapshotId
   */
  function commitOkfReport(unknownOkfSnapshotId) {
    if (resolvedOkfSnapshotId === null) return;
    try {
      const id12 = resolvedOkfSnapshotId.slice(0, 12);
      if (unknownOkfSnapshotId === resolvedOkfSnapshotId) {
        forgetOkfSnapshot(workDir, resolvedOkfSnapshotId);
        hookLog(HOOK_FILE, hookSessionId, 'result', `okf: snapshot ${id12} unknown on server — will resend`, cwd);
      } else if (sentFullOkfSnapshot) {
        rememberOkfSnapshot(workDir, resolvedOkfSnapshotId);
        hookLog(HOOK_FILE, hookSessionId, 'result', `okf: snapshot ${id12} sent`, cwd);
      } else {
        hookLog(HOOK_FILE, hookSessionId, 'result', `okf: snapshot ${id12} known`, cwd);
      }
    } catch (err) {
      hookLog(HOOK_FILE, hookSessionId, 'warn',
        `okf: state not updated (${err && err.message ? err.message : String(err)})`, cwd);
    }
  }

  /**
   * The `code-inventory` prepend — how big the repo's tracked codebase is, measured
   * at most once per `CODE_INVENTORY_THROTTLE_MS` per repo root.
   *
   * It is deliberately NOT hung off `getHarnessPrefix()`'s snapshot id. That id covers CLAUDE.md /
   * skills / agents / MCP config, which on a working repo almost never change, so an inventory
   * gated on it would be measured once and then go stale for weeks while the codebase it
   * describes grew — and it is a *denominator*, so a stale one silently skews every percentage
   * computed from it. A plain time window is the right gate for a measurement of something that
   * changes with every commit.
   *
   * Unlike the harness prefix there is no once-per-session rule: the throttle is the only limit,
   * and a session spanning several windows legitimately reports a fresh snapshot in each. The
   * server keeps the history and each report divides by the newest snapshot at or before its own
   * period end.
   *
   * @returns {Buffer} the NDJSON line, or an empty buffer when nothing is due
   */
  function getCodeInventoryPrefix() {
    if (codeInventoryPrefix) return codeInventoryPrefix;
    codeInventoryPrefix = Buffer.alloc(0);

    const projectRoot = getGitRoot(cwd || process.cwd());
    const state = readCodeInventoryState(workDir);
    const lastReportedAt = state[projectRoot];
    if (typeof lastReportedAt === 'number'
      && Date.now() - lastReportedAt < CODE_INVENTORY_THROTTLE_MS) {
      return codeInventoryPrefix;
    }

    const inventory = buildCodeInventory(projectRoot);
    if (inventory === null) {
      // Not a repo, no git, or (the usual case) a repo with no commits yet. Nothing is committed
      // to the state file either, so a repo that gets its first commit is measured on the next
      // run instead of waiting out a window it never reported in.
      hookLog(HOOK_FILE, hookSessionId, 'result',
        `code-inventory: not measurable at ${projectRoot} — no snapshot sent`, cwd);
      return codeInventoryPrefix;
    }

    codeInventoryRoot = projectRoot;
    codeInventoryPending = true;
    codeInventoryPrefix = Buffer.from(
      JSON.stringify({ type: 'code-inventory', projectRoot, ...inventory }) + '\n',
      'utf8',
    );
    return codeInventoryPrefix;
  }

  /**
   * Record the inventory snapshot after the upload that carried it succeeded — the same
   * commit-after-success rule `commitHarnessReport()` uses, so a failed upload is retried by the
   * next run rather than being throttled away for six hours having never arrived.
   */
  function commitCodeInventoryReport() {
    if (!codeInventoryPending || codeInventoryRoot === null) return;
    const state = readCodeInventoryState(workDir);
    state[codeInventoryRoot] = Date.now();
    const persisted = writeCodeInventoryState(workDir, state);
    codeInventoryPending = false;
    hookLog(HOOK_FILE, hookSessionId, 'result',
      `code-inventory: reported for ${codeInventoryRoot} (${codeInventoryPrefix ? codeInventoryPrefix.length : 0} bytes), `
      + `state ${persisted ? 'saved' : 'NOT saved — will re-measure on the next run'}`,
      cwd);
  }

  /**
   * Upload a single collected file: applies skip logic, artisyn-only project-context
   * prepends (+ any extraEvents), size-warns, uploads, and records manifest/hook.log
   * outcome. Shared by the main pass and the deferred current-session-artisyn pass
   * (the latter carries the hook-status event as an extra prepend).
   * @param {object} entry - one of filesToProcess
   * @param {object[]} extraEvents - extra JSON objects to prepend to an artisyn body
   * @returns {Promise<{ success: boolean, reason: string|null, warnings?: string[], unknownSnapshotId?: string,
   *   unknownOkfSnapshotId?: string }>}
   *   `unknownSnapshotId` / `unknownOkfSnapshotId` are only ever set on the current-session artisyn upload — every other
   *   call passes no `snapshotQuery`, so the server never returns the field for them.
   */
  async function processFile(entry, extraEvents) {
    const { namespace, sessionId, filePath, size, isCurrentSession, manifestKey: mkOverride, parentSessionId, workflowRunId } = entry;
    const manifestKey = mkOverride ?? `${namespace}/${path.basename(filePath)}`;

    // Skip logic. Applies to the current session's own files too — only the current-session
    // artisyn entry is exempt (see the matching guard on the manifest write below).
    if (!(isCurrentSession && namespace === 'artisyn')) {
      const recorded = manifest.get(manifestKey);
      if (recorded !== undefined && recorded === size) {
        // A `claude-otel` chunk recorded at its current size has provably been uploaded already —
        // that entry is only ever written after a successful upload. Since a chunk is immutable
        // once written, the local copy is now pure dead weight, so delete it here too, not just on
        // the upload path. Without this branch the chunks that were already uploaded by an earlier
        // hook version would never be reclaimed: they are skipped before reaching the upload code,
        // so they would sit on disk and in the manifest until retention expired them (7 days by
        // default). On this repo that was 31,748 chunks / 473 MB and 31,745 manifest entries.
        if (namespace === 'claude-otel') {
          try {
            fs.unlinkSync(filePath);
            if (manifest.delete(manifestKey)) flushManifest(false);
          } catch {
            // Locked or unreadable — leave both the file and its entry alone; the retention prune
            // is the fallback, exactly as before.
          }
        }
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
    //
    // `sanitizeNdjson()` below is the opposite of that trim, not a reintroduction of it: it drops
    // only the individual lines that do not parse, and reports every one of them to `hook.log`
    // with its line number, byte length and parse error — the corruption still surfaces, it just
    // no longer takes the whole session down with it. Applied to the file's own bytes before the
    // artisyn prepends, which are `JSON.stringify()` output and valid by construction.
    const sanitized = sanitizeNdjson(body);
    for (const msg of formatDroppedLines(manifestKey, sanitized)) {
      hookLog(HOOK_FILE, hookSessionId, 'warn', msg, cwd);
    }
    body = sanitized.body;
    if (sanitized.dropped.length > 0 && body.length === 0) {
      // Nothing survived. Report it as a failure rather than uploading only the context prepends:
      // the server would 201 that, and the session would silently look ingested but empty.
      // Gated on having actually dropped something, so a file that was already empty keeps
      // whatever behaviour it had before this check existed.
      const reason = 'no valid JSON lines left after sanitizing';
      hookLog(HOOK_FILE, hookSessionId, 'fail', `${manifestKey}: ${reason}`, cwd);
      failedCount++;
      return { success: false, reason };
    }

    // For artisyn sessions only, prepend project-context events (harness-snapshot-ref, plus the
    // full harness-snapshot when unknown, plus any extraEvents such as the current-session
    // hook-status event). The artisyn log is the metadata carrier; the server merges it with the
    // claude log when serving session data to the viewer.
    if (namespace === 'artisyn') {
      const parts = [];
      // extraEvents land ahead of the harness prefix, LAST event first: the old per-file code
      // prepended them one at a time onto an already-prefixed body, so iterating in reverse here
      // reproduces that order byte for byte.
      for (let i = extraEvents.length - 1; i >= 0; i--) {
        parts.push(Buffer.from(JSON.stringify(extraEvents[i]) + '\n', 'utf8'));
      }
      // The harness-snapshot prepend rides ONLY on the current session's own artisyn body: it
      // describes the repo's harness at upload time, not that session's, and the server upserts
      // `harness_elements` per repo — attaching it to every backlog file would repeat the same
      // bytes across a whole backlog for one identical upsert.
      if (isCurrentSession) {
        parts.push(await getHarnessPrefix());
        // Same carrier, different gate: the harness prefix is snapshot-id- and session-scoped,
        // the inventory is a six-hourly measurement of the repo.
        // Pushed after it so the pre-existing events keep their exact byte order.
        parts.push(getCodeInventoryPrefix());
        // OKF snapshot lines (DD-20): same gate as the harness prefix; pushed last so every
        // pre-existing event keeps its byte order. Empty when OKF detection failed.
        parts.push(getOkfPrefix());
      }
      parts.push(body);
      body = Buffer.concat(parts);
    }

    const bodyBytes = Buffer.byteLength(body);
    const MB40 = 40 * 1024 * 1024;
    if (bodyBytes > MB40) {
      const mb = (bodyBytes / 1024 / 1024).toFixed(1);
      process.stderr.write(`send-logs-hook: payload size=${mb} MB exceeds 40 MB warning threshold for ${namespace}/${sessionId}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'warn', `payload size=${mb} MB exceeds 40 MB warning threshold`, cwd);
    }

    // The routing test stays the *uncompressed* size: `uploadFileMaybeCompressed()` decides for
    // itself whether the single request it sends is gzipped.
    const result = bodyBytes > CHUNK_SIZE_BYTES
      ? await uploadFileChunked(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId || null, workflowRunId || null, telemetryDir, manifestKey, snapshotQuery)
      : await uploadFileMaybeCompressed(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId || null, workflowRunId || null, snapshotQuery);
    const { success, reason, warnings, unknownSnapshotId, unknownOkfSnapshotId } = result;

    if (success) {
      // `claude-otel` chunks are DELETED once uploaded, not fingerprinted. Unlike a session
      // transcript, a chunk is immutable after it is written: the receiver writes one file per
      // inbound OTLP request via temp+rename, and never reopens it. So a successfully uploaded
      // chunk is dead weight locally — it can only ever be re-uploaded identically. Deleting it
      // keeps the whole otel tree out of every later run's directory walk AND out of the manifest,
      // which is where both costs lived: 33,613 chunks / 450 MB on disk and 31,547 of the
      // manifest's 37,469 entries. `pruneOtelDir()` stays as the safety net for chunks whose
      // upload never succeeded.
      if (namespace === 'claude-otel') {
        let removed = false;
        try {
          fs.unlinkSync(filePath);
          removed = true;
        } catch (err) {
          // Could not delete (locked, permissions): fall back to fingerprinting it so the next run
          // skips it instead of re-uploading, and let the retention prune deal with the file.
          hookLog(HOOK_FILE, hookSessionId, 'warn',
            `otel chunk uploaded but not deleted (${manifestKey}): ${err.message}`, cwd);
        }
        if (removed) {
          // No manifest entry for a file that no longer exists — and drop any entry an earlier
          // hook version recorded, so the manifest shrinks on the first run after upgrading.
          if (manifest.delete(manifestKey)) flushManifest(false);
        } else {
          manifest.set(manifestKey, size);
          flushManifest(false);
        }
      } else if (!(isCurrentSession && namespace === 'artisyn')) {
        // Current-session files ARE recorded in the manifest, by their stat-time on-disk size:
        // Claude Code appends turn_duration to the JSONL after the Stop hook fires, so the size
        // changes and the `recorded === size` check above skips only a transcript that genuinely
        // did not change since the last upload — the late-written events still trigger a re-upload.
        // The current session's own artisyn file is the one exception: its uploaded body carries the
        // context prepends and this run's hook-status event, none of which the on-disk size reflects,
        // so an unchanged size there would wrongly skip a body that is different every run.
        manifest.set(manifestKey, size);
        flushManifest(false);
      }
      uploadedCount++;
      hookLog(HOOK_FILE, hookSessionId, 'result', formatUploadResultLine(manifestKey, result), cwd);
    } else {
      hookLog(HOOK_FILE, hookSessionId, 'fail', `${manifestKey}: ${reason}`, cwd);
      failedCount++;
    }

    return { success, reason, warnings, unknownSnapshotId, unknownOkfSnapshotId };
  }

  // The current session's own artisyn file is processed last, once every other
  // file's outcome is known, so the hook-status event it carries can report
  // this run's nonUploadableLogs. (If this specific upload itself fails, the
  // status report is lost until the next successful Stop — accepted trade-off,
  // consistent with the hook's fail-open design.)
  const currentArtisynEntries = filesToProcess.filter((f) => f.namespace === 'artisyn' && f.isCurrentSession);
  const otherEntries = filesToProcess.filter((f) => !(f.namespace === 'artisyn' && f.isCurrentSession));

  // Upload the current session's own claude/claude-subagent transcripts first so a session
  // being actively worked on shows up promptly, without disturbing claude-otel's global
  // lexicographic write-order invariant: claude-otel entries are never pulled out of
  // `remainder`, so their relative order to each other never changes.
  const priorityEntries = otherEntries.filter(
    (f) => f.isCurrentSession && (f.namespace === 'claude' || f.namespace === 'claude-subagent'),
  );
  const remainder = otherEntries.filter(
    (f) => !(f.isCurrentSession && (f.namespace === 'claude' || f.namespace === 'claude-subagent')),
  );

  /** @type {{ file: string, reason: string }[]} */
  const nonUploadableLogs = [];
  let hadTimeoutFailure = false;
  /** Paths of `claude-otel` chunks whose upload failed this run — shielded from the prune below. */
  const failedOtelPaths = new Set();

  /** @type {string[]} */
  const allWarnings = [];

  for (const entry of [...priorityEntries, ...remainder]) {
    const { success, reason, warnings } = await processFile(entry, []);
    if (warnings && warnings.length > 0) {
      allWarnings.push(...warnings);
    }
    if (!success) {
      if (entry.namespace === 'claude-otel') failedOtelPaths.add(entry.filePath);
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

  // Every manifest-writing upload has now happened (the deferred current-session artisyn pass
  // below is exempt from the manifest by design). Prune dead entries first so the single final
  // write persists both the new fingerprints and the removals.
  const seenManifestKeys = new Set(
    filesToProcess.map((f) => f.manifestKey ?? `${f.namespace}/${path.basename(f.filePath)}`),
  );
  const prunedEntries = pruneManifest(seenManifestKeys);
  if (prunedEntries > 0) {
    // Force the write even if no upload happened this run: a pure-pruning run still shrank the map.
    manifestDirtyCount += prunedEntries;
    hookLog(HOOK_FILE, hookSessionId, 'result',
      `manifest prune: removed=${prunedEntries} remaining=${manifest.size}`
      + ` namespaces=${Array.from(prunableNamespaces).sort().join(',') || 'none'}`,
      cwd);
  }
  flushManifest(true);

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
    const { success, warnings, unknownSnapshotId, unknownOkfSnapshotId } = await processFile(entry, [hookStatusEvent]);
    if (warnings && warnings.length > 0) {
      allWarnings.push(...warnings);
    }
    // This is the only upload that can carry the harness-snapshot prefix, so this is where the
    // report is committed — after it succeeded. A failure leaves the state untouched and the
    // next run retries, rather than recording a report the server never received.
    if (success) {
      commitHarnessReport(unknownSnapshotId);
      commitCodeInventoryReport();
      commitOkfReport(unknownOkfSnapshotId);
    }
  }

  // Surface any server-reported broken-upload warnings the same way `timeout-on-upload`
  // does: a recommendation while the condition persists, cleared once it no longer does.
  // Deduped: the server repeats an unresolved failed-upload warning on every upload call
  // made during this run, so `allWarnings` can carry the same string many times over.
  const uniqueWarnings = Array.from(new Set(allWarnings));
  if (uniqueWarnings.length > 0) {
    upsertRecommendation(cwd, {
      rule: 'broken-upload-file',
      message: uniqueWarnings.join('; '),
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
    const pruned = pruneOtelDir(otelDir, retentionDays, hookSessionId, cwd, failedOtelPaths);
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
  // Prefixed `exit:` like every other main() termination line, so a log reader can tell an
  // early exit from a crash without knowing which line came from which branch.
  hookLog(HOOK_FILE, null, 'error', `exit: unhandled error: ${err.message}`, null);
  process.stderr.write(`send-logs-hook error: ${err.message}\n`);
  process.exit(0);
});
