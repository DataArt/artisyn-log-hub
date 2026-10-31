'use strict';
/**
 * Claude Code Hook helper — harness skill/workflow/command catalog (not a hook entry point
 * itself).
 *
 * `buildSkillCatalog({projectRoot, cwd, env, log})` is the exact plugin-aware catalog scanner
 * behind the `skills[]` section of a harness snapshot (see `harness-snapshot.js`, DD-1 of the
 * `2026-10-16-sysctx-skill-source` plan). `post-turn-analysis-worker.js` is the second,
 * independent consumer — its `resolveSkillInvocations()` resolves a turn's invoked skill names
 * against this same catalog to look up their `description`.
 *
 * What it scans, per DD-5:
 *   - **project** (`<projectRoot>/.claude/`) and **user** (`<claudeConfigDir>/`): `skills/<dir>/
 *     SKILL.md` (kind `skill`, name from frontmatter `name` else the directory name),
 *     `workflows/*.js` (kind `workflow`, name/description from a `meta = {...}` regex, the file is
 *     never executed) and top-level `commands/*.md` (kind `command`, name is always the file
 *     basename).
 *   - **plugin**: the same three folders under the plugin's resolved `installPath` (DD-4), plus
 *     any extra directories `plugin.json` lists under `skills`/`commands` (string or array,
 *     scanned the same way as the default folder for that kind). The name is
 *     `<pluginName>:<name>`.
 *   - **org-synced** (`<claudeConfigDir>/skills/synced/<org>/<skill>/SKILL.md`, skills only):
 *     metadata only — the entry's `body` is always `''`, its `path` masks the org folder as
 *     the literal `~/.claude/skills/synced/<org>/<skill>/SKILL.md` and its `name` is the bare
 *     frontmatter/folder name. Skipped on a name collision with a project or user skill.
 * Which plugins are "enabled" and where each one is actually installed for this project is DD-4:
 * `enabledPlugins` is merged from the user, project and project-local settings files (`false`
 * disables), then each enabled `<id>@<marketplace>` is resolved against `installed_plugins.json`
 * (v2), preferring a `local`/`project` scope entry whose `projectPath` matches this project, and
 * falling back to a `user`-scope entry. An enabled plugin with no matching install is skipped
 * (logged, never thrown).
 *
 * Every entry's `path` follows DD-3 (always relative, never an absolute local path), and
 * `contentHash` is the sha256 hex of the exact file text the scanner already read — see DD-2.
 *
 * On a project/user name collision (same `kind` + `name`), **project always wins** (plugin entries
 * are namespaced `<pluginName>:<name>` so they never collide with a bare project/user name).
 *
 * Everything here is fail-open: a missing/unreadable file or directory, malformed JSON, or an
 * unresolvable plugin contributes nothing rather than throwing — this is best-effort catalog
 * enrichment, never something that should block the caller.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { claudeConfigDir } = require('./claude-config-dir');

// DD-5's exact regex shape for a workflow's `meta = {...}` object literal — applied twice, once
// for `name:` and once for `description:`. The file is parsed as text, never executed.
const WORKFLOW_META_NAME_RE = /meta\s*=\s*\{[\s\S]*?name:\s*['"]([^'"]+)['"]/;
const WORKFLOW_META_DESCRIPTION_RE = /meta\s*=\s*\{[\s\S]*?description:\s*['"]([^'"]+)['"]/;

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
 * @param {string} text
 * @returns {string} sha256 hex digest of the raw UTF-8 text — DD-2's `contentHash`.
 */
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @param {string} root
 * @param {string} absFile
 * @returns {string} `path.relative(root, absFile)` with forward slashes, for every DD-3 path kind.
 */
function relForwardSlash(root, absFile) {
  return path.relative(root, absFile).split(path.sep).join('/');
}

/** DD-3 `project` path: relative to `projectRoot`. */
function projectEntryPath(projectRoot, absFile) {
  return relForwardSlash(projectRoot, absFile);
}

/** DD-3 `user` path: `~/.claude/<rel>`, `<rel>` relative to `claudeConfigDir(env)`. */
function userEntryPath(configDir, absFile) {
  return `~/.claude/${relForwardSlash(configDir, absFile)}`;
}

/** DD-3 `plugin` path: `<pluginName>@<version>/<rel inside installPath>`. */
function pluginEntryPath(pluginName, version, installPath, absFile) {
  return `${pluginName}@${version}/${relForwardSlash(installPath, absFile)}`;
}

/**
 * Read one markdown file (`SKILL.md` or a `commands/*.md` file) into the shared shape, or `null`
 * if it can't be read or is empty. Shared by every markdown source so the try/catch + stat +
 * frontmatter parse isn't repeated per source.
 * @param {string} filePath
 * @param {string} fallbackName - used when there is no frontmatter `name` (skills), or always
 *   (commands — DD-5 says a command's name is always its file basename).
 * @param {{ forceFallbackName?: boolean }} [opts]
 * @returns {{ name: string, description: string, argumentHint: string, body: string, bytes: number, contentHash: string }|null}
 */
function readMarkdownEntry(filePath, fallbackName, opts = {}) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    const { fm, body } = parseFrontmatter(text);
    return {
      name: opts.forceFallbackName ? fallbackName : fm['name'] || fallbackName,
      description: fm['description'] || '',
      argumentHint: fm['argument-hint'] || '',
      body,
      bytes: stat.size,
      contentHash: sha256Hex(text),
    };
  } catch (err) {
    process.stderr.write(`[skill-catalog] skipping ${filePath}: ${err.message}\n`);
    return null;
  }
}

/**
 * Read one `workflows/*.js` file into the shared shape, or `null`. The file is only ever read as
 * text and regex-matched (DD-5) — it is never executed.
 * @param {string} filePath
 * @param {string} fallbackName - the file basename (no `.js`), used when the `meta` regex finds
 *   no `name:` field.
 * @returns {{ name: string, description: string, argumentHint: string, body: string, bytes: number, contentHash: string }|null}
 */
function readWorkflowEntry(filePath, fallbackName) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    const nameMatch = text.match(WORKFLOW_META_NAME_RE);
    const descriptionMatch = text.match(WORKFLOW_META_DESCRIPTION_RE);
    return {
      name: nameMatch ? nameMatch[1] : fallbackName,
      description: descriptionMatch ? descriptionMatch[1] : '',
      argumentHint: '',
      body: text,
      bytes: stat.size,
      contentHash: sha256Hex(text),
    };
  } catch (err) {
    process.stderr.write(`[skill-catalog] skipping ${filePath}: ${err.message}\n`);
    return null;
  }
}

/**
 * @param {string} skillsDir - a `skills/` directory (project, user or plugin root).
 * @returns {Array<{ file: string, fallbackName: string }>} one `SKILL.md` candidate per subdir.
 */
function scanSkillsDir(skillsDir) {
  let subdirs;
  try {
    subdirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    subdirs = [];
  }
  return subdirs.map((d) => ({ file: path.join(skillsDir, d.name, 'SKILL.md'), fallbackName: d.name }));
}

/**
 * @param {string} workflowsDir - a `workflows/` directory (project, user or plugin root).
 * @returns {Array<{ file: string, fallbackName: string }>} one candidate per top-level `*.js` file.
 */
function scanWorkflowsDir(workflowsDir) {
  let files;
  try {
    files = fs
      .readdirSync(workflowsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'));
  } catch {
    files = [];
  }
  return files.map((f) => ({
    file: path.join(workflowsDir, f.name),
    fallbackName: path.basename(f.name, '.js'),
  }));
}

/**
 * @param {string} commandsDir - a `commands/` directory (project, user or plugin root).
 * @returns {Array<{ file: string, fallbackName: string }>} one candidate per top-level `*.md`
 *   file — DD-5's "top level only", so a nested subdirectory is never descended into.
 */
function scanCommandsDir(commandsDir) {
  let files;
  try {
    files = fs
      .readdirSync(commandsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'));
  } catch {
    files = [];
  }
  return files.map((f) => ({
    file: path.join(commandsDir, f.name),
    fallbackName: path.basename(f.name, '.md'),
  }));
}

/**
 * Scan the three DD-5 folders directly under one root (`<projectRoot>/.claude`, `claudeConfigDir`,
 * or a plugin's `installPath`) and return `{ kind, file, read }` for every readable entry found.
 * @param {string} root
 * @returns {Array<{ kind: 'skill'|'workflow'|'command', file: string, read: object }>}
 */
function scanRoot(root) {
  const results = [];
  for (const { file, fallbackName } of scanSkillsDir(path.join(root, 'skills'))) {
    const read = readMarkdownEntry(file, fallbackName);
    if (read) results.push({ kind: 'skill', file, read });
  }
  for (const { file, fallbackName } of scanWorkflowsDir(path.join(root, 'workflows'))) {
    const read = readWorkflowEntry(file, fallbackName);
    if (read) results.push({ kind: 'workflow', file, read });
  }
  for (const { file, fallbackName } of scanCommandsDir(path.join(root, 'commands'))) {
    const read = readMarkdownEntry(file, fallbackName, { forceFallbackName: true });
    if (read) results.push({ kind: 'command', file, read });
  }
  return results;
}

/**
 * The extra `skills`/`commands` directories a plugin manifest can list, on top of its default
 * `skills/`/`commands/` folders (DD-5). Each listed path is resolved relative to `installPath` and
 * scanned exactly like the matching default folder for that kind.
 * @param {string} installPath
 * @param {{ skills?: string|string[], commands?: string|string[] }|null} manifest
 * @returns {Array<{ kind: 'skill'|'command', file: string, read: object }>}
 */
function scanPluginExtraPaths(installPath, manifest) {
  if (!manifest) return [];
  const results = [];
  const toArray = (value) => (!value ? [] : Array.isArray(value) ? value : [value]);

  for (const rel of toArray(manifest.skills)) {
    if (typeof rel !== 'string' || !rel) continue;
    const dir = path.resolve(installPath, rel);
    for (const { file, fallbackName } of scanSkillsDir(dir)) {
      const read = readMarkdownEntry(file, fallbackName);
      if (read) results.push({ kind: 'skill', file, read });
    }
  }
  for (const rel of toArray(manifest.commands)) {
    if (typeof rel !== 'string' || !rel) continue;
    const dir = path.resolve(installPath, rel);
    for (const { file, fallbackName } of scanCommandsDir(dir)) {
      const read = readMarkdownEntry(file, fallbackName, { forceFallbackName: true });
      if (read) results.push({ kind: 'command', file, read });
    }
  }
  return results;
}

/**
 * Build one DD-1 `skills[]` entry.
 * @param {'skill'|'workflow'|'command'} kind
 * @param {object} read - the `{name, description, argumentHint, body, bytes, contentHash}` a
 *   reader function above produced.
 * @param {'project'|'user'|'plugin'|'org-synced'} source
 * @param {string} entryPath - the DD-3 path for this entry.
 * @param {{ id: string, name: string, marketplace: string, version: string, gitCommitSha?: string }} [pluginMeta]
 * @returns {object}
 */
function makeEntry(kind, read, source, entryPath, pluginMeta) {
  const entry = {
    name: pluginMeta ? `${pluginMeta.name}:${read.name}` : read.name,
    kind,
    source,
    description: read.description,
    body: read.body,
    path: entryPath,
    bytes: read.bytes,
    contentHash: read.contentHash,
  };
  if (read.argumentHint) entry.argumentHint = read.argumentHint;
  if (pluginMeta) {
    entry.plugin = {
      id: pluginMeta.id,
      name: pluginMeta.name,
      marketplace: pluginMeta.marketplace,
      version: pluginMeta.version,
    };
    if (pluginMeta.gitCommitSha) entry.plugin.gitCommitSha = pluginMeta.gitCommitSha;
  }
  return entry;
}

/**
 * Read one settings file's `enabledPlugins` block. Fail-open: a missing file, malformed JSON, or
 * a missing/non-object block all read as contributing nothing.
 * @param {string} filePath
 * @returns {Record<string, boolean>}
 */
function readSettingsEnabledPlugins(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.enabledPlugins && typeof parsed.enabledPlugins === 'object') {
      return parsed.enabledPlugins;
    }
  } catch {
    // missing file, malformed JSON, or unreadable — contributes nothing
  }
  return {};
}

/**
 * DD-4 step 1: merge `enabledPlugins` from the user, project and project-local settings files, in
 * that order — a later file overrides an earlier one for the same `<id>@<marketplace>` key, and
 * `false` disables a plugin a user-level file enabled.
 * @param {string} projectRoot
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, boolean>}
 */
function readEnabledPlugins(projectRoot, env) {
  const merged = {};
  const files = [
    path.join(claudeConfigDir(env), 'settings.json'),
    path.join(projectRoot, '.claude', 'settings.json'),
    path.join(projectRoot, '.claude', 'settings.local.json'),
  ];
  for (const file of files) {
    Object.assign(merged, readSettingsEnabledPlugins(file));
  }
  return merged;
}

/**
 * DD-4 step 2's `projectPath` normalisation: `path.resolve`, backslashes to forward slashes,
 * trailing `/` stripped, and lower-cased on win32.
 * @param {string} p
 * @returns {string}
 */
function normalizeProjectPath(p) {
  if (typeof p !== 'string' || !p) return '';
  let resolved = path.resolve(p).split(path.sep).join('/');
  if (resolved.length > 1 && resolved.endsWith('/')) resolved = resolved.slice(0, -1);
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return resolved;
}

/**
 * Split an `<id>@<marketplace>` enabledPlugins key into its two parts. A key with no `@` (or a
 * malformed one) is treated as having an empty marketplace, never thrown.
 * @param {string} id
 * @returns {{ idPart: string, marketplace: string }}
 */
function splitPluginId(id) {
  const atIndex = id.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === id.length - 1) return { idPart: id, marketplace: '' };
  return { idPart: id.slice(0, atIndex), marketplace: id.slice(atIndex + 1) };
}

/**
 * DD-4 step 2–3: resolve one enabled `<id>@<marketplace>` against `<claudeConfigDir>/plugins/
 * installed_plugins.json` (v2), preferring, in order, a `local`-scope entry whose `projectPath`
 * matches this project, then a `project`-scope one, then falling back to the `user`-scope entry.
 * `null` when nothing matches — the caller (DD-4 step 3) logs the skip line in that case.
 * @param {string} id
 * @param {string} projectRoot
 * @param {string} cwd
 * @param {Record<string, string|undefined>} env
 * @param {(line: string) => void} [log]
 * @returns {{ installPath: string, version: string, gitCommitSha?: string, marketplace: string }|null}
 */
function resolveInstalledPlugin(id, projectRoot, cwd, env, log) {
  const { marketplace } = splitPluginId(id);
  let parsed = null;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(claudeConfigDir(env), 'plugins', 'installed_plugins.json'), 'utf8'),
    );
  } catch {
    parsed = null;
  }
  const entries = parsed && parsed.plugins && Array.isArray(parsed.plugins[id]) ? parsed.plugins[id] : [];

  const candidates = new Set(
    [normalizeProjectPath(projectRoot), normalizeProjectPath(cwd)].filter(Boolean),
  );
  const matchesProject = (entry) =>
    entry && typeof entry.projectPath === 'string' && candidates.has(normalizeProjectPath(entry.projectPath));

  const picked =
    entries.find((e) => e && e.scope === 'local' && matchesProject(e)) ||
    entries.find((e) => e && e.scope === 'project' && matchesProject(e)) ||
    entries.find((e) => e && e.scope === 'user');

  if (!picked || typeof picked.installPath !== 'string' || !picked.installPath) {
    if (typeof log === 'function') {
      log(`harness: plugin ${id} enabled but not installed for this project — skipped`);
    }
    return null;
  }

  return {
    installPath: picked.installPath,
    version: typeof picked.version === 'string' ? picked.version : '',
    gitCommitSha: typeof picked.gitCommitSha === 'string' ? picked.gitCommitSha : undefined,
    marketplace,
  };
}

/**
 * DD-4 step 4: the plugin's display name — `.claude-plugin/plugin.json`'s `name`, falling back to
 * the id part before `@`. Also returns the parsed manifest itself (for DD-5's extra `skills`/
 * `commands` paths) — `null` when it can't be read.
 * @param {string} installPath
 * @param {string} idPart
 * @returns {{ name: string, manifest: Record<string, *>|null }}
 */
function readPluginManifest(installPath, idPart) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (manifest && typeof manifest === 'object') {
      return { name: typeof manifest.name === 'string' && manifest.name ? manifest.name : idPart, manifest };
    }
  } catch {
    // missing/malformed manifest — name falls back, and there are no extra skills/commands paths
  }
  return { name: idPart, manifest: null };
}

/** DD-19 `org-synced` path: the org folder name is masked as the literal `<org>`. */
function orgSyncedEntryPath(absFile) {
  const skillDir = path.basename(path.dirname(absFile));
  return `~/.claude/skills/synced/<org>/${skillDir}/SKILL.md`;
}

/**
 * @param {string} syncedDir - `<claudeConfigDir>/skills/synced`.
 * @returns {string[]} the absolute path of every `<org>` subdirectory (empty when missing).
 */
function listOrgDirs(syncedDir) {
  try {
    return fs
      .readdirSync(syncedDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(syncedDir, e.name));
  } catch {
    return [];
  }
}

/**
 * Build the DD-1 `skills[]` array: every project, user and enabled-plugin skill/workflow/command,
 * per DD-3–DD-5, plus every org-synced skill (metadata only). Fail-open throughout — a missing source contributes nothing, never throws.
 * @param {{ projectRoot: string, cwd?: string, env?: Record<string, string|undefined>, log?: (line: string) => void }} options
 * @returns {Array<object>} the DD-1 `skills[]` entries (never `null`; empty array when nothing is found).
 */
function buildSkillCatalog({ projectRoot, cwd, env = process.env, log } = {}) {
  const resolvedProjectRoot = typeof projectRoot === 'string' && projectRoot ? projectRoot : cwd || process.cwd();
  const resolvedCwd = typeof cwd === 'string' && cwd ? cwd : resolvedProjectRoot;
  const configDir = claudeConfigDir(env);

  const entries = [];
  const projectKeys = new Set();

  // Project — `<projectRoot>/.claude/` — always highest priority.
  for (const { kind, file, read } of scanRoot(path.join(resolvedProjectRoot, '.claude'))) {
    projectKeys.add(`${kind}:${read.name}`);
    entries.push(makeEntry(kind, read, 'project', projectEntryPath(resolvedProjectRoot, file)));
  }

  // User — `<claudeConfigDir>/` — skipped on a name collision with a project entry.
  const userKeys = new Set();
  for (const { kind, file, read } of scanRoot(configDir)) {
    if (projectKeys.has(`${kind}:${read.name}`)) continue;
    userKeys.add(`${kind}:${read.name}`);
    entries.push(makeEntry(kind, read, 'user', userEntryPath(configDir, file)));
  }

  // Plugin — every enabled `<id>@<marketplace>` resolved to its installed copy (DD-4).
  const enabledPlugins = readEnabledPlugins(resolvedProjectRoot, env);
  for (const [id, enabled] of Object.entries(enabledPlugins)) {
    if (enabled !== true) continue;
    const resolved = resolveInstalledPlugin(id, resolvedProjectRoot, resolvedCwd, env, log);
    if (!resolved) continue;

    const { idPart } = splitPluginId(id);
    const { name: pluginName, manifest } = readPluginManifest(resolved.installPath, idPart);
    const pluginMeta = {
      id,
      name: pluginName,
      marketplace: resolved.marketplace,
      version: resolved.version,
      gitCommitSha: resolved.gitCommitSha,
    };

    const candidates = [...scanRoot(resolved.installPath), ...scanPluginExtraPaths(resolved.installPath, manifest)];
    for (const { kind, file, read } of candidates) {
      entries.push(
        makeEntry(kind, read, 'plugin', pluginEntryPath(pluginName, resolved.version, resolved.installPath, file), pluginMeta),
      );
    }
  }

  // Org-synced — `<claudeConfigDir>/skills/synced/<org>/<skill>/SKILL.md` (DD-19): metadata only
  // (empty body), masked org path, skipped on a project/user name collision.
  for (const orgDir of listOrgDirs(path.join(configDir, 'skills', 'synced'))) {
    for (const { file, fallbackName } of scanSkillsDir(orgDir)) {
      const read = readMarkdownEntry(file, fallbackName);
      if (!read) continue;
      const key = `skill:${read.name}`;
      if (projectKeys.has(key) || userKeys.has(key)) continue;
      entries.push(makeEntry('skill', { ...read, body: '' }, 'org-synced', orgSyncedEntryPath(file)));
    }
  }

  return entries;
}

module.exports = { parseFrontmatter, buildSkillCatalog };
