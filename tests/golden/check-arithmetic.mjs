#!/usr/bin/env node
// check-arithmetic.mjs — re-derives the golden numbers without the app (impl-plan DD D3).
//
// The `expected.json` files hold literals. This script recomputes them from first principles so a
// typo in a literal, or a fixture that drifted from its table, is caught before any stand runs:
//
//   - tokens per transcript, parsed straight from the fixture JSONL (assistant lines only,
//     `isSidechain` lines of a root transcript skipped — a sub-agent transcript is sidechain
//     throughout —, one count per `message.id`, a usage without a `cache_creation`
//     object counted as all-5m, `speed: "fast"` tokens and `web_search_requests` collected);
//   - cost per node from the DD D3 rates (per Mtok, $0.01 per web search, fast mode x2 on input and
//     output), priced by the transcript's first model, `null` for a model without a rate;
//   - own / tree totals, per-prompt costs, cache read ratios, delegation share, the "wrong" prices
//     GS-04 and GS-06a must be told apart from, GS-03's context table;
//   - change-surface concentration from the folder distribution (GS-09: from the transcript's paths),
//     with the formula of docs/knowledgebase/change-surface.md §2;
//   - the System context anatomy (GS-05 `anatomy`): partition bytes from the startup block, tokens
//     at `charsPerToken`, attributed = Σ tokens, harness internals = total − attributed;
//   - the System prompt viewer (GS-05 `systemPromptView`): parts per group, parts / tools bytes and
//     tokens from the startup and tools `prompt_snapshot` lines;
//   - the Startup context recommendations (GS-05 `recommendations`): the matched catalog ids in
//     catalog order and each row's items, re-derived from the startup block and the artisyn
//     harness snapshot with the catalog rules re-implemented here (built-in = no `mcp__` prefix,
//     claude.ai stub names, configSource join by server key); row bytes = Σ items, tokens at
//     `charsPerToken`, measuredTokens = Σ tokens ≤ the anatomy total;
//   - every REPO-GOLD total in `repo-gold.expected.json`, including the merged work time per day.
//
// Usage: node tests/golden/check-arithmetic.mjs   (exit 0 all consistent, 1 on any mismatch)
// `check()` is exported for scripts/__tests__/golden-arithmetic.test.js (`npm run test:scripts`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GOLDEN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** DD D3: USD per million tokens. */
export const RATES = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
};
export const WEB_SEARCH_USD = 0.01;
export const FAST_MODE_MULTIPLIER = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `expected.json` stores ratios and money with at most six decimals. */
const TOL = 5e-7 + 1e-12;
/** Values the design states at display precision (4 decimals). */
const DISPLAY_TOL = 5e-5 + 1e-12;
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'inputFast', 'outputFast', 'webSearch'];

// ---------------------------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------------------------

export function emptyTokens() {
  return Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
}

export function addTokens(a, b) {
  const out = emptyTokens();
  for (const k of TOKEN_KEYS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

/** Cost of a token bundle at `model`'s rate; `null` when the model has no rate. */
export function costUsd(tokens, model, { fastMultiplier = FAST_MODE_MULTIPLIER, oneHourRate } = {}) {
  const r = RATES[model];
  if (!r) return null;
  const extra = fastMultiplier - 1;
  const perTok = (rate) => rate / 1e6;
  return (
    (tokens.input + tokens.inputFast * extra) * perTok(r.input) +
    (tokens.output + tokens.outputFast * extra) * perTok(r.output) +
    tokens.cacheRead * perTok(r.cacheRead) +
    tokens.cacheWrite5m * perTok(r.cacheWrite5m) +
    tokens.cacheWrite1h * perTok(oneHourRate === undefined ? r.cacheWrite1h : r[oneHourRate]) +
    tokens.webSearch * WEB_SEARCH_USD
  );
}

/** cacheRead / (cacheRead + cacheWrite); `null` at a zero denominator. */
export function cacheRatio(cacheRead, cacheWrite) {
  const denom = cacheRead + cacheWrite;
  return denom === 0 ? null : cacheRead / denom;
}

function tokensCacheRatio(t) {
  return cacheRatio(t.cacheRead, t.cacheWrite5m + t.cacheWrite1h);
}

/** Change-surface concentration (docs/knowledgebase/change-surface.md §2). `folders`: folder → file count. */
export function concentration(folders) {
  const entries = Object.entries(folders);
  const F = entries.reduce((s, [, n]) => s + n, 0);
  if (F === 0) return { score: null, band: null };
  const K = entries.length;
  let E = 1;
  if (K > 1) {
    const H = -entries.reduce((s, [, n]) => s + (n / F) * Math.log(n / F), 0);
    E = 1 - H / Math.log(K);
  }
  const S = Math.max(...entries.map(([, n]) => n)) / F;
  const segs = (f) => (f === '.' || f === '' ? [] : f.split('/'));
  const modules = new Set(entries.map(([f]) => (segs(f)[0] ?? '.')));
  const M = 1 / modules.size;
  let D = 1;
  if (K > 1) {
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < K; i++) {
      for (let j = i + 1; j < K; j++) {
        const u = segs(entries[i][0]);
        const v = segs(entries[j][0]);
        let c = 0;
        while (c < u.length && c < v.length && u[c] === v[c]) c++;
        const total = u.length + v.length;
        sum += total === 0 ? 0 : (u.length - c + (v.length - c)) / total;
        pairs++;
      }
    }
    D = 1 - sum / pairs;
  }
  const smallness = F <= 6 ? 1 - (F - 1) / 6 : 0;
  const closeness = smallness * D;
  const E2 = E + closeness * (1 - E);
  const S2 = S + closeness * (1 - S);
  let score = Math.min(100, Math.max(0, Math.round(100 * (0.4 * E2 + 0.25 * S2 + 0.2 * M + 0.15 * D))));
  if (F <= 5) score = Math.max(score, 60);
  const band = score >= 60 ? 'focused' : score >= 40 ? 'mixed' : 'scattered';
  return { score, band, modules: modules.size };
}

/** Union of `[start, end)` intervals cut at UTC day boundaries → minutes per `YYYY-MM-DD`. */
export function mergedMinutesByDay(intervals) {
  const byDay = new Map();
  for (const [s, e] of intervals) {
    for (let d = Math.floor(s / DAY_MS) * DAY_MS; d < e; d += DAY_MS) {
      const cs = Math.max(s, d);
      const ce = Math.min(e, d + DAY_MS);
      if (ce <= cs) continue;
      const key = new Date(d).toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push([cs, ce]);
    }
  }
  const out = {};
  for (const [day, list] of byDay) {
    list.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [cs, ce] = list[0];
    for (const [s, e] of list.slice(1)) {
      if (s > ce) {
        total += ce - cs;
        [cs, ce] = [s, e];
      } else ce = Math.max(ce, e);
    }
    total += ce - cs;
    out[day] = total / 60000;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fixture parsing
// ---------------------------------------------------------------------------------------------

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/**
 * Tokens and first model of one transcript, counted the way DD D3 defines them. A root transcript
 * skips `isSidechain` lines; a sub-agent's own transcript is marked sidechain on every line.
 */
export function transcriptTokens(lines, { skipSidechain = true } = {}) {
  const seen = new Set();
  const tokens = emptyTokens();
  let model = null;
  for (const line of lines) {
    if (line.type !== 'assistant' || (skipSidechain && line.isSidechain === true)) continue;
    const msg = line.message ?? {};
    if (msg.id) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    if (model === null && msg.model) model = msg.model;
    const u = msg.usage;
    if (!u) continue;
    const fast = u.speed === 'fast';
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    if (u.cache_creation && typeof u.cache_creation === 'object') {
      tokens.cacheWrite5m += u.cache_creation.ephemeral_5m_input_tokens ?? 0;
      tokens.cacheWrite1h += u.cache_creation.ephemeral_1h_input_tokens ?? 0;
    } else {
      tokens.cacheWrite5m += u.cache_creation_input_tokens ?? 0;
    }
    if (fast) {
      tokens.inputFast += u.input_tokens ?? 0;
      tokens.outputFast += u.output_tokens ?? 0;
    }
    tokens.webSearch += u.server_tool_use?.web_search_requests ?? 0;
  }
  return { tokens, model };
}

/** Repo-relative folders of every Edit/Write `file_path` under `repoRoot` (Windows or POSIX). */
function editedFolders(lines, repoRoot) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/^([a-z]):/i, (_m, d) => `${d.toLowerCase()}:`);
  const root = norm(repoRoot).replace(/\/+$/, '') + '/';
  const files = new Set();
  for (const line of lines) {
    if (line.type !== 'assistant' || line.isSidechain === true) continue;
    for (const block of line.message?.content ?? []) {
      if (block?.type !== 'tool_use' || !['Edit', 'Write', 'MultiEdit'].includes(block.name)) continue;
      const p = norm(String(block.input?.file_path ?? ''));
      if (p.startsWith(root)) files.add(p.slice(root.length));
    }
  }
  const folders = {};
  for (const f of files) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    folders[dir] = (folders[dir] ?? 0) + 1;
  }
  return folders;
}

/** Partition kinds of the System context anatomy, harness internals excluded. */
export const ANATOMY_KINDS = [
  'system-prompt', 'memory', 'tool-definitions', 'environment', 'deferred-tools', 'mcp-server',
  'agent-types', 'skills', 'instruction-file', 'system-reminder', 'first-prompt',
];
const ANATOMY_OWN_TYPES = new Set([
  'prompt_snapshot', 'deferred_tools_delta', 'mcp_instructions_delta', 'agent_listing_delta',
  'skill_listing', 'instructions', 'session_context',
]);
const ANATOMY_IGNORED_TYPES = new Set(['deferred_tools_record', 'nested_memory']);

/**
 * Startup-context anatomy of a root transcript, re-derived independently of the client builder
 * (docs/knowledgebase/algorithms/sysctx-anatomy.md): partition bytes from the lines before the
 * first non-sidechain assistant line with usage, the exact total from that line's usage.
 */
export function startupAnatomy(lines) {
  const utf8 = (s) => Buffer.byteLength(String(s), 'utf8');
  let anchor = lines.findIndex((l) => l.type === 'assistant' && l.isSidechain !== true && l.message?.usage);
  let total = null;
  if (anchor >= 0) {
    const u = lines[anchor].message.usage;
    total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  } else {
    anchor = lines.findIndex((l) => l.type === 'assistant');
    if (anchor < 0) anchor = lines.length;
  }
  const block = lines.slice(0, anchor).filter((l) => l.isSidechain !== true);
  const atts = block.filter((l) => l.type === 'attachment' && typeof l.attachment?.type === 'string').map((l) => l.attachment);
  const bytes = Object.fromEntries(ANATOMY_KINDS.map((k) => [k, 0]));
  const listing = atts.filter((a) => a.type === 'skill_listing');
  const initial = listing.find((a) => a.isInitial === true) ?? listing[0];
  if (initial) bytes.skills = utf8(initial.content ?? '');
  const promptSnapshot = atts.find((a) => a.type === 'prompt_snapshot');
  for (const b of promptSnapshot?.systemPrompt ?? []) {
    const text = typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : JSON.stringify(b ?? '');
    if (text.trim() === '' || text.trim() === DYNAMIC_BOUNDARY_MARKER) continue;
    const first = text.split('\n').find((l) => l.trim() !== '');
    bytes[first?.trim() === '# Memory' ? 'memory' : 'system-prompt'] += utf8(text);
  }
  for (const a of atts) {
    if (a.type === 'instructions') {
      for (const f of a.files ?? []) {
        const isMemory = /\/MEMORY\.md$/.test(String(f.path ?? '').replace(/\\/g, '/'));
        bytes[isMemory ? 'memory' : 'instruction-file'] += utf8(f.content ?? '');
      }
    } else if (a.type === 'deferred_tools_delta') {
      (a.addedNames ?? []).forEach((name, i) => {
        bytes[/^mcp__.+?__/.test(name) ? 'mcp-server' : 'deferred-tools'] += utf8(a.addedLines?.[i] ?? name) + 1;
      });
    } else if (a.type === 'mcp_instructions_delta') {
      for (const block of a.addedBlocks ?? []) bytes['mcp-server'] += utf8(block);
    } else if (a.type === 'agent_listing_delta') {
      (a.addedTypes ?? []).forEach((_t, i) => (bytes['agent-types'] += utf8(a.addedLines?.[i] ?? '') + 1));
    } else if (a.type === 'session_context') {
      for (const v of Object.values(a.context ?? {})) bytes['system-reminder'] += utf8(typeof v === 'string' ? v : JSON.stringify(v ?? ''));
    } else if (!ANATOMY_OWN_TYPES.has(a.type) && !ANATOMY_IGNORED_TYPES.has(a.type)) {
      bytes.environment += utf8(JSON.stringify(a));
    }
  }
  for (const l of block.filter((x) => x.type === 'user')) {
    const c = l.message?.content;
    if (typeof c === 'string') bytes['first-prompt'] += utf8(c);
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p?.type === 'text' && typeof p.text === 'string' && !p.text.startsWith('<system-reminder>')) bytes['first-prompt'] += utf8(p.text);
      }
    }
  }
  bytes['tool-definitions'] = firstRequestTools(block, lines).reduce((s, t) => s + t.bytes, 0);
  return { total, bytes };
}

/** Boundary part between the shared and the session-specific system prompt parts. */
const DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

/**
 * Tool definitions of the first request: the `api-request-shape` named by the first main
 * `api-request` of the startup block, else the first non-sidechain `prompt_snapshot` with tools.
 * A tool is name + description + compact JSON of its input schema (inside `schema` when the snapshot
 * keeps the whole wire tool there, else `input_schema` / `schema`). `defer_loading` tools are dropped.
 */
export function firstRequestTools(block, lines) {
  const utf8 = (s) => Buffer.byteLength(String(s), 'utf8');
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const req = block.find(
    (l) => l.type === 'api-request' && typeof l.shapeHash === 'string' && (l.querySource === undefined || l.querySource === 'repl_main_thread'),
  );
  let tools = req ? lines.find((l) => l.type === 'api-request-shape' && l.shapeHash === req.shapeHash)?.shape?.tools : null;
  if (!Array.isArray(tools) || tools.length === 0) {
    const snap = lines.find(
      (l) => l.isSidechain !== true && l.type === 'attachment' && l.attachment?.type === 'prompt_snapshot' && Array.isArray(l.attachment.tools) && l.attachment.tools.length > 0,
    );
    tools = snap ? snap.attachment.tools : [];
  }
  const out = [];
  for (const t0 of tools) {
    const t = isObj(t0) ? t0 : {};
    const whole = isObj(t.schema) && 'input_schema' in t.schema;
    if ((whole ? t.schema : t).defer_loading === true || t.defer_loading === true) continue;
    const schema = whole ? t.schema.input_schema : t.schema === undefined ? t.input_schema : t.schema;
    const bytes = utf8(t.name ?? '') + utf8(t.description ?? '') + (schema == null ? 0 : utf8(JSON.stringify(schema)));
    out.push({ name: t.name ?? null, bytes });
  }
  return out;
}

/**
 * System prompt viewer numbers of a root transcript, re-derived independently of the client builder
 * (docs/knowledgebase/algorithms/system-prompt-view.md). Byte sizes only — masking does not change
 * them, because sizes come from the raw text:
 *   - startup snapshot = first non-sidechain `prompt_snapshot` inside the startup block (the lines
 *     before the first non-sidechain assistant line with usage), else the first one anywhere;
 *   - tools = `firstRequestTools` (wire shape, else the first snapshot with tools), the same set
 *     as the anatomy's Tool definitions partition;
 *   - parts before the first boundary marker are shared, after it session; further markers and
 *     blank parts are dropped; ungrouped when there is no marker;
 *   - tokens = round(Σ bytes / cpt), rounded once per sum.
 */
export function systemPromptView(lines, cpt) {
  const utf8 = (s) => Buffer.byteLength(String(s), 'utf8');
  const main = lines.filter((l) => l.isSidechain !== true);
  const isSnapshot = (l) => l.type === 'attachment' && l.attachment && typeof l.attachment === 'object' && l.attachment.type === 'prompt_snapshot';
  let anchor = main.findIndex((l) => l.type === 'assistant' && l.message?.usage);
  if (anchor < 0) anchor = main.findIndex((l) => l.type === 'assistant');
  if (anchor < 0) anchor = main.length;
  const startup = main.slice(0, anchor).find(isSnapshot) ?? main.find(isSnapshot);

  let shared = 0;
  let session = 0;
  let ungrouped = 0;
  let partsBytes = 0;
  let marker = false;
  const raw = Array.isArray(startup?.attachment.systemPrompt) ? startup.attachment.systemPrompt : [];
  const texts = raw.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : JSON.stringify(p ?? '')));
  const grouped = texts.some((t) => t.trim() === DYNAMIC_BOUNDARY_MARKER);
  for (const text of texts) {
    if (text.trim() === DYNAMIC_BOUNDARY_MARKER) {
      marker = true;
      continue;
    }
    if (text.trim() === '') continue;
    partsBytes += utf8(text);
    if (!grouped) ungrouped++;
    else if (marker) session++;
    else shared++;
  }

  const tools = firstRequestTools(main.slice(0, anchor), lines);
  const toolsBytes = tools.reduce((s, t) => s + t.bytes, 0);
  const parts = shared + session + ungrouped;
  const totalBytes = partsBytes + toolsBytes;
  return {
    parts,
    shared,
    session,
    partsBytes,
    partsTokens: Math.round(partsBytes / cpt),
    tools: tools.length,
    toolsBytes,
    toolsTokens: Math.round(toolsBytes / cpt),
    totalBytes,
    totalTokens: Math.round(totalBytes / cpt),
  };
}

/** Built-in tool names of the startup-recommendations catalog entries (#1, #2, #13). */
const RARE_BUILTIN_TOOLS = ['Artifact', 'Workflow', 'ScheduleWakeup', 'SendFeedback', 'ShareOnboardingGuide', 'ReportFindings'];
const INTERACTION_TOOLS = ['AskUserQuestion', 'Agent', 'ListAgents'];
const STUB_NAME = /__(authenticate|complete_authentication)$/;

/**
 * Startup context recommendations of a root transcript, re-derived independently of the client
 * adapter and of `@loghub/recommendations` (docs/knowledgebase/algorithms/startup-recommendations.md):
 *   - facts straight from the startup block (the lines before the first non-sidechain assistant line
 *     with usage) and the artisyn `harness-snapshot`: tools via `firstRequestTools`, one MCP server
 *     per `mcp__<server>__` prefix of the startup deferred names (name bytes + 1 each) plus its
 *     `mcp_instructions_delta` blocks, joined to the snapshot `mcpServers` by key (configSource,
 *     connected === false = failed); skills sliced from the initial `skill_listing` and joined to
 *     the snapshot skills (source, plugin.id); memory bytes from `startupAnatomy`; the `instructions`
 *     files that are not MEMORY.md (type User = user, anything else = project; repo-relative names);
 *     agent types from `agent_listing_delta`;
 *   - the catalog rules, in catalog order: a built-in tool is a name without the `mcp__` prefix
 *     (the snapshot `server` field is ignored); a claude.ai server (key `claude_ai_…`) is a stub when
 *     every startup name ends `__authenticate` / `__complete_authentication`; its names go to the
 *     stubs or the connectors row, its instructions only to the instructions row; a non-claude.ai
 *     server goes to the user row (configSource user, or no configSource with a snapshot and no
 *     `plugin_` key) or the project row with names + instructions (0 when failed); the failed row
 *     is status only (0 B); org skills win over plugin skills, plugin skills group per plugin id;
 *   - items sorted bytes descending (ties first-seen), row bytes = Σ items, tokens = round(bytes / cpt).
 */
export function startupRecommendations(lines, artisyn, cpt) {
  const utf8 = (s) => Buffer.byteLength(String(s), 'utf8');
  const key = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');
  let anchor = lines.findIndex((l) => l.type === 'assistant' && l.isSidechain !== true && l.message?.usage);
  if (anchor < 0) anchor = lines.length;
  const block = lines.slice(0, anchor).filter((l) => l.isSidechain !== true);
  const atts = block.filter((l) => l.type === 'attachment' && typeof l.attachment?.type === 'string').map((l) => l.attachment);
  const snapshot = artisyn.find((l) => l.type === 'harness-snapshot') ?? null;
  const repoRoot = (artisyn.find((l) => l.git?.root)?.git.root ?? '').replace(/\/+$/, '');

  // Facts.
  const tools = firstRequestTools(block, lines);
  const servers = new Map();
  const server = (k) => {
    if (!servers.has(k)) servers.set(k, { key: k, label: k, names: [], namesBytes: 0, instrBytes: 0, failed: false, configSource: null });
    return servers.get(k);
  };
  for (const a of atts) {
    if (a.type === 'deferred_tools_delta') {
      (a.addedNames ?? []).forEach((name, i) => {
        const m = /^mcp__(.+?)__/.exec(name);
        if (!m) return;
        const s = server(m[1]);
        s.names.push(name);
        s.namesBytes += utf8(a.addedLines?.[i] ?? name) + 1;
      });
    } else if (a.type === 'mcp_instructions_delta') {
      (a.addedNames ?? []).forEach((name, i) => (server(key(name)).instrBytes += utf8(a.addedBlocks?.[i] ?? '')));
    }
  }
  for (const sm of snapshot?.mcpServers ?? []) {
    const k = key(sm.name);
    if (!servers.has(k) && sm.connected !== false) continue;
    const s = server(k);
    s.label = sm.name;
    s.configSource = sm.configSource === 'user' || sm.configSource === 'project' ? sm.configSource : null;
    if (sm.connected === false) s.failed = true;
  }
  const listing = atts.filter((a) => a.type === 'skill_listing');
  const initial = listing.find((a) => a.isInitial === true) ?? listing[0];
  const content = String(initial?.content ?? '');
  const starts = (initial?.names ?? []).map((name) => ({ name, at: content.indexOf(`- ${name}: `) }));
  const found = starts.filter((s) => s.at >= 0).map((s) => s.at).sort((x, y) => x - y);
  const skills = starts.map(({ name, at }) => {
    const entry = snapshot?.skills?.find((e) => e.name === name);
    const end = at < 0 ? at : found.find((f) => f > at) ?? content.length;
    return { name, bytes: at < 0 ? 0 : utf8(content.slice(at, end)), source: entry?.source ?? null, pluginId: entry?.plugin?.id ?? null };
  });
  const memoryBytes = startupAnatomy(lines).bytes.memory;
  const instructionFiles = atts
    .filter((a) => a.type === 'instructions')
    .flatMap((a) => a.files ?? [])
    .filter((f) => !/\/MEMORY\.md$/.test(String(f.path ?? '').replace(/\\/g, '/')))
    .map((f) => {
      const p = String(f.path ?? '').replace(/\\/g, '/');
      return { path: repoRoot && p.startsWith(`${repoRoot}/`) ? p.slice(repoRoot.length + 1) : p, bytes: utf8(f.content ?? ''), source: f.type === 'User' ? 'user' : 'project' };
    });
  const agentTypes = atts
    .filter((a) => a.type === 'agent_listing_delta')
    .flatMap((a) => (a.addedTypes ?? []).map((t, i) => ({ name: String(t), bytes: utf8(a.addedLines?.[i] ?? '') + 1 })));

  // Catalog rules (catalog order).
  const builtin = tools.filter((t) => !/^mcp__/.test(t.name ?? ''));
  const named = (list) => builtin.filter((t) => list.includes(t.name)).map((t) => ({ name: t.name, bytes: t.bytes }));
  const all = [...servers.values()];
  const claudeAi = all.filter((s) => s.key.startsWith('claude_ai_'));
  const isStub = (s) => s.names.length > 0 && s.names.every((n) => STUB_NAME.test(n));
  const other = all.filter((s) => !s.key.startsWith('claude_ai_'));
  const serverItem = (s) => ({ name: s.label, bytes: s.failed ? 0 : s.namesBytes + s.instrBytes });
  const orgSkill = (s) => s.source === 'org-synced' || s.name.startsWith('anthropic-skills:');
  const plugins = new Map();
  for (const s of skills.filter((x) => x.source === 'plugin' && !orgSkill(x))) {
    const id = s.pluginId ?? '(unknown plugin)';
    plugins.set(id, (plugins.get(id) ?? 0) + s.bytes);
  }
  const hasShells = builtin.some((t) => t.name === 'Bash') && builtin.some((t) => t.name === 'PowerShell');
  const catalog = [
    ['startup.rare-builtin-tools', () => named(RARE_BUILTIN_TOOLS)],
    ['startup.two-shells', () => (hasShells ? named(['Bash', 'PowerShell']) : [])],
    ['startup.claudeai-connector-stubs', () => claudeAi.filter(isStub).map((s) => ({ name: s.label, bytes: s.namesBytes }))],
    ['startup.claudeai-connectors', () => claudeAi.filter((s) => s.names.length > 0 && !isStub(s)).map((s) => ({ name: s.label, bytes: s.namesBytes }))],
    ['startup.claudeai-instructions', () => claudeAi.filter((s) => s.instrBytes > 0).map((s) => ({ name: s.label, bytes: s.instrBytes }))],
    ['startup.org-synced-skills', () => skills.filter(orgSkill).map((s) => ({ name: s.name, bytes: s.bytes }))],
    ['startup.user-mcp-servers', () => other.filter((s) => s.configSource === 'user' || (snapshot && s.configSource === null && !s.key.startsWith('plugin_'))).map(serverItem)],
    ['startup.auto-memory', () => (memoryBytes > 0 ? [{ name: 'MEMORY.md', bytes: memoryBytes }] : [])],
    ['startup.project-claude-md', () => instructionFiles.filter((f) => f.source === 'project' && f.bytes > 0).map((f) => ({ name: f.path, bytes: f.bytes }))],
    ['startup.project-mcp-servers', () => other.filter((s) => s.configSource === 'project').map(serverItem)],
    ['startup.failed-mcp-servers', () => all.filter((s) => s.failed).map((s) => ({ name: s.label, bytes: 0 }))],
    ['startup.plugin-skills', () => [...plugins].map(([name, bytes]) => ({ name, bytes }))],
    ['startup.interaction-tools', () => named(INTERACTION_TOOLS)],
    ['startup.subagent-types', () => agentTypes.map((t) => ({ name: t.name, bytes: t.bytes }))],
  ];
  const ids = [];
  const rows = {};
  for (const [id, match] of catalog) {
    const items = match();
    if (items.length === 0) continue;
    const sorted = items.map((it, i) => ({ ...it, i })).sort((x, y) => y.bytes - x.bytes || x.i - y.i);
    const bytes = sorted.reduce((s, it) => s + it.bytes, 0);
    ids.push(id);
    rows[id] = { items: Object.fromEntries(sorted.map((it) => [it.name, it.bytes])), bytes, tokens: Math.round(bytes / cpt) };
  }
  return { ids, rows, count: ids.length, measuredTokens: Object.values(rows).reduce((s, r) => s + r.tokens, 0) };
}

export function listFixtures(dir = GOLDEN_DIR) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^gs-\d{2}-/.test(e.name))
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

/**
 * Runs every consistency check. Returns `{ checks, failures }`; each failure is
 * `{ where, actual, expected }`. Never throws on a mismatch.
 */
export function check({ dir = GOLDEN_DIR } = {}) {
  const failures = [];
  let checks = 0;
  const eq = (where, actual, expected, tol = TOL) => {
    checks++;
    const ok =
      typeof actual === 'number' && typeof expected === 'number'
        ? Math.abs(actual - expected) <= tol
        : JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures.push({ where, actual, expected });
  };
  const eqTokens = (where, actual, expected) => {
    for (const k of TOKEN_KEYS) eq(`${where}.${k}`, actual[k], expected?.[k] ?? 0);
  };

  const roots = [];
  for (const folder of listFixtures(dir)) {
    const fdir = path.join(dir, folder);
    const manifest = JSON.parse(fs.readFileSync(path.join(fdir, 'upload.json'), 'utf8'));
    const expectedFile = path.join(fdir, 'expected.json');
    if (!fs.existsSync(expectedFile)) {
      failures.push({ where: `${folder}/expected.json`, actual: 'missing', expected: 'present' });
      continue;
    }
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    eq(`${folder}.fixture`, expected.fixture, manifest.fixture);
    eq(`${folder}.roots`, expected.roots.map((r) => r.key), manifest.roots.map((r) => r.key));

    for (const root of manifest.roots) {
      const exp = expected.roots.find((r) => r.key === root.key);
      if (!exp) continue;
      const at = `${folder}/${root.key}`;
      const rootLines = readJsonl(path.join(fdir, root.claude));
      const artisyn = readJsonl(path.join(fdir, root.artisyn));
      const nodeFiles = [{ key: 'root', file: root.claude, parent: null }, ...root.subagents.map((s) => ({ key: s.key, file: s.file }))];

      // Tokens and cost per node, from the transcript.
      let own = null;
      let tree = emptyTokens();
      let treeCost = 0;
      let treePriced = true;
      for (const nf of nodeFiles) {
        const node = exp.nodes.find((n) => n.key === nf.key);
        if (!node) {
          failures.push({ where: `${at}.nodes`, actual: 'missing', expected: nf.key });
          continue;
        }
        const parsed =
          nf.key === 'root'
            ? transcriptTokens(rootLines)
            : transcriptTokens(readJsonl(path.join(fdir, nf.file)), { skipSidechain: false });
        eq(`${at}.nodes.${nf.key}.model`, parsed.model, node.model);
        eqTokens(`${at}.nodes.${nf.key}.tokens(parsed)`, parsed.tokens, node.tokens);
        const c = costUsd(node.tokens, node.model);
        eq(`${at}.nodes.${nf.key}.costUsd`, c, node.costUsd);
        if (c === null) treePriced = false;
        else treeCost += c;
        tree = addTokens(tree, node.tokens);
        if (nf.key === 'root') own = node.tokens;
      }
      eq(`${at}.nodes.count`, exp.nodes.length, nodeFiles.length);
      eqTokens(`${at}.tokens.own`, own, exp.tokens.own);
      eqTokens(`${at}.tokens.tree`, tree, exp.tokens.tree);
      eq(`${at}.costUsd`, treePriced ? treeCost : null, exp.costUsd);
      eq(`${at}.ownCostUsd`, costUsd(own, exp.model), exp.ownCostUsd);
      eq(`${at}.costUnavailableReason`, RATES[exp.model] ? null : 'unknown-model', exp.costUnavailableReason);
      eq(`${at}.cacheRatio.own`, tokensCacheRatio(own), exp.cacheRatio.own);
      eq(`${at}.cacheRatio.tree`, tokensCacheRatio(tree), exp.cacheRatio.tree);
      if (exp.delegationShare !== undefined) {
        eq(`${at}.delegationShare`, (exp.costUsd - exp.ownCostUsd) / exp.costUsd, exp.delegationShare);
      }

      // Times (docs/knowledgebase/algorithms/session-time-span.md): the session starts at the first
      // artisyn prompt_start (falling back to the earliest artisyn line) and ends at the last line,
      // which is the same in the transcript and in artisyn; prompts and work time add up.
      const stamps = rootLines.map((l) => l.timestamp).filter(Boolean).sort();
      const artisynStamps = artisyn.map((l) => l.timestamp).filter(Boolean).sort();
      const promptStamps = artisyn
        .filter((l) => l.event === 'prompt_start')
        .map((l) => l.timestamp)
        .filter(Boolean)
        .sort();
      eq(`${at}.start(first artisyn prompt_start)`, promptStamps[0] ?? artisynStamps[0], exp.start);
      eq(`${at}.end(last transcript line)`, stamps.at(-1), exp.end);
      eq(`${at}.end(last artisyn line)`, artisynStamps.at(-1), exp.end);
      eq(`${at}.transcript first line <= start`, stamps[0] <= exp.start, true);
      eq(`${at}.durationMs`, Date.parse(exp.end) - Date.parse(exp.start), exp.durationMs);
      eq(`${at}.prompts(artisyn prompt_start)`, artisyn.filter((l) => l.event === 'prompt_start').length, exp.prompts);
      if (exp.perPrompt) {
        eq(`${at}.perPrompt.workTimeMs sum`, exp.perPrompt.reduce((s, p) => s + p.workTimeMs, 0), exp.workTimeMs);
        if (exp.perPrompt.every((p) => p.tokens)) {
          eqTokens(`${at}.perPrompt.tokens sum`, exp.perPrompt.reduce((s, p) => addTokens(s, p.tokens), emptyTokens()), own);
          exp.perPrompt.forEach((p, i) => {
            eq(`${at}.perPrompt[${i}].costUsd`, costUsd(p.tokens, exp.model), p.costUsd);
            if (p.cacheRatio !== undefined) eq(`${at}.perPrompt[${i}].cacheRatio`, tokensCacheRatio(p.tokens), p.cacheRatio);
            if (p.costWithSubagentsUsd !== undefined) {
              const sub = p.subagents.reduce((s, k) => s + exp.nodes.find((n) => n.key === k).costUsd, 0);
              eq(`${at}.perPrompt[${i}].costWithSubagentsUsd`, p.costUsd + sub, p.costWithSubagentsUsd);
            }
          });
        }
      }
      if (exp.events) {
        eqTokens(`${at}.events.tokens sum`, exp.events.reduce((s, e) => addTokens(s, e.tokens), emptyTokens()), own);
        eq(`${at}.events.workTimeMs sum`, exp.events.reduce((s, e) => s + e.workTimeMs, 0), exp.workTimeMs);
      }
      if (exp.wrongCostsUsd) {
        const w = exp.wrongCostsUsd;
        if (w.oneHourAtFiveMinuteRate !== undefined) eq(`${at}.wrong.oneHourAtFiveMinuteRate`, costUsd(own, exp.model, { oneHourRate: 'cacheWrite5m' }), w.oneHourAtFiveMinuteRate);
        if (w.flatCacheWrite !== undefined) eq(`${at}.wrong.flatCacheWrite`, costUsd(own, exp.model, { oneHourRate: 'cacheWrite5m' }), w.flatCacheWrite);
        if (w.noFastSurcharge !== undefined) eq(`${at}.wrong.noFastSurcharge`, costUsd(own, exp.model, { fastMultiplier: 1 }), w.noFastSurcharge);
        if (w.pricedByOpus5 !== undefined) eq(`${at}.wrong.pricedByOpus5`, costUsd(own, 'claude-opus-5'), w.pricedByOpus5);
        if (w.pricedByAlphabeticallyFirstModel !== undefined) {
          const first = [...new Set(exp.events.map((e) => e.model))].sort()[0];
          eq(`${at}.wrong.pricedByAlphabeticallyFirstModel`, costUsd(own, first), w.pricedByAlphabeticallyFirstModel);
        }
      }
      if (exp.turns) {
        exp.turns.forEach((t) => eq(`${at}.turns[${t.turn}].context`, t.input + t.cacheRead + t.cacheWrite, t.context));
        eq(`${at}.turns.cacheRead sum`, exp.turns.reduce((s, t) => s + t.cacheRead, 0), own.cacheRead);
        eq(`${at}.turns.cacheWrite sum`, exp.turns.reduce((s, t) => s + t.cacheWrite, 0), own.cacheWrite5m + own.cacheWrite1h);
        eq(`${at}.turns.input sum`, exp.turns.reduce((s, t) => s + t.input, 0), own.input);
        eq(`${at}.peakContext`, Math.max(...exp.turns.map((t) => t.context)), exp.peakContext);
        eq(`${at}.turnsNearCeiling`, exp.turns.filter((t) => t.context >= 0.8 * exp.contextWindow).length, exp.turnsNearCeiling);
        const causes = exp.cacheCreationCauses;
        for (const [k, v] of Object.entries(causes)) {
          eq(`${at}.cacheCreationCauses.${k} sum`, v.compaction + v.fileReread + v.unattributed, own.cacheWrite5m + own.cacheWrite1h);
        }
      }

      // System context anatomy (GS-05): partitions re-derived from the startup block.
      if (exp.anatomy) {
        const an = exp.anatomy;
        const derived = startupAnatomy(rootLines);
        eq(`${at}.anatomy.total(first usage)`, derived.total, an.total);
        eq(`${at}.anatomy.partitions keys`, Object.keys(an.partitions), ANATOMY_KINDS);
        let attributed = 0;
        for (const kind of ANATOMY_KINDS) {
          const p = an.partitions[kind];
          eq(`${at}.anatomy.partitions.${kind}.bytes`, derived.bytes[kind], p?.bytes);
          eq(`${at}.anatomy.partitions.${kind}.tokens`, Math.round((p?.bytes ?? 0) / an.charsPerToken), p?.tokens);
          attributed += p?.tokens ?? 0;
        }
        eq(`${at}.anatomy.attributed`, attributed, an.attributed);
        eq(`${at}.anatomy.harnessInternals = total - attributed`, an.total - an.attributed, an.harnessInternals);
      }

      // System prompt viewer (GS-05): parts, groups, bytes and tokens re-derived from the snapshots.
      if (exp.systemPromptView) {
        const spv = exp.systemPromptView;
        const derived = systemPromptView(rootLines, spv.charsPerToken);
        for (const [k, v] of Object.entries(derived)) eq(`${at}.systemPromptView.${k}`, v, spv[k]);
      }

      // Startup context recommendations (GS-05): matched rows re-derived from the startup block and the snapshot.
      if (exp.recommendations) {
        const rec = exp.recommendations;
        const derived = startupRecommendations(rootLines, artisyn, rec.charsPerToken);
        if (exp.anatomy) {
          eq(`${at}.recommendations.charsPerToken = anatomy`, rec.charsPerToken, exp.anatomy.charsPerToken);
          eq(`${at}.recommendations.denominator = anatomy total`, rec.denominator, exp.anatomy.total);
        }
        eq(`${at}.recommendations.ids`, derived.ids, rec.ids);
        eq(`${at}.recommendations.count = ids.length`, rec.ids.length, rec.count);
        eq(`${at}.recommendations.rows keys`, Object.keys(rec.rows), rec.ids);
        for (const id of rec.ids) {
          const r = rec.rows[id];
          eq(`${at}.recommendations.rows.${id}.items`, derived.rows[id]?.items, r?.items);
          eq(`${at}.recommendations.rows.${id}.bytes = Σ items`, Object.values(r?.items ?? {}).reduce((s, b) => s + b, 0), r?.bytes);
          eq(`${at}.recommendations.rows.${id}.tokens`, Math.round((r?.bytes ?? 0) / rec.charsPerToken), r?.tokens);
        }
        eq(`${at}.recommendations.measuredTokens = Σ tokens`, rec.ids.reduce((s, id) => s + (rec.rows[id]?.tokens ?? 0), 0), rec.measuredTokens);
        eq(`${at}.recommendations.measuredTokens <= denominator`, rec.measuredTokens <= rec.denominator, true);
      }

      // Lines, tools, change surface.
      const subLines = exp.nodes.filter((n) => n.lines).map((n) => n.lines);
      if (subLines.length > 0) {
        eq(`${at}.lines.written = own + nodes`, exp.lines.writtenOwn + subLines.reduce((s, l) => s + l.written, 0), exp.lines.written);
        eq(`${at}.lines.added = nodes`, subLines.reduce((s, l) => s + l.added, 0), exp.lines.added);
        eq(`${at}.lines.removed = nodes`, subLines.reduce((s, l) => s + l.removed, 0), exp.lines.removed);
        eq(`${at}.lines.editWriteCalls = nodes`, subLines.reduce((s, l) => s + l.editWriteCalls, 0), exp.lines.editWriteCalls);
      }
      if (exp.edits) {
        eq(`${at}.edits.written sum`, exp.edits.reduce((s, e) => s + e.written, 0), exp.lines.written);
        eq(`${at}.edits.added sum`, exp.edits.reduce((s, e) => s + e.added, 0), exp.lines.added);
        eq(`${at}.edits.removed sum`, exp.edits.reduce((s, e) => s + e.removed, 0), exp.lines.removed);
        eq(`${at}.edits.count`, exp.edits.length, exp.lines.editWriteCalls);
        const outside = exp.edits.filter((e) => e.outsideRepo);
        eq(`${at}.changeSurface.linesAdded (in repo)`, exp.lines.added - outside.reduce((s, e) => s + e.added, 0), exp.changeSurface.linesAdded);
        eq(`${at}.changeSurface.outsideRepoFiles`, outside.length, exp.changeSurface.outsideRepoFiles);
      }
      for (const [tool, t] of Object.entries(exp.tools ?? {})) {
        eq(`${at}.tools.${tool}.calls`, t.successes + t.failures + t.unresolved, t.calls);
        if (t.failureRate !== undefined) {
          eq(`${at}.tools.${tool}.failureRate`, t.successes + t.failures === 0 ? 0 : t.failures / (t.successes + t.failures), t.failureRate);
        }
      }
      if (exp.costPerLineUsd !== undefined) eq(`${at}.costPerLineUsd`, exp.costUsd / exp.lines.written, exp.costPerLineUsd, DISPLAY_TOL);
      if (exp.linesPerAutonomousHour !== undefined) {
        eq(`${at}.linesPerAutonomousHour`, (exp.lines.written * 3600000) / exp.workTimeMs, exp.linesPerAutonomousHour);
      }
      const cs = exp.changeSurface;
      let folders = cs.folders;
      if (!folders) {
        const gitRoot = artisyn.find((l) => l.git?.root)?.git.root;
        folders = editedFolders(rootLines, gitRoot);
      }
      const conc = concentration(folders);
      eq(`${at}.changeSurface.changedFiles`, Object.values(folders).reduce((s, n) => s + n, 0), cs.changedFiles);
      eq(`${at}.changeSurface.foldersTouched`, Object.keys(folders).length, cs.foldersTouched);
      eq(`${at}.changeSurface.singleFileFolders`, Object.values(folders).filter((n) => n === 1).length, cs.singleFileFolders);
      eq(`${at}.changeSurface.topLevelModules`, conc.score === null ? 0 : conc.modules, cs.topLevelModules);
      eq(`${at}.changeSurface.concentration`, conc.score, cs.concentration);
      eq(`${at}.changeSurface.band`, conc.band, cs.band);

      roots.push({ ...exp, own, tree, subNodes: exp.nodes.length - 1 });
    }
  }

  // REPO-GOLD totals.
  const repoFile = path.join(dir, 'repo-gold.expected.json');
  if (!fs.existsSync(repoFile)) {
    failures.push({ where: 'repo-gold.expected.json', actual: 'missing', expected: 'present' });
    return { checks, failures };
  }
  const repo = JSON.parse(fs.readFileSync(repoFile, 'utf8'));
  const priced = roots.filter((r) => r.costUsd !== null);
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
  const group = (list, keyOf) => {
    const m = {};
    for (const r of list) (m[keyOf(r)] ??= []).push(r);
    return m;
  };

  eq('repo.rootSessions', roots.length, repo.rootSessions);
  eq('repo.sessionsWithDescendants', roots.length + sum(roots, (r) => r.subNodes), repo.sessionsWithDescendants);
  eq('repo.costUsd', sum(priced, (r) => r.costUsd), repo.costUsd);
  const byBranch = group(roots, (r) => r.branch);
  for (const [b, list] of Object.entries(byBranch)) {
    eq(`repo.costByBranch.${b}`, sum(list.filter((r) => r.costUsd !== null), (r) => r.costUsd), repo.costByBranch[b]);
    eq(`repo.sessionsByBranch.${b}`, list.length, repo.sessionsByBranch[b]);
    eq(`repo.workTimeMsByBranch.${b}`, sum(list, (r) => r.workTimeMs), repo.workTimeMsByBranch[b]);
    eq(`repo.linesWrittenByBranch.${b}`, sum(list, (r) => r.lines.written), repo.linesWrittenByBranch[b]);
  }
  eq('repo.costByBranch keys', Object.keys(byBranch).sort(), Object.keys(repo.costByBranch).sort());
  const byWeek = group(roots, (r) => r.week);
  for (const [w, list] of Object.entries(byWeek)) {
    eq(`repo.costByWeek.${w}`, sum(list.filter((r) => r.costUsd !== null), (r) => r.costUsd), repo.costByWeek[w]);
    eq(`repo.sessionsByWeek.${w}`, list.length, repo.sessionsByWeek[w]);
  }
  for (const r of roots) {
    const weekOf = Math.floor((Date.parse(r.start) - Date.parse(repo.range.start)) / (7 * DAY_MS)) + 1;
    eq(`${r.key}.week`, `W${weekOf}`, r.week);
  }
  for (const [model, list] of Object.entries(group(roots, (r) => r.model))) {
    const exp = repo.costByRootModel[model];
    eq(`repo.costByRootModel.${model}.sessions`, list.length, exp?.sessions);
    eq(`repo.costByRootModel.${model}.costUsd`, RATES[model] ? sum(list, (r) => r.costUsd) : null, exp?.costUsd);
  }
  eq('repo.excludedSessionCount', roots.length - priced.length, repo.excludedSessionCount);
  eq('repo.excludedModels', [...new Set(roots.filter((r) => r.costUsd === null).map((r) => r.model))].sort(), [...repo.excludedModels].sort());
  const top = [...priced].sort((a, b) => b.costUsd - a.costUsd).slice(0, repo.topSessionsByCost.length);
  eq('repo.topSessionsByCost', top.map((r) => ({ key: r.key, costUsd: r.costUsd })), repo.topSessionsByCost);

  const treeTotal = roots.reduce((s, r) => addTokens(s, r.tree), emptyTokens());
  const ownTotal = roots.reduce((s, r) => addTokens(s, r.own), emptyTokens());
  for (const [label, t, e] of [['tree', treeTotal, repo.tokens.tree], ['root', ownTotal, repo.tokens.root]]) {
    for (const k of Object.keys(e)) {
      const actual = k === 'cacheWrite' ? t.cacheWrite5m + t.cacheWrite1h : t[k];
      eq(`repo.tokens.${label}.${k}`, actual, e[k]);
    }
  }
  eq('repo.cacheRatio.root', tokensCacheRatio(ownTotal), repo.cacheRatio.root);
  eq('repo.cacheRatio.withDescendants', tokensCacheRatio(treeTotal), repo.cacheRatio.withDescendants);
  const defined = roots.map((r) => tokensCacheRatio(r.own)).filter((x) => x !== null);
  eq('repo.cacheRatio.meanOfSessionRatiosTrap', sum(defined, (x) => x) / defined.length, repo.cacheRatio.meanOfSessionRatiosTrap);
  eq('repo.undefinedRatioSessions', roots.length - defined.length, repo.undefinedRatioSessions);
  const gs03 = roots.find((r) => r.cacheCreationCauses);
  const causes = repo.cacheCreationCausesRootThreshold25000;
  eq('repo.causes.compaction', gs03.cacheCreationCauses.threshold25000.compaction, causes.compaction);
  eq('repo.causes.fileReread', gs03.cacheCreationCauses.threshold25000.fileReread, causes.fileReread);
  eq('repo.causes sum', causes.compaction + causes.fileReread + causes.unattributed, ownTotal.cacheWrite5m + ownTotal.cacheWrite1h);

  eq('repo.workTimeMs', sum(roots, (r) => r.workTimeMs), repo.workTimeMs);
  eq('repo.avgSessionLengthMs', sum(roots, (r) => r.workTimeMs) / roots.length, repo.avgSessionLengthMs);
  // The work-time report: each root works on [start, start + workTime] (clamped to its end),
  // overlapping intervals merge, every day of the range is present.
  const minutes = mergedMinutesByDay(
    roots.map((r) => [Date.parse(r.start), Math.min(Date.parse(r.start) + r.workTimeMs, Date.parse(r.end))]),
  );
  const days = [];
  for (let d = Date.parse(repo.range.start); d <= Date.parse(repo.range.end); d += DAY_MS) days.push(new Date(d).toISOString().slice(0, 10));
  eq('repo.workTimeMinutesByDay days', Object.keys(repo.workTimeMinutesByDay), days);
  for (const day of days) eq(`repo.workTimeMinutesByDay.${day}`, minutes[day] ?? 0, repo.workTimeMinutesByDay[day]);

  eq('repo.lines.written', sum(roots, (r) => r.lines.written), repo.lines.written);
  eq('repo.lines.added', sum(roots, (r) => r.lines.added), repo.lines.added);
  eq('repo.lines.removed', sum(roots, (r) => r.lines.removed), repo.lines.removed);
  eq('repo.lines.editWriteCalls', sum(roots, (r) => r.lines.editWriteCalls), repo.lines.editWriteCalls);
  eq('repo.commits', sum(roots, (r) => r.commits), repo.commits);
  eq('repo.pullRequests', sum(roots, (r) => r.pullRequests), repo.pullRequests);
  const tools = {};
  for (const r of roots) {
    for (const [name, t] of Object.entries(r.tools ?? {})) {
      const acc = (tools[name] ??= { calls: 0, successes: 0, failures: 0, unresolved: 0 });
      for (const k of Object.keys(acc)) acc[k] += t[k];
    }
  }
  eq('repo.tools keys', Object.keys(tools).sort(), Object.keys(repo.tools).sort());
  for (const [name, t] of Object.entries(tools)) {
    for (const k of ['calls', 'successes', 'failures', 'unresolved']) eq(`repo.tools.${name}.${k}`, t[k], repo.tools[name]?.[k]);
    eq(`repo.tools.${name}.failureRate`, t.successes + t.failures === 0 ? 0 : t.failures / (t.successes + t.failures), repo.tools[name]?.failureRate);
  }
  eq('repo.toolCalls', sum(Object.values(tools), (t) => t.calls), repo.toolCalls);
  eq('repo.avgCostPerSessionUsd', sum(priced, (r) => r.costUsd) / roots.length, repo.avgCostPerSessionUsd);
  eq('repo.avgCostPerLineUsd', sum(priced, (r) => r.costUsd) / repo.lines.written, repo.avgCostPerLineUsd);
  eq('repo.avgLinesPerHour', (repo.lines.written * 3600000) / repo.workTimeMs, repo.avgLinesPerHour);

  return { checks, failures };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { checks, failures } = check();
  for (const f of failures) {
    console.error(`MISMATCH ${f.where}: computed ${JSON.stringify(f.actual)}, expected.json has ${JSON.stringify(f.expected)}`);
  }
  console.log(`golden arithmetic: ${checks} checks, ${failures.length} mismatches`);
  process.exit(failures.length === 0 ? 0 : 1);
}
