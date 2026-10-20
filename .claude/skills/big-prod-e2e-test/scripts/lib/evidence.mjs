// "What actually happened" in a session: stream-json and transcript
// parsers, the isolation check and the exercised check. Everything except the three directory
// readers (globalHarnessNames, fixtureHarnessNames, findTranscripts) is pure.
import fs from 'node:fs';
import path from 'node:path';
import {
  ALLOWED_PLUGIN_SOURCE_RE,
  BUILTIN_PLUGIN_SOURCE_RE,
  FIXTURES_DIR,
  GLOBAL_HARNESS_DIRS,
  MODEL_DATE_SUFFIX_RE,
} from './config.mjs';

const SUBAGENT_FILE_RE = /^agent-.*\.jsonl$/;
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/g;

function uniqSorted(values) {
  return [...new Set(values.filter((v) => typeof v === 'string' && v !== ''))].sort();
}

/** JSONL text or an array of lines/objects → array of parsed objects (bad lines skipped). */
export function parseJsonl(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (line && typeof line === 'object') {
      out.push(line);
      continue;
    }
    const t = typeof line === 'string' ? line.trim() : '';
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* not JSON (a stray log line) — skip */
    }
  }
  return out;
}

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`; ids without a date suffix are unchanged. */
export function normalizeModel(model) {
  return typeof model === 'string' ? model.replace(MODEL_DATE_SUFFIX_RE, '') : null;
}

/**
 * Parses `claude -p --output-format stream-json --verbose` output.
 * Returns { sessionId, model, init, finalResult } — `init` is the first system/init event,
 * `finalResult` the LAST `result` event (Agent/Workflow runs emit a later turn).
 */
export function parseStream(lines) {
  const events = parseJsonl(lines);
  let init = null;
  let finalResult = null;
  for (const e of events) {
    if (!init && e.type === 'system' && e.subtype === 'init') init = e;
    if (e.type === 'result') finalResult = e;
  }
  const sessionId = init?.session_id ?? finalResult?.session_id ?? null;
  return { sessionId, model: normalizeModel(init?.model), init, finalResult };
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * User-level harness names that must NOT leak into an isolated session: directory names under
 * `<homeClaudeDir>/skills/` and `.md` basenames under `<homeClaudeDir>/commands/`. Missing dirs → [].
 */
export function globalHarnessNames(homeClaudeDir = path.dirname(GLOBAL_HARNESS_DIRS[0])) {
  const skills = listDir(path.join(homeClaudeDir, 'skills'))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const commands = listDir(path.join(homeClaudeDir, 'commands'))
    .filter((d) => d.isFile() && /\.md$/i.test(d.name))
    .map((d) => d.name.replace(/\.md$/i, ''));
  return uniqSorted([...skills, ...commands]);
}

/** Skill, workflow and rule names the fixtures ship under `dot-claude/` (allowed in `init`). */
export function fixtureHarnessNames(fixturesDir = FIXTURES_DIR) {
  const names = [];
  for (const repo of listDir(fixturesDir).filter((d) => d.isDirectory())) {
    const harness = path.join(fixturesDir, repo.name, 'dot-claude');
    for (const d of listDir(path.join(harness, 'skills'))) if (d.isDirectory()) names.push(d.name);
    for (const d of listDir(path.join(harness, 'workflows'))) {
      if (d.isFile()) names.push(d.name.replace(/\.[cm]?js$/i, ''));
    }
    for (const d of listDir(path.join(harness, 'rules'))) {
      if (d.isFile()) names.push(d.name.replace(/\.md$/i, ''));
    }
  }
  return uniqSorted(names);
}

function entryName(e) {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return e.name ?? null;
  return null;
}

/**
 * Isolation check on the stream-json `init` event. Passes when:
 *  - `init.mcp_servers` holds exactly the scenario's own servers (`allowedMcp`), each
 *    `connected` — empty for every scenario without an `mcp` config;
 *  - `init.slash_commands` / `init.skills` contain no global harness name (fixture names excepted);
 *  - every `init.plugins[].source` matches ALLOWED_PLUGIN_SOURCE_RE or ends with `@builtin`.
 * Returns { status: 'pass'|'fail', detail }.
 */
export function checkIsolation(init, globalNames = [], fixtureNames = [], allowedMcp = []) {
  if (!init) return { status: 'fail', detail: 'no system/init event in stream-json' };
  const problems = [];

  const mcp = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  const allowed = new Set(allowedMcp);
  const unexpected = mcp.filter((m) => !allowed.has(entryName(m)));
  if (unexpected.length > 0) {
    const desc = unexpected.map((m) => `${entryName(m) ?? '?'}${m?.source ? ` (${m.source})` : ''}`);
    problems.push(allowed.size ? `unexpected mcp_servers: ${desc.join(', ')}` : `mcp_servers not empty: ${desc.join(', ')}`);
  }
  for (const name of allowed) {
    const m = mcp.find((x) => entryName(x) === name);
    if (!m) problems.push(`mcp server ${name} missing from init`);
    else if (m.status && m.status !== 'connected') problems.push(`mcp server ${name} is ${m.status}`);
  }

  const fixture = new Set(fixtureNames);
  const forbidden = new Set(globalNames.filter((n) => !fixture.has(n)));
  const listed = [
    ...(Array.isArray(init.slash_commands) ? init.slash_commands : []),
    ...(Array.isArray(init.skills) ? init.skills : []),
  ]
    .map(entryName)
    .filter(Boolean)
    .map((n) => n.replace(/^\//, ''));
  const leaked = uniqSorted(listed.filter((n) => forbidden.has(n)));
  if (leaked.length > 0) problems.push(`global skills/commands visible: ${leaked.join(', ')}`);

  const plugins = Array.isArray(init.plugins) ? init.plugins : [];
  const extra = plugins
    .map((p) => (typeof p === 'string' ? p : (p?.source ?? p?.name ?? '?')))
    .filter((src) => !ALLOWED_PLUGIN_SOURCE_RE.test(src) && !BUILTIN_PLUGIN_SOURCE_RE.test(src));
  if (extra.length > 0) problems.push(`unexpected plugins: ${uniqSorted(extra).join(', ')}`);

  if (problems.length > 0) return { status: 'fail', detail: problems.join('; ') };
  return {
    status: 'pass',
    detail: `${allowed.size ? `only MCP ${[...allowed].join(', ')} (connected)` : 'no MCP servers'}, no global skills, plugins: ${plugins.length ? uniqSorted(plugins.map((p) => (typeof p === 'string' ? p : (p?.source ?? p?.name)))).join(', ') : 'none'}`,
  };
}

/**
 * Locates a session's local transcripts under `<configDir>/projects/<slug>/`:
 *  main      `<slug>/<sid>.jsonl`
 *  subagents `<slug>/<sid>/subagents/agent-*.jsonl` and
 *            `<slug>/<sid>/subagents/workflows/<wf-id>/agent-*.jsonl`
 * Returns { main, subagents: string[] } or null when the main transcript does not exist.
 */
export function findTranscripts(configDir, sessionId) {
  if (!sessionId) return null;
  const projects = path.join(configDir, 'projects');
  for (const slug of listDir(projects).filter((d) => d.isDirectory())) {
    const base = path.join(projects, slug.name);
    const main = path.join(base, `${sessionId}.jsonl`);
    if (!fs.existsSync(main)) continue;

    const subDir = path.join(base, sessionId, 'subagents');
    const subagents = listDir(subDir)
      .filter((d) => d.isFile() && SUBAGENT_FILE_RE.test(d.name))
      .map((d) => path.join(subDir, d.name));
    const wfRoot = path.join(subDir, 'workflows');
    for (const wf of listDir(wfRoot).filter((d) => d.isDirectory())) {
      const wfDir = path.join(wfRoot, wf.name);
      for (const d of listDir(wfDir)) {
        if (d.isFile() && SUBAGENT_FILE_RE.test(d.name)) subagents.push(path.join(wfDir, d.name));
      }
    }
    subagents.sort();
    return { main, subagents };
  }
  return null;
}

/** Reads the main + subagent transcripts into one array of lines. */
export function readTranscriptLines(transcripts) {
  if (!transcripts) return [];
  const files = [transcripts.main, ...transcripts.subagents];
  const lines = [];
  for (const f of files) {
    try {
      lines.push(...fs.readFileSync(f, 'utf8').split(/\r?\n/));
    } catch {
      /* unreadable file — contributes nothing */
    }
  }
  return lines;
}

function contentBlocks(message) {
  const c = message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

/** `.claude/rules/cli-flags.md` → `cli-flags`; null when the path is not under `.claude/rules/`. */
export function ruleNameFromPath(p) {
  if (typeof p !== 'string' || !p) return null;
  const norm = p.replace(/\\/g, '/');
  if (!/(^|\/)\.claude\/rules\//.test(norm)) return null;
  const parts = norm.split('/').filter(Boolean);
  const name = parts[parts.length - 1].replace(/\.md$/i, '');
  return name || null;
}

/** `mcp__big-test-pg__query` → `big-test-pg`; null for a non-MCP tool name. */
export function mcpServerFromTool(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null;
  const server = name.slice(5).split('__')[0];
  return server || null;
}

/**
 * Harness use from transcript lines (main AND every subagent transcript):
 *  skills    — `Skill` tool_use `input.skill` + `<command-name>/x</command-name>` user messages
 *  rules     — `nested_memory` attachments whose path is under `.claude/rules/`
 *  workflows — `Workflow` tool_use `input.name`
 *  subagents — `subagentFileCount` (regular + workflow agent files)
 *  mcp       — MCP server names from `mcp__<server>__<tool>` tool_use names
 *  reads     — `Read` tool_use `input.file_path`s, forward slashes
 * Arrays are de-duplicated and sorted.
 */
export function extractHarness(lines, subagentFileCount = 0) {
  const skills = [];
  const rules = [];
  const workflows = [];
  const mcp = [];
  const reads = [];
  for (const e of parseJsonl(lines)) {
    if (e.type === 'assistant') {
      for (const b of contentBlocks(e.message)) {
        if (b?.type !== 'tool_use') continue;
        if (b.name === 'Skill' && typeof b.input?.skill === 'string') {
          skills.push(b.input.skill.replace(/^\//, ''));
        }
        if (b.name === 'Workflow' && typeof b.input?.name === 'string') workflows.push(b.input.name);
        const server = mcpServerFromTool(b.name);
        if (server) mcp.push(server);
        if (b.name === 'Read' && typeof b.input?.file_path === 'string') reads.push(b.input.file_path.replace(/\\/g, '/'));
      }
    } else if (e.type === 'user') {
      for (const b of contentBlocks(e.message)) {
        if (b?.type !== 'text' || typeof b.text !== 'string') continue;
        for (const m of b.text.matchAll(COMMAND_NAME_RE)) skills.push(m[1]);
      }
    } else if (e.type === 'attachment' && e.attachment?.type === 'nested_memory') {
      const name = ruleNameFromPath(e.attachment.displayPath) ?? ruleNameFromPath(e.attachment.path);
      if (name) rules.push(name);
    }
  }
  return {
    skills: uniqSorted(skills),
    rules: uniqSorted(rules),
    workflows: uniqSorted(workflows),
    subagents: Number(subagentFileCount) || 0,
    mcp: uniqSorted(mcp),
    reads: uniqSorted(reads),
  };
}

/** True when some read path ends with the repo-relative `rel` (on a path-segment boundary). */
function wasRead(reads, rel) {
  const want = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  return reads.some((p) => p === want || p.endsWith(`/${want}`));
}

/**
 * Every `requires` entry is a subset of the actual evidence; `subagent` is a
 * minimum count; `reads` lists repo-relative files a `Read` call must have opened. An
 * empty `requires` (S1) means nothing was used: no skill, rule, workflow, MCP call and zero
 * subagents.
 */
export function isExercised(requires = {}, actual = {}) {
  const has = (key) => Array.isArray(actual[key]) ? actual[key] : [];
  const subagents = Number(actual.subagents) || 0;
  const keys = Object.keys(requires || {});
  if (keys.length === 0) {
    return (
      has('skills').length === 0 &&
      has('rules').length === 0 &&
      has('workflows').length === 0 &&
      has('mcp').length === 0 &&
      subagents === 0
    );
  }
  for (const key of ['skills', 'rules', 'workflows', 'mcp']) {
    const need = requires[key];
    if (!need) continue;
    const got = new Set(has(key));
    if (!need.every((n) => got.has(n))) return false;
  }
  if (requires.subagent != null && subagents < requires.subagent) return false;
  if (requires.reads && !requires.reads.every((r) => wasRead(has('reads'), r))) return false;
  return true;
}

/** Human-readable reason an attempt was not exercised (for result.json / the report). */
export function exercisedGap(requires = {}, actual = {}) {
  if (isExercised(requires, actual)) return null;
  const keys = Object.keys(requires || {});
  if (keys.length === 0) {
    return `expected no harness use, got skills=[${actual.skills ?? []}] rules=[${actual.rules ?? []}] workflows=[${actual.workflows ?? []}] mcp=[${actual.mcp ?? []}] subagents=${actual.subagents ?? 0}`;
  }
  const gaps = [];
  for (const key of ['skills', 'rules', 'workflows', 'mcp']) {
    const need = requires[key];
    if (!need) continue;
    const got = new Set(Array.isArray(actual[key]) ? actual[key] : []);
    const missing = need.filter((n) => !got.has(n));
    if (missing.length) gaps.push(`${key} missing ${missing.join(', ')}`);
  }
  if (requires.subagent != null && (Number(actual.subagents) || 0) < requires.subagent) {
    gaps.push(`subagents ${actual.subagents ?? 0} < ${requires.subagent}`);
  }
  if (requires.reads) {
    const reads = Array.isArray(actual.reads) ? actual.reads : [];
    const unread = requires.reads.filter((r) => !wasRead(reads, r));
    if (unread.length) gaps.push(`not read: ${unread.join(', ')}`);
  }
  return gaps.join('; ');
}
