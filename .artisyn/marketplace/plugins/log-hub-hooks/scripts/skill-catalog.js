'use strict';
/**
 * Claude Code Hook helper — skill catalog (not a hook entry point itself).
 *
 * `buildSkillDefinitions(cwd)`/`findSkillFiles(dir, maxDepth)` used to
 * live inline in `send-logs-hook.js`, which still imports both from here so its existing
 * `skill-definitions` upload keeps working unchanged. `post-turn-analysis-worker.js` is the
 * second, independent consumer — its `resolveSkillInvocations()` resolves a turn's invoked skill
 * names against this same catalog to look up their `description`. Two call sites in two different
 * files is a stronger case for a real shared module than the "both call sites live
 * in the same file" carve-out for `claude-invoke-async.js`.
 *
 * Widened while being moved (this is the part that is a genuine behavior change, not just an
 * extraction) because the pre-existing scan — project `.claude/skills/` plus a recursive walk of
 * `~/.claude/plugins/` — misses two real sources:
 *   - Personal skills at `~/.claude/skills/<name>/SKILL.md` (tagged `source: 'user'`).
 *   - Plugins whose marketplace is `directory`-sourced, i.e. registered in
 *     `{cwd}/.claude/settings.json` / `.claude/settings.local.json`'s `extraKnownMarketplaces`
 *     with a `source.source === 'directory'` entry (this repo's own `log-hub-hooks@artisyn`,
 *     sourced from `./.artisyn/marketplace`, is exactly this case). A `github`/git-sourced
 *     marketplace needs no new code here — Claude Code already caches those plugins under
 *     `~/.claude/plugins/marketplaces/`, inside the existing recursive scan's root.
 * A marketplace registered only in the user's own global `~/.claude/settings.json` (not the
 * project-scoped files read here) is an accepted residual limitation — same fail-open treatment
 * as an unmatched skill name: it is silently skipped, never thrown.
 *
 * Priority when the same skill `name` is found in more than one source: project always wins
 * (matches the pre-existing project-vs-plugin precedent); user/plugin duplicates of each other are
 * not de-duplicated against one another, only against the project set — same behavior the
 * pre-existing plugin scan already had for plugin-vs-plugin duplicates.
 */
const fs = require('fs');
const { claudeConfigDir } = require('./claude-config-dir');
const path = require('path');

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
 * Read one `SKILL.md` file into the shared skill-definition shape, or `null` if it can't be
 * read/is empty. Shared by every scan below so the try/catch + stat + frontmatter parse isn't
 * repeated per source.
 * @param {string} skillFile
 * @param {string} fallbackName - used when the frontmatter has no `name` field (e.g. the
 *   containing directory's name)
 * @param {string} source - `'project' | 'user' | 'plugin'`
 * @returns {{ name: string, description: string, argumentHint: string, body: string, path: string, bytes: number, lastModified: number, source: string }|null}
 */
function readSkillFile(skillFile, fallbackName, source) {
  try {
    const stat = fs.statSync(skillFile);
    if (!stat.isFile() || stat.size === 0) return null;
    const text = fs.readFileSync(skillFile, 'utf8');
    const { fm, body } = parseFrontmatter(text);
    return {
      name: fm['name'] || fallbackName,
      description: fm['description'] || '',
      argumentHint: fm['argument-hint'] || '',
      body,
      path: skillFile,
      bytes: stat.size,
      lastModified: stat.mtimeMs,
      source,
    };
  } catch (err) {
    process.stderr.write(`[skill-definitions] skipping ${skillFile}: ${err.message}\n`);
    return null;
  }
}

/**
 * Read + merge `{cwd}/.claude/settings.json` and `.claude/settings.local.json`'s
 * `enabledPlugins`/`extraKnownMarketplaces` blocks (project scope only).
 * Fail-open throughout: a missing/malformed file, or a missing block, reads as empty — this is
 * best-effort catalog enrichment, never something that should throw or block the caller.
 * @param {string} cwd
 * @returns {{ enabledPlugins: Record<string, boolean>, extraKnownMarketplaces: Record<string, { source?: { source?: string, path?: string } }> }}
 */
function readProjectClaudeSettings(cwd) {
  const enabledPlugins = {};
  const extraKnownMarketplaces = {};

  for (const fileName of ['settings.json', 'settings.local.json']) {
    try {
      const raw = fs.readFileSync(path.join(cwd, '.claude', fileName), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.enabledPlugins && typeof parsed.enabledPlugins === 'object') {
        Object.assign(enabledPlugins, parsed.enabledPlugins);
      }
      if (parsed.extraKnownMarketplaces && typeof parsed.extraKnownMarketplaces === 'object') {
        Object.assign(extraKnownMarketplaces, parsed.extraKnownMarketplaces);
      }
    } catch {
      // missing file, malformed JSON, or unreadable — treated as contributing nothing
    }
  }

  return { enabledPlugins, extraKnownMarketplaces };
}

/**
 * For every enabled plugin (`enabledPlugins[<id>@<marketplace>] ===
 * true`) whose marketplace resolves to a `directory`-sourced entry in `extraKnownMarketplaces`,
 * find that plugin's own skill files under `<marketplaceDir>/plugins/<id>/**\/SKILL.md`. Any
 * plugin id whose marketplace name isn't found in `extraKnownMarketplaces` (e.g. registered only
 * in the user's global settings) or whose source isn't `directory` (already covered by the
 * recursive `~/.claude/plugins/` scan) is silently skipped, never thrown.
 * @param {string} cwd
 * @param {number} maxDepth
 * @returns {string[]} absolute paths to SKILL.md files
 */
function findDirectoryMarketplaceSkillFiles(cwd, maxDepth) {
  const { enabledPlugins, extraKnownMarketplaces } = readProjectClaudeSettings(cwd);
  const results = [];

  for (const [key, enabled] of Object.entries(enabledPlugins)) {
    if (enabled !== true) continue;
    const atIndex = key.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === key.length - 1) continue; // not "<id>@<marketplace>"
    const pluginId = key.slice(0, atIndex);
    const marketplaceName = key.slice(atIndex + 1);

    const marketplace = extraKnownMarketplaces[marketplaceName];
    const source = marketplace && marketplace.source;
    if (!source || source.source !== 'directory' || typeof source.path !== 'string') continue;

    const marketplaceDir = path.isAbsolute(source.path)
      ? source.path
      : path.resolve(cwd, source.path);
    const pluginSkillsDir = path.join(marketplaceDir, 'plugins', pluginId);
    results.push(...findSkillFiles(pluginSkillsDir, maxDepth));
  }

  return results;
}

/**
 * Collect skill definitions from every known source:
 *   - Project: `.claude/skills/<name>/SKILL.md` — `source: 'project'`, always wins on a name clash.
 *   - User: `~/.claude/skills/<name>/SKILL.md` — `source: 'user'`.
 *   - Plugin (git/github-cached): `~/.claude/plugins/` scanned recursively — `source: 'plugin'`.
 *   - Plugin (directory-sourced marketplace): `<marketplaceDir>/plugins/<id>/**` for every
 *     enabled plugin resolved via the project's `.claude/settings*.json` — `source: 'plugin'`.
 * @param {string} cwd
 * @returns {Array<{ name: string, description: string, argumentHint: string, body: string, path: string, bytes: number, lastModified: number, source: string }>|null}
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

  // Project skills — always highest priority.
  for (const subdir of subdirs) {
    const skillFile = path.join(skillsDir, subdir.name, 'SKILL.md');
    const skill = readSkillFile(skillFile, subdir.name, 'project');
    if (!skill) continue;
    projectNames.add(skill.name);
    skills.push(skill);
  }

  // Personal skills — ~/.claude/skills/<name>/SKILL.md.
  const userSkillsDir = path.join(claudeConfigDir(), 'skills');
  let userSubdirs;
  try {
    userSubdirs = fs.readdirSync(userSkillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    userSubdirs = [];
  }
  for (const subdir of userSubdirs) {
    const skillFile = path.join(userSkillsDir, subdir.name, 'SKILL.md');
    const skill = readSkillFile(skillFile, subdir.name, 'user');
    if (!skill || projectNames.has(skill.name)) continue; // project takes priority
    skills.push(skill);
  }

  // Plugin skills — ~/.claude/plugins/ scanned recursively (git/github-cached marketplaces).
  const pluginsDir = path.join(claudeConfigDir(), 'plugins');
  const pluginDepth = parseInt(process.env.PLUGIN_SKILL_MAX_DEPTH || '30', 10) || 30;
  const pluginSkillFiles = findSkillFiles(pluginsDir, pluginDepth);
  for (const skillFile of pluginSkillFiles) {
    const dirName = path.basename(path.dirname(skillFile));
    const skill = readSkillFile(skillFile, dirName, 'plugin');
    if (!skill || projectNames.has(skill.name)) continue; // project takes priority
    skills.push(skill);
  }

  // Plugin skills — directory-sourced marketplaces.
  const directoryPluginSkillFiles = findDirectoryMarketplaceSkillFiles(cwd, pluginDepth);
  for (const skillFile of directoryPluginSkillFiles) {
    const dirName = path.basename(path.dirname(skillFile));
    const skill = readSkillFile(skillFile, dirName, 'plugin');
    if (!skill || projectNames.has(skill.name)) continue; // project takes priority
    skills.push(skill);
  }

  return skills.length > 0 ? skills : null;
}

module.exports = { parseFrontmatter, findSkillFiles, buildSkillDefinitions };
