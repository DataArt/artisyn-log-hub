'use strict';
/**
 * Claude Code Hook helper — "have the harness elements changed, and did we already report them
 * this session?" (not a hook entry point itself).
 *
 * The four project-context events an `artisyn` upload can carry — `system-context`,
 * `skill-definitions`, `agent-definitions`, `mcp-config` — describe the HARNESS (CLAUDE.md files,
 * the skill and agent catalogs, the MCP server list), not the session. Previously they were
 * prepended to every uploaded `artisyn` body, so a repo with a large skill catalog re-sent hundreds
 * of KB of identical bytes with every small session log. The server has always upserted this data
 * **per repository**
 * (`upsertHarnessElements(tx, repoId, …)` in `logs.service.ts`) and explicitly skips the upsert when
 * the events are absent rather than clearing what it already knows, so sending them once is not a
 * data loss — it is what the receiving side was already built for.
 *
 * Change detection is by **last-modified time**, deliberately: the three builders already stat every
 * file they describe and carry `lastModified` on each entry, so the fingerprint costs nothing beyond
 * the walk that was happening anyway, and needs no content hashing of the skill bodies.
 * mtime is not a perfect change oracle (a touch with no edit re-reports; an edit that preserves
 * mtime does not) — accepted for this use, since the consequence either way is one redundant or one
 * delayed catalog upsert, never wrong session data.
 *
 * Reported at most ONCE PER SESSION, and the decision is frozen at the session's first full upload
 * run: a skill edited mid-session is reported by the NEXT session, not by this session's next
 * `Stop`. That is what keeps a long session with many `Stop`s from re-sending the catalog repeatedly, and
 * it is why the state records which session it was decided for, not just the fingerprint.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Single JSON file, alongside the hook's other state, inside the gitignored work dir. */
const HARNESS_STATE_FILE = 'harness-state.json';

/**
 * Bumped only if the on-disk shape changes incompatibly. An unrecognised version is treated as
 * "no state", which re-reports the harness once — the same fail-open direction as a missing file,
 * since over-reporting is harmless and under-reporting silently loses catalog data.
 */
const HARNESS_STATE_VERSION = 1;

/** @param {string} workDir @returns {string} */
function harnessStatePath(workDir) {
  return path.join(workDir, HARNESS_STATE_FILE);
}

/**
 * Read the recorded state, or a neutral "nothing known yet" value.
 *
 * Fail-open on every error (missing, unreadable, malformed, wrong version): the caller then treats
 * the harness as changed and reports it once, which costs one redundant upsert. The opposite
 * default would drop catalog data on a corrupt file and give no signal that it happened.
 *
 * @param {string} workDir
 * @returns {{ fingerprint: string|null, decidedForSessionId: string|null }}
 */
function readHarnessState(workDir) {
  const empty = { fingerprint: null, decidedForSessionId: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(harnessStatePath(workDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return empty;
    if (parsed.version !== HARNESS_STATE_VERSION) return empty;
    return {
      fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null,
      decidedForSessionId:
        typeof parsed.decidedForSessionId === 'string' ? parsed.decidedForSessionId : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Persist the state with a temp-file + rename, so a crash mid-write can never leave a truncated
 * JSON that the next run would have to treat as "no state".
 *
 * Never throws: failing to record the report is a redundant re-report next session, which must not
 * be allowed to fail an upload run that already succeeded.
 *
 * @param {string} workDir
 * @param {{ fingerprint: string, decidedForSessionId: string|null, reported: boolean }} state
 * @returns {boolean} true when the state reached disk
 */
function writeHarnessState(workDir, state) {
  const target = harnessStatePath(workDir);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const doc = {
      version: HARNESS_STATE_VERSION,
      fingerprint: state.fingerprint,
      decidedForSessionId: state.decidedForSessionId,
      reported: state.reported === true,
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

/**
 * Fingerprint the harness from the builders' own output.
 *
 * Only identity + mtime + size go into the digest, never the bodies: the point is to decide whether
 * to ship the catalog, so the decision must not itself cost a read of the whole catalog. `mcpConfigFiles`
 * are stat'ed here rather than taken from a builder because `buildMcpConfig()` returns live probe
 * results (a server's tool list can change with no config edit) — the config files' mtimes are the
 * only file-based signal available for it, which is the documented limit of this approach.
 *
 * @param {{
 *   claudeMd?: { files?: Array<{path?: string, bytes?: number, lastModified?: number}> }|null,
 *   skills?: Array<{path?: string, bytes?: number, lastModified?: number}>|null,
 *   agents?: Array<{path?: string, bytes?: number, lastModified?: number}>|null,
 *   mcpConfigFiles?: string[],
 * }} inputs
 * @returns {string} hex digest
 */
function computeHarnessFingerprint(inputs) {
  /** @param {{path?: string, bytes?: number, lastModified?: number}} e */
  const stamp = (e) => `${e && e.path ? e.path : ''}|${e && e.bytes != null ? e.bytes : ''}|${e && e.lastModified != null ? e.lastModified : ''}`;

  const parts = [];

  const claudeMdFiles = inputs.claudeMd && Array.isArray(inputs.claudeMd.files)
    ? inputs.claudeMd.files
    : [];
  // Sorted so a directory-order difference between machines or runs is not mistaken for a change.
  parts.push('claudeMd:' + claudeMdFiles.map(stamp).sort().join(','));
  parts.push('skills:' + (Array.isArray(inputs.skills) ? inputs.skills.map(stamp).sort() : []).join(','));
  parts.push('agents:' + (Array.isArray(inputs.agents) ? inputs.agents.map(stamp).sort() : []).join(','));

  const mcpStamps = [];
  for (const file of inputs.mcpConfigFiles || []) {
    try {
      const st = fs.statSync(file);
      mcpStamps.push(`${file}|${st.size}|${st.mtimeMs}`);
    } catch {
      // Absent config files are part of the fingerprint too — one appearing later IS a change.
      mcpStamps.push(`${file}|absent`);
    }
  }
  parts.push('mcp:' + mcpStamps.sort().join(','));

  return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

module.exports = {
  HARNESS_STATE_FILE,
  HARNESS_STATE_VERSION,
  harnessStatePath,
  readHarnessState,
  writeHarnessState,
  computeHarnessFingerprint,
};
