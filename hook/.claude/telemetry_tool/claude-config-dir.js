'use strict';
/**
 * Shared utility — Claude Code's per-user config directory.
 *
 * Claude Code keeps everything user-level (`projects/` transcripts, `skills/`, `plugins/`,
 * `settings.json`, `mcp.json`) in `~/.claude`, unless `CLAUDE_CONFIG_DIR` is set — then all of it
 * lives in that directory instead, and `~/.claude` is never touched. Hook processes inherit Claude
 * Code's environment, so the variable is visible here. Every hook read of a user-level Claude file
 * must resolve through this helper: a hard-coded `~/.claude` silently finds no transcripts for a
 * user running with `CLAUDE_CONFIG_DIR`, and their sessions never reach the server.
 */
const os = require('os');
const path = require('path');

/**
 * `$CLAUDE_CONFIG_DIR` (resolved to an absolute path) when set and non-blank, else `~/.claude`.
 * `os.homedir()` is read per call, so a changed `HOME`/`USERPROFILE` is honored.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function claudeConfigDir(env = process.env) {
  const dir = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return dir ? path.resolve(dir) : path.join(os.homedir(), '.claude');
}

module.exports = { claudeConfigDir };
