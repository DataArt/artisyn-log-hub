#!/usr/bin/env node
// Discovers post-implementation check skills and prints them as JSON on stdout.
//
// Checks come from two places and both matter:
//   1. this plugin's own skills/ directory  -> reported namespaced ("adlc-lh:foo"),
//      because that is the form the Skill tool needs for a plugin component
//   2. the consuming project's .claude/skills/ -> reported bare ("foo")
//
// Scanning only (1) would make the plugin a closed set, with no way for a
// project to add a check of its own; scanning only (2) would lose every check
// the plugin ships. A project-local folder whose name matches a bundled one
// wins, so a project can override a bundled check rather than being stuck
// with it.
const fs = require('fs');
const path = require('path');

const PREFIX = 'post-impl-check-';
const MANUAL_SUFFIX = '-no-auto';

function parseFrontmatterDescription(skillMdPath) {
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return '';
  const frontmatter = match[1];
  const descMatch = frontmatter.match(/^description:\s*(.*)$/m);
  if (!descMatch) return '';
  let value = descMatch[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function capitalizeFirst(value) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// An unsubstituted "${...}" placeholder reaching us as a literal must not be
// treated as a real path — it would silently resolve to nothing.
function clean(value) {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('${')) return '';
  return trimmed;
}

// The plugin may be installed under a name the marketplace entry chose, so read
// it rather than hardcoding. Without a name, fall back to bare skill names.
function readPluginName(pluginRoot) {
  try {
    const manifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifest)) return '';
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    return typeof parsed.name === 'string' ? parsed.name : '';
  } catch {
    return '';
  }
}

function scan(skillsDir, { namespace, source }) {
  if (!skillsDir || !fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory() &&
      entry.name.startsWith(PREFIX) &&
      !entry.name.endsWith(MANUAL_SUFFIX))
    .map((entry) => {
      const id = entry.name.slice(PREFIX.length);
      const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
      const description = fs.existsSync(skillMdPath) ? parseFrontmatterDescription(skillMdPath) : '';
      return {
        id,
        name: `${capitalizeFirst(id)} Check`,
        description,
        skill: namespace ? `${namespace}:${entry.name}` : entry.name,
        source,
      };
    });
}

try {
  const pluginRoot = clean(process.env.CLAUDE_PLUGIN_ROOT) || path.resolve(__dirname, '..', '..', '..');
  const projectRoot = clean(process.argv[2]) || clean(process.env.CLAUDE_PROJECT_DIR) || process.cwd();

  const bundled = scan(path.join(pluginRoot, 'skills'), {
    namespace: readPluginName(pluginRoot),
    source: 'plugin',
  });
  const local = scan(path.join(projectRoot, '.claude', 'skills'), {
    namespace: '',
    source: 'project',
  });

  // Project entries are applied last so they override a bundled check of the
  // same id.
  const byId = new Map();
  for (const check of [...bundled, ...local]) byId.set(check.id, check);

  const checks = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

  process.stdout.write(`${JSON.stringify({ checks, pluginRoot, projectRoot }, null, 2)}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`discover-checks error: ${err.message}\n`);
  process.exit(1);
}
