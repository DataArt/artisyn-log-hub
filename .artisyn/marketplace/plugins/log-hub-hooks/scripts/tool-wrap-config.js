'use strict';
/**
 * Claude Code Hook helper — CLI tool-wrap config: kill switches, server fetch, local cache and
 * per-session markers (not a hook entry point).
 *
 * The monitored-tools list comes from `GET /api/v2/tool-monitoring/config?repoUrl=…` (API key),
 * answered as `{ schemaVersion: 1, paused, tools: [{ name, capture }] }`. This hook acts only on
 * `schemaVersion === 1` and ignores unknown fields; a non-200 answer (an old server answers 404),
 * a timeout or any other schema version reads as "no config" (`null`).
 *
 * Fetched at SessionStart (synchronously, bounded by `toolWrapConfigTimeoutMs`) and refreshed on
 * UserPromptSubmit at most once a minute. Every fetch rewrites
 * `<workDir>/tool-wrap/config-cache.json` atomically (temp file + rename), which is the fallback
 * when the server cannot be reached, and rewrites the current session's markers:
 *   - `<sessionDir>/off/<tool>`      — the tool has a shim this session but is no longer enabled;
 *   - `<sessionDir>/off/__all`       — monitoring is paused;
 *   - `<sessionDir>/mode/<tool>.meta` — capture meta only (records, no output text).
 * A tool added mid-session has no shim, so it is wrapped only from the next session.
 *
 * Kill switches: env `LOGHUB_TOOL_WRAP=0`, config `toolWrap: false`, and the UI pause.
 * Everything here fails open: no function throws, a failure reads as "no config" / "not written".
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const { getGitContext, getWorkDirPath, ensureWorkDir } = require('./git-context');
const {
  validateToolName,
  normalizeToolName,
  MAX_MONITORED_TOOLS,
  CONFIG_FETCH_TIMEOUT_MS_DEFAULT,
  CONFIG_SCHEMA_VERSION,
  SELF_TEST_SHIM_NAME,
} = require('./tool-wrap-names');

/** Folder under the work dir holding the cache and every session's wrapper data. */
const TOOL_WRAP_DIR = 'tool-wrap';
const CONFIG_CACHE_FILE = 'config-cache.json';
/** Marker name under `off/` that pauses every shim of the session. */
const OFF_ALL_MARKER = '__all';
const META_MARKER_SUFFIX = '.meta';
/** A session id usable as a directory name under `<workDir>/tool-wrap/`. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

/**
 * Whether the local kill switches turn the wrapper off: env `LOGHUB_TOOL_WRAP=0` or config
 * `toolWrap: false`.
 * @param {Record<string, *>|null|undefined} config - loaded hook config (`loadConfig`)
 * @returns {boolean}
 */
function isToolWrapDisabled(config) {
  if ((process.env.LOGHUB_TOOL_WRAP || '').trim() === '0') return true;
  return !!config && config.toolWrap === false;
}

/**
 * `<workDir>/tool-wrap` for this project.
 * @param {string|null} cwd
 * @returns {string}
 */
function toolWrapDir(cwd) {
  return path.join(getWorkDirPath(cwd), TOOL_WRAP_DIR);
}

/**
 * `<workDir>/tool-wrap/<sessionId>`, or null when the session id is not a safe directory name.
 * @param {string|null} cwd
 * @param {string|null} sessionId
 * @returns {string|null}
 */
function sessionDirPath(cwd, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
  return path.join(toolWrapDir(cwd), sessionId);
}

/**
 * Normalize a config response / cache body to the schema-1 shape, or null when it is not one.
 * Unknown fields are ignored; a tool entry without a string name is skipped; a capture other than
 * `full` reads as `meta` (the conservative choice).
 * @param {*} body
 * @returns {{ schemaVersion: 1, paused: boolean, tools: { name: string, capture: 'full'|'meta' }[] }|null}
 */
function normalizeToolWrapConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.schemaVersion !== CONFIG_SCHEMA_VERSION) return null;
  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (!t || typeof t !== 'object' || typeof t.name !== 'string') continue;
      tools.push({ name: t.name, capture: t.capture === 'full' ? 'full' : 'meta' });
    }
  }
  return { schemaVersion: CONFIG_SCHEMA_VERSION, paused: body.paused === true, tools };
}

/**
 * Minimal JSON GET with a hard timeout (the `httpRequestJson` pattern of
 * `post-turn-analysis-worker.js`). Resolves null on any network or URL problem, never rejects.
 * @param {string} urlStr
 * @param {string} apiKey
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: * }|null>}
 */
function httpGetJson(urlStr, apiKey, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch {
      done(null);
      return;
    }
    try {
      const transport = urlObj.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', () => done(null));
          res.on('end', () => {
            let parsed = null;
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              parsed = null;
            }
            done({ status: res.statusCode, body: parsed });
          });
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        done(null);
      });
      req.on('error', () => done(null));
      req.end();
    } catch {
      done(null);
    }
  });
}

/**
 * Fetch the merged monitored-tools config for this repository. Null when the server or key is not
 * configured, the repository has no remote, or the answer is non-200, timed out or not schema 1.
 * @param {string|null} cwd
 * @param {Record<string, *>} config - loaded hook config
 * @param {number} [timeoutMs] - defaults to `config.toolWrapConfigTimeoutMs`, then 2000
 * @returns {Promise<ReturnType<typeof normalizeToolWrapConfig>>}
 */
async function fetchToolWrapConfig(cwd, config, timeoutMs) {
  try {
    const serverUrl = String((config && config.serverUrl) || '').trim().replace(/\/$/, '');
    const apiKey = String((config && config.apiKey) || '').trim();
    if (!serverUrl || !apiKey) return null;
    const git = getGitContext(cwd);
    const repoUrl = git && git.remote;
    if (!repoUrl) return null;
    const configured = config && config.toolWrapConfigTimeoutMs;
    const ms = typeof timeoutMs === 'number' && timeoutMs > 0
      ? timeoutMs
      : (typeof configured === 'number' && configured > 0 ? configured : CONFIG_FETCH_TIMEOUT_MS_DEFAULT);
    const url = `${serverUrl}/api/v2/tool-monitoring/config?repoUrl=${encodeURIComponent(repoUrl)}`;
    const resp = await httpGetJson(url, apiKey, ms);
    if (!resp || resp.status !== 200) return null;
    return normalizeToolWrapConfig(resp.body);
  } catch {
    return null;
  }
}

/**
 * Read `<workDir>/tool-wrap/config-cache.json`. Null when missing, corrupt or not schema 1.
 * @param {string|null} cwd
 * @returns {ReturnType<typeof normalizeToolWrapConfig>}
 */
function readCache(cwd) {
  try {
    const raw = fs.readFileSync(path.join(toolWrapDir(cwd), CONFIG_CACHE_FILE), 'utf8');
    return normalizeToolWrapConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Write `<workDir>/tool-wrap/config-cache.json` atomically: a temp file in the same folder, then a
 * rename over the old cache, so a concurrent reader never sees a half-written file.
 * @param {string|null} cwd
 * @param {ReturnType<typeof normalizeToolWrapConfig>} cfg
 * @returns {boolean} whether the cache was written
 */
function writeCache(cwd, cfg) {
  const normalized = normalizeToolWrapConfig(cfg);
  if (!normalized) return false;
  let tmp = null;
  try {
    // ensureWorkDir first, so a freshly created work dir still gets its own .gitignore.
    ensureWorkDir(cwd);
    const dir = toolWrapDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, CONFIG_CACHE_FILE);
    tmp = `${target}.${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...normalized, fetchedAt: new Date().toISOString() }), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    }
    return false;
  }
}

/**
 * The tools to wrap: none when paused or absent; otherwise the listed tools whose names pass
 * `validateToolName` (denylisted or invalid names dropped), de-duplicated case-insensitively
 * (first wins) and capped at `MAX_MONITORED_TOOLS`.
 * @param {ReturnType<typeof normalizeToolWrapConfig>} cfg
 * @returns {{ name: string, capture: 'full'|'meta' }[]}
 */
function effectiveTools(cfg) {
  const normalized = normalizeToolWrapConfig(cfg);
  if (!normalized || normalized.paused) return [];
  const seen = new Set();
  const out = [];
  for (const t of normalized.tools) {
    if (!validateToolName(t.name).ok) continue;
    const key = normalizeToolName(t.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: t.name, capture: t.capture });
    if (out.length >= MAX_MONITORED_TOOLS) break;
  }
  return out;
}

/**
 * Make `file` exist (empty) or not exist. Best-effort.
 * @param {string} file
 * @param {boolean} present
 */
function setMarker(file, present) {
  try {
    if (present) {
      if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // markers are best-effort
  }
}

/**
 * Rewrite the session's markers from a freshly fetched config: `off/__all` iff paused; for every
 * tool that has a shim this session, `off/<tool>` iff it is no longer an effective tool and
 * `mode/<tool>.meta` iff its capture is `meta`. Stale markers of other names are removed. Does
 * nothing when `cfg` is not a schema-1 config or the session dir does not exist.
 * @param {string} sessionDir - `<workDir>/tool-wrap/<sessionId>`
 * @param {ReturnType<typeof normalizeToolWrapConfig>} cfg
 * @param {string[]} generatedTools - tool names that have a shim this session
 * @returns {boolean} whether the markers were rewritten
 */
function writeSessionMarkers(sessionDir, cfg, generatedTools) {
  const normalized = normalizeToolWrapConfig(cfg);
  if (!normalized || !sessionDir) return false;
  try {
    if (!fs.statSync(sessionDir).isDirectory()) return false;
    const offDir = path.join(sessionDir, 'off');
    const modeDir = path.join(sessionDir, 'mode');
    fs.mkdirSync(offDir, { recursive: true });
    fs.mkdirSync(modeDir, { recursive: true });

    const effective = new Map(effectiveTools(normalized).map((t) => [normalizeToolName(t.name), t]));
    const shimmed = (Array.isArray(generatedTools) ? generatedTools : [])
      .filter((name) => typeof name === 'string' && validateToolName(name).ok);

    const wantOff = new Set();
    const wantMeta = new Set();
    if (normalized.paused) wantOff.add(OFF_ALL_MARKER);
    for (const name of shimmed) {
      const tool = effective.get(normalizeToolName(name));
      if (!tool) {
        if (!normalized.paused) wantOff.add(name);
        continue;
      }
      if (tool.capture === 'meta') wantMeta.add(`${name}${META_MARKER_SUFFIX}`);
    }

    for (const entry of safeReaddir(offDir)) {
      if (!wantOff.has(entry)) setMarker(path.join(offDir, entry), false);
    }
    for (const entry of safeReaddir(modeDir)) {
      if (!wantMeta.has(entry)) setMarker(path.join(modeDir, entry), false);
    }
    for (const name of wantOff) setMarker(path.join(offDir, name), true);
    for (const name of wantMeta) setMarker(path.join(modeDir, name), true);
    return true;
  } catch {
    return false;
  }
}

/**
 * File names directly in `dir` (regular files only), or [] on any error.
 * @param {string} dir
 * @returns {string[]}
 */
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Tool names that have a shim in this session (`<sessionDir>/shims/`), excluding the self-test
 * shim and any name that is not a valid tool name. [] when there is no shim dir.
 * @param {string} sessionDir
 * @returns {string[]}
 */
function listGeneratedTools(sessionDir) {
  if (!sessionDir) return [];
  return safeReaddir(path.join(sessionDir, 'shims'))
    .filter((name) => name !== SELF_TEST_SHIM_NAME && validateToolName(name).ok);
}

module.exports = {
  TOOL_WRAP_DIR,
  CONFIG_CACHE_FILE,
  OFF_ALL_MARKER,
  META_MARKER_SUFFIX,
  SESSION_ID_PATTERN,
  isToolWrapDisabled,
  toolWrapDir,
  sessionDirPath,
  normalizeToolWrapConfig,
  fetchToolWrapConfig,
  readCache,
  writeCache,
  effectiveTools,
  writeSessionMarkers,
  listGeneratedTools,
};
