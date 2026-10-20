'use strict';
const fs = require('fs');
const path = require('path');
const {getGitRoot} = require('./git-context');

// ---------------------------------------------------------------------------
// .env loader (no external deps)
// ---------------------------------------------------------------------------
function loadEnv(envPath) {
  try {
    const vars = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip matched surrounding quotes only (mismatched quotes are left as-is)
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Telemetry directory resolution
// ---------------------------------------------------------------------------
function resolveTelemetryDir(cwd, envVars) {
  const envVal = (envVars.TELEMETRY_DIR || '').trim();
  const root = getGitRoot(cwd || process.cwd());
  if (envVal) {
    return path.isAbsolute(envVal) ? envVal : path.resolve(root, envVal);
  }
  return path.resolve(root, '.ai_work_dir', 'telemetry');
}

// ---------------------------------------------------------------------------
// CTX_ context extraction
// ---------------------------------------------------------------------------
function getEnvContext(envVars) {
  const ctx = {};
  for (const [key, val] of Object.entries(envVars)) {
    if (key.startsWith('CTX_')) {
      ctx[key.slice(4).toLowerCase()] = val;
    }
  }
  return Object.keys(ctx).length ? ctx : null;
}

// ---------------------------------------------------------------------------
// JSON formatting
// ---------------------------------------------------------------------------
function isCompactJson(envVars) {
  return (envVars.JSON_COMPACT || '').trim().toLowerCase() === 'true';
}

function loadEnvWithLocal(baseEnvPath) {
  return { ...loadEnv(baseEnvPath), ...loadEnv(baseEnvPath + '.local') };
}

module.exports = { loadEnv, loadEnvWithLocal, resolveTelemetryDir, getEnvContext, isCompactJson };
