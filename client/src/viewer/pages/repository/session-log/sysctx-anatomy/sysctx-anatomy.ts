// Pure builder of the "System context anatomy" session tab: splits the first request's measured
// input (the startup context) into partitions estimated from the bytes the transcript logged.
// Rules and worked examples: docs/knowledgebase/algorithms/sysctx-anatomy.md (the table test
// `sysctx-anatomy.algo.test.ts` runs them). Never keeps any file, section or prompt text — only
// names, paths, sizes, statuses and role labels.

import type { ModelPricingMap } from '../../../../../models/pricing';
import type {
  HarnessSnapshot,
  HarnessSnapshotAgent,
  HarnessSnapshotFile,
  HarnessSnapshotSkill,
} from '../../../../api';
import {
  classifyInstructionRole,
  toUserDisplayPath,
} from '../instruction-files';
import { normaliseClientPath, resolveCharsPerToken } from '../log-parser';
import {
  ANATOMY_PARTITION_KINDS,
  FIRST_PROMPT_ROLE_LABELS,
  KIND_LABELS,
  MEMORY_DISPLAY_PATH,
  OUTSIDE_PATH_PREFIX,
  type AnatomyGit,
  type AnatomyKind,
  type AnatomyPartitionKind,
  type AnatomySource,
  type FirstPromptRole,
} from './sysctx-anatomy-constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One drill-down row of a partition. Optional fields are set only for the kinds that use them. */
export interface AnatomyRow {
  /** Stable key within the partition. */
  key: string;
  /** Name, path, "Block n" or role label — never content text. */
  label: string;
  kind: AnatomyKind;
  source: AnatomySource | null;
  /** UTF-8 bytes this row adds to the startup context (0 for on-demand rows). */
  bytes: number;
  tokens: number;
  share: number;
  /** File-backed rows: display path (never absolute), or `null` when no file is known. */
  path?: string | null;
  /** File-backed rows: size on disk from the harness snapshot, `null` when unknown. */
  fileBytes?: number | null;
  git?: AnatomyGit | null;
  /** Instruction files: `claude-md` | `local-md` | `user-md` | `rule`. */
  fileKind?: string;
  /** Instruction files: in the snapshot but not loaded at start (LOADED 0). */
  onDemand?: boolean;
  /** MCP servers. */
  status?: 'connected' | 'failed';
  errorCode?: string;
  tools?: number;
  namesBytes?: number;
  /** MCP servers: bytes of the `mcp-instructions` part (DD 7). */
  instrBytes?: number;
  /** MCP servers: tool names loaded later via `deferred_tools_record` (not part of the size). */
  onDemandNames?: string[];
  /** First user prompt rows. */
  role?: FirstPromptRole;
}

export interface AnatomyPartition {
  kind: AnatomyPartitionKind;
  label: string;
  /** `null` when the source is per row (skills, instruction files). */
  source: AnatomySource | null;
  /** `null` for harness internals (it is a token difference, not a measured size). */
  bytes: number | null;
  tokens: number;
  share: number;
  /** Sized from a JSON approximation instead of the rendered text (environment). */
  estimated: boolean;
  /** `deferred-tools`: the number of built-in names. */
  count?: number;
  rows: AnatomyRow[];
}

/** Conditions the tab shows as banners (DD 12). */
export interface AnatomyFlags {
  /** `main` has no lines at all. */
  empty: boolean;
  /** No harness snapshot (hook older than 2.22.0). */
  noSnapshot: boolean;
  /** A snapshot exists but no skill/agent/context entry carries `gitStatus` (hook < 2.28.0). */
  noGitStatus: boolean;
  /** No `prompt_snapshot` attachment in the startup block. */
  noPromptSnapshot: boolean;
  /** No non-sidechain assistant line with `message.usage`. */
  unknownTotal: boolean;
  /** Attributed tokens exceed the measured total. */
  overTotal: boolean;
}

export interface SysctxAnatomy {
  /** Exact startup context in tokens (DD 4), `null` when unknown. */
  total: number | null;
  /** Σ partition tokens (harness internals excluded). */
  attributed: number;
  /** total − attributed when that is ≥ 0, else `null`. */
  internals: number | null;
  /** attributed − total when attributed > total, else `null`. */
  overBy: number | null;
  /** Share denominator: total when known and ≥ attributed, else attributed. */
  denominator: number;
  /** Bytes per token used for every estimate. */
  cpt: number;
  /** Model of the first main assistant line, if any. */
  model: string | null;
  flags: AnatomyFlags;
  /** In partition-table order (DD 6); harness internals only when `internals !== null`. */
  partitions: AnatomyPartition[];
}

export interface BuildSysctxAnatomyInput {
  /** The raw main transcript lines (`logsQuery.data.main`). */
  main: Record<string, unknown>[];
  snapshot?: HarnessSnapshot | null;
  /** Absolute repository root, for display paths. Empty when unknown. */
  repoRoot?: string;
  /** Bytes per token. When absent: `resolveCharsPerToken(pricing, firstModel ?? fallbackModel)`. */
  charsPerToken?: number;
  pricing?: ModelPricingMap;
  /** Model used for the ratio when no assistant line names one (e.g. `summary.model`). */
  fallbackModel?: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function utf8(text: string): number {
  return encoder.encode(text).length;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : [];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/** Stable sort by bytes descending (ties keep first-seen order). */
function byBytesDesc<T extends { bytes: number }>(rows: T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.bytes - a.r.bytes || a.i - b.i)
    .map((x) => x.r);
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * MCP join key (DD 8): every character outside `[A-Za-z0-9_-]` becomes `_`, so a display name
 * ("claude.ai Claude Docs") and a tool-name slug (`claude_ai_Claude_Docs`) meet.
 */
export function mcpKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Per-skill byte sizes of a `skill_listing` content (DD 9). Each name's slice starts at
 * `"- " + name + ": "` and runs to the next found start, or to the end of the content. Names not
 * found get 0. Sizes are UTF-8 bytes.
 */
export function splitSkillListing(
  content: string,
  names: string[],
): Map<string, number> {
  const sizes = new Map<string, number>();
  const starts: { name: string; at: number }[] = [];
  for (const name of names) {
    if (sizes.has(name)) continue;
    sizes.set(name, 0);
    const at = content.indexOf(`- ${name}: `);
    if (at >= 0) starts.push({ name, at });
  }
  starts.sort((a, b) => a.at - b.at);
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].at : content.length;
    sizes.set(s.name, utf8(content.slice(s.at, end)));
  });
  return sizes;
}

interface StartupAnchor {
  /** Index of the first non-sidechain assistant line with `message.usage`, or -1. */
  index: number;
  total: number | null;
  model: string | null;
}

function findStartupAnchor(main: Record<string, unknown>[]): StartupAnchor {
  for (let i = 0; i < main.length; i++) {
    const line = main[i];
    if (line.type !== 'assistant' || line.isSidechain === true) continue;
    const msg = line.message;
    if (!isObj(msg) || !isObj(msg.usage)) continue;
    const u = msg.usage;
    return {
      index: i,
      total:
        num(u.input_tokens) +
        num(u.cache_creation_input_tokens) +
        num(u.cache_read_input_tokens),
      model: str(msg.model),
    };
  }
  return { index: -1, total: null, model: null };
}

/**
 * The exact startup context in tokens (DD 4): input + cache write + cache read of the first
 * non-sidechain assistant line that has `message.usage`; `null` when there is none.
 */
export function computeStartupTotal(
  main: Record<string, unknown>[],
): number | null {
  return findStartupAnchor(main).total;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Attachment types measured by their own partition (DD 6), so not part of Environment. */
const OWN_PARTITION_TYPES = new Set([
  'prompt_snapshot',
  'deferred_tools_delta',
  'mcp_instructions_delta',
  'agent_listing_delta',
  'skill_listing',
  'instructions',
  'session_context',
]);
/** Attachment types never counted at start. */
const IGNORED_TYPES = new Set(['deferred_tools_record', 'nested_memory']);

const PLUGIN_PATH_RE = /^[^/]+@[^/]+\//;
const MCP_NAME_RE = /^mcp__(.+?)__/;

/** GIT fallback when the snapshot carries no status (DD 10). */
function gitFallback(displayPath: string): AnatomyGit {
  if (
    displayPath.startsWith('~/') ||
    displayPath.startsWith(OUTSIDE_PATH_PREFIX) ||
    PLUGIN_PATH_RE.test(displayPath)
  ) {
    return 'outside-repo';
  }
  return 'unknown';
}

/** Repo-relative display path of a non-User instruction file (DD 10). */
function displayPathOf(rawPath: string, repoRoot: string): string {
  const fwd = rawPath.replace(/\\/g, '/');
  const isAbsolute = fwd.startsWith('/') || /^[A-Za-z]:\//.test(fwd);
  if (!isAbsolute) return fwd;
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root) {
    const inside = fwd.toLowerCase().startsWith(root.toLowerCase() + '/');
    return inside
      ? normaliseClientPath(fwd, root)
      : OUTSIDE_PATH_PREFIX + basename(fwd);
  }
  const rel = normaliseClientPath(fwd, '');
  return rel === fwd.replace(/^\//, '')
    ? OUTSIDE_PATH_PREFIX + basename(fwd)
    : rel;
}

function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (isObj(block) && typeof block.text === 'string') return block.text;
  return JSON.stringify(block ?? '');
}

function isMemoryBlock(text: string): boolean {
  const first = text.split('\n').find((l) => l.trim() !== '');
  return first !== undefined && first.trim() === '# Memory';
}

function isMemoryFile(rawPath: string): boolean {
  return /\/MEMORY\.md$/.test(rawPath.replace(/\\/g, '/'));
}

interface UserLineSize {
  bytes: number;
  role: FirstPromptRole;
}

function sizeUserLine(line: Obj): UserLineSize {
  const msg = isObj(line.message) ? line.message : {};
  const content = msg.content;
  let bytes = 0;
  let text = '';
  if (typeof content === 'string') {
    bytes = utf8(content);
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!isObj(part) || part.type !== 'text' || typeof part.text !== 'string')
        continue;
      text += part.text;
      if (part.text.startsWith('<system-reminder>')) continue;
      bytes += utf8(part.text);
    }
  }
  const isMeta = line.isMeta === true;
  let role: FirstPromptRole;
  if (isMeta && text.trimStart().startsWith('<local-command-caveat>'))
    role = 'command-caveat';
  else if (text.includes('<command-name>')) role = 'slash-command';
  else if (isMeta && Array.isArray(content)) role = 'injected-body';
  else role = 'typed-prompt';
  return { bytes, role };
}

interface McpAcc {
  key: string;
  instrName: string | null;
  tools: number;
  namesBytes: number;
  instrBytes: number;
  failedCode: string | null;
  onDemand: string[];
}

interface FileAcc {
  key: string;
  path: string;
  source: AnatomySource;
  fileKind: string;
  bytes: number;
  fileBytes: number | null;
  git: AnatomyGit | null;
  onDemand: boolean;
}

/** Draft row before tokens/share are filled in. */
type DraftRow = Omit<AnatomyRow, 'tokens' | 'share'>;

interface DraftPartition {
  kind: AnatomyPartitionKind;
  source: AnatomySource | null;
  bytes: number;
  estimated?: boolean;
  count?: number;
  rows: DraftRow[];
}

/** Builds the anatomy of a session's startup context (DD 3–12). */
export function buildSysctxAnatomy(
  input: BuildSysctxAnatomyInput,
): SysctxAnatomy {
  const main = input.main;
  const snapshot = input.snapshot ?? null;
  const repoRoot = input.repoRoot ?? '';

  // --- startup block (DD 3) and total (DD 4) ---
  const anchor = findStartupAnchor(main);
  let end = anchor.index;
  if (end < 0) {
    end = main.findIndex((l) => l.type === 'assistant');
    if (end < 0) end = main.length;
  }
  const block = main.slice(0, end).filter((l) => l.isSidechain !== true);
  const attachments: Obj[] = [];
  const userLines: Obj[] = [];
  for (const line of block) {
    if (line.type === 'attachment' && isObj(line.attachment)) {
      if (typeof line.attachment.type === 'string')
        attachments.push(line.attachment);
    } else if (line.type === 'user') {
      userLines.push(line);
    }
  }
  const ofType = (t: string): Obj[] => attachments.filter((a) => a.type === t);

  const cpt =
    input.charsPerToken && input.charsPerToken > 0
      ? input.charsPerToken
      : resolveCharsPerToken(
          input.pricing,
          anchor.model ?? input.fallbackModel ?? null,
        );

  // --- system prompt + memory block (DD 6) ---
  const promptSnapshot = ofType('prompt_snapshot')[0];
  const systemRows: DraftRow[] = [];
  let memoryBytes = 0;
  if (promptSnapshot && Array.isArray(promptSnapshot.systemPrompt)) {
    promptSnapshot.systemPrompt.forEach((b: unknown, i: number) => {
      const text = blockText(b);
      const bytes = utf8(text);
      if (isMemoryBlock(text)) {
        memoryBytes += bytes;
        return;
      }
      systemRows.push({
        key: `block-${i + 1}`,
        label: `Block ${i + 1}`,
        kind: 'system-prompt',
        source: 'harness',
        bytes,
      });
    });
  }

  // --- instruction files + MEMORY.md files (DD 10) ---
  const files = new Map<string, FileAcc>();
  for (const att of ofType('instructions')) {
    if (!Array.isArray(att.files)) continue;
    for (const f of att.files) {
      if (!isObj(f)) continue;
      const raw = str(f.path);
      if (!raw) continue;
      const bytes = utf8(str(f.content) ?? '');
      if (isMemoryFile(raw)) {
        memoryBytes += bytes;
        continue;
      }
      const type = str(f.type)?.toLowerCase();
      const display =
        type === 'user' ? toUserDisplayPath(raw) : displayPathOf(raw, repoRoot);
      const key = pathKey(display);
      const prev = files.get(key);
      if (prev) {
        prev.bytes += bytes;
        continue;
      }
      files.set(key, {
        key,
        path: display,
        source:
          type === 'user' || display.startsWith(OUTSIDE_PATH_PREFIX)
            ? 'user'
            : 'project',
        fileKind: classifyInstructionRole(raw, type),
        bytes,
        fileBytes: null,
        git: null,
        onDemand: false,
      });
    }
  }
  const snapFiles: HarnessSnapshotFile[] = snapshot?.systemContext?.files ?? [];
  for (const sf of snapFiles) {
    const display = displayPathOf(sf.path, repoRoot);
    const key = pathKey(display);
    const hit = files.get(key);
    if (hit) {
      hit.fileBytes = sf.bytes;
      if (sf.gitStatus) hit.git = sf.gitStatus;
      continue;
    }
    files.set(key, {
      key,
      path: display,
      source: display.startsWith(OUTSIDE_PATH_PREFIX) ? 'user' : 'project',
      fileKind: classifyInstructionRole(sf.path),
      bytes: 0,
      fileBytes: sf.bytes,
      git: sf.gitStatus ?? null,
      onDemand: true,
    });
  }
  const fileAccs = [...files.values()];
  const fileRows: DraftRow[] = [
    ...fileAccs.filter((f) => !f.onDemand),
    ...fileAccs.filter((f) => f.onDemand),
  ].map((f) => ({
    key: f.key,
    label: f.path,
    kind: 'instruction-file',
    source: f.source,
    bytes: f.bytes,
    path: f.path,
    fileBytes: f.fileBytes,
    git: f.git ?? gitFallback(f.path),
    fileKind: f.fileKind,
    onDemand: f.onDemand,
  }));

  // --- environment (estimated) ---
  const envBytes = new Map<string, number>();
  for (const att of attachments) {
    const t = att.type as string;
    if (OWN_PARTITION_TYPES.has(t) || IGNORED_TYPES.has(t)) continue;
    envBytes.set(t, (envBytes.get(t) ?? 0) + utf8(JSON.stringify(att)));
  }
  const envRows: DraftRow[] = [...envBytes].map(([t, bytes]) => ({
    key: t,
    label: t,
    kind: 'environment',
    source: 'harness',
    bytes,
  }));

  // --- deferred tool names + MCP servers (DD 8) ---
  const servers = new Map<string, McpAcc>();
  const server = (key: string): McpAcc => {
    let acc = servers.get(key);
    if (!acc) {
      acc = {
        key,
        instrName: null,
        tools: 0,
        namesBytes: 0,
        instrBytes: 0,
        failedCode: null,
        onDemand: [],
      };
      servers.set(key, acc);
    }
    return acc;
  };
  let builtinNames = 0;
  let builtinBytes = 0;
  for (const att of ofType('deferred_tools_delta')) {
    const names = strArray(att.addedNames);
    const lines = strArray(att.addedLines);
    names.forEach((name, i) => {
      const bytes = utf8(lines[i] ?? name) + 1;
      const m = MCP_NAME_RE.exec(name);
      if (m) {
        const acc = server(mcpKey(m[1]));
        acc.tools += 1;
        acc.namesBytes += bytes;
      } else {
        builtinNames += 1;
        builtinBytes += bytes;
      }
    });
  }
  for (const att of ofType('mcp_instructions_delta')) {
    const names = strArray(att.addedNames);
    const blocks = strArray(att.addedBlocks);
    names.forEach((name, i) => {
      const acc = server(mcpKey(name));
      acc.instrName ??= name;
      acc.instrBytes += utf8(blocks[i] ?? '');
    });
  }
  for (const att of attachments) {
    if (!Array.isArray(att.failedMcpServers)) continue;
    for (const f of att.failedMcpServers) {
      if (!isObj(f) || typeof f.name !== 'string') continue;
      server(mcpKey(f.name)).failedCode = str(f.errorCode) ?? 'unknown';
    }
  }
  for (const line of main) {
    const att = line.attachment;
    if (!isObj(att) || att.type !== 'deferred_tools_record') continue;
    if (!Array.isArray(att.entries)) continue;
    for (const e of att.entries) {
      const name = isObj(e) ? str(e.name) : null;
      const m = name ? MCP_NAME_RE.exec(name) : null;
      if (!name || !m) continue;
      const acc = servers.get(mcpKey(m[1]));
      if (acc && !acc.onDemand.includes(name)) acc.onDemand.push(name);
    }
  }
  const snapServerNames = new Map<string, string>();
  for (const s of snapshot?.mcpServers ?? []) {
    if (typeof s.name === 'string') snapServerNames.set(mcpKey(s.name), s.name);
  }
  const mcpRows: DraftRow[] = byBytesDesc(
    [...servers.values()].map((acc) => ({
      key: acc.key,
      label: acc.instrName ?? snapServerNames.get(acc.key) ?? acc.key,
      kind: 'mcp-server' as const,
      source: 'mcp-server' as const,
      bytes: acc.namesBytes + acc.instrBytes,
      status:
        acc.failedCode !== null ? ('failed' as const) : ('connected' as const),
      ...(acc.failedCode !== null && { errorCode: acc.failedCode }),
      tools: acc.tools,
      namesBytes: acc.namesBytes,
      instrBytes: acc.instrBytes,
      onDemandNames: acc.onDemand,
    })),
  );

  // --- subagent types ---
  const snapAgents = new Map<string, HarnessSnapshotAgent>();
  for (const a of snapshot?.agents ?? []) snapAgents.set(a.name, a);
  const agentRows: DraftRow[] = [];
  for (const att of ofType('agent_listing_delta')) {
    const types = strArray(att.addedTypes);
    const lines = strArray(att.addedLines);
    types.forEach((t, i) => {
      const a = snapAgents.get(t);
      agentRows.push({
        key: `${t}#${agentRows.length}`,
        label: t,
        kind: 'agent-types',
        source: a ? 'project' : 'built-in',
        bytes: utf8(lines[i] ?? '') + 1,
        path: a ? a.path : null,
        fileBytes: a ? a.bytes : null,
        git: a ? (a.gitStatus ?? gitFallback(a.path)) : null,
      });
    });
  }

  // --- skills listing (DD 9) ---
  const listings = ofType('skill_listing');
  const listing = listings.find((l) => l.isInitial === true) ?? listings[0];
  const skillRows: DraftRow[] = [];
  let skillsBytes = 0;
  if (listing) {
    const content = str(listing.content) ?? '';
    skillsBytes = utf8(content);
    const sizes = splitSkillListing(content, strArray(listing.names));
    const snapSkills: HarnessSnapshotSkill[] = snapshot?.skills ?? [];
    for (const [name, bytes] of sizes) {
      const entry = resolveSkillEntry(name, snapSkills);
      const source: AnatomySource | null = !snapshot
        ? null
        : entry
          ? entry.source
          : 'built-in';
      skillRows.push({
        key: name,
        label: name,
        kind: 'skills',
        source,
        bytes,
        path: entry ? entry.path : null,
        fileBytes: entry ? entry.bytes : null,
        git: entry ? (entry.gitStatus ?? gitFallback(entry.path)) : null,
      });
    }
  }

  // --- system reminders ---
  const reminderBytes = new Map<string, number>();
  for (const att of ofType('session_context')) {
    if (!isObj(att.context)) continue;
    for (const [k, v] of Object.entries(att.context)) {
      const bytes = utf8(typeof v === 'string' ? v : JSON.stringify(v ?? ''));
      reminderBytes.set(k, (reminderBytes.get(k) ?? 0) + bytes);
    }
  }
  const reminderRows: DraftRow[] = [...reminderBytes].map(([k, bytes]) => ({
    key: k,
    label: k,
    kind: 'system-reminder',
    source: 'system-reminder',
    bytes,
  }));

  // --- first user prompt (DD 11) ---
  const promptRows: DraftRow[] = userLines.map((line, i) => {
    const { bytes, role } = sizeUserLine(line);
    return {
      key: `user-${i + 1}`,
      label: FIRST_PROMPT_ROLE_LABELS[role],
      kind: 'first-prompt',
      source: 'user',
      bytes,
      role,
    };
  });

  const memoryRows: DraftRow[] =
    memoryBytes > 0
      ? [
          {
            key: 'memory',
            label: MEMORY_DISPLAY_PATH,
            kind: 'memory',
            source: 'user',
            bytes: memoryBytes,
            path: MEMORY_DISPLAY_PATH,
            fileBytes: null,
            git: 'outside-repo',
          },
        ]
      : [];

  const sum = (rows: DraftRow[]): number =>
    rows.reduce((s, r) => s + r.bytes, 0);

  const drafts: DraftPartition[] = [
    {
      kind: 'system-prompt',
      source: 'harness',
      bytes: sum(systemRows),
      rows: systemRows,
    },
    { kind: 'memory', source: 'user', bytes: memoryBytes, rows: memoryRows },
    {
      kind: 'environment',
      source: 'harness',
      bytes: sum(envRows),
      estimated: true,
      rows: envRows,
    },
    {
      kind: 'deferred-tools',
      source: 'built-in',
      bytes: builtinBytes,
      count: builtinNames,
      rows: [],
    },
    {
      kind: 'mcp-server',
      source: 'mcp-server',
      bytes: sum(mcpRows),
      rows: mcpRows,
    },
    {
      kind: 'agent-types',
      source: 'harness',
      bytes: sum(agentRows),
      rows: agentRows,
    },
    {
      kind: 'skills',
      source: null,
      bytes: skillsBytes,
      rows: byBytesDesc(skillRows),
    },
    {
      kind: 'instruction-file',
      source: null,
      bytes: sum(fileRows),
      rows: fileRows,
    },
    {
      kind: 'system-reminder',
      source: 'system-reminder',
      bytes: sum(reminderRows),
      rows: reminderRows,
    },
    {
      kind: 'first-prompt',
      source: 'user',
      bytes: sum(promptRows),
      rows: promptRows,
    },
  ];

  // --- tokens, internals, shares (DD 5) ---
  const tok = (bytes: number): number => Math.round(bytes / cpt);
  const attributed = drafts.reduce((s, d) => s + tok(d.bytes), 0);
  const total = anchor.total;
  const internals =
    total !== null && total - attributed >= 0 ? total - attributed : null;
  const overBy =
    total !== null && attributed > total ? attributed - total : null;
  const denominator =
    total !== null && total >= attributed ? total : attributed;
  const share = (tokens: number): number =>
    denominator > 0 ? tokens / denominator : 0;

  const partitions: AnatomyPartition[] = drafts.map((d) => {
    const tokens = tok(d.bytes);
    return {
      kind: d.kind,
      label: KIND_LABELS[d.kind],
      source: d.source,
      bytes: d.bytes,
      tokens,
      share: share(tokens),
      estimated: d.estimated === true,
      ...(d.count !== undefined && { count: d.count }),
      rows: d.rows.map((r) => {
        const t = tok(r.bytes);
        return { ...r, tokens: t, share: share(t) };
      }),
    };
  });
  if (internals !== null) {
    partitions.push({
      kind: 'harness-internals',
      label: KIND_LABELS['harness-internals'],
      source: 'harness',
      bytes: null,
      tokens: internals,
      share: share(internals),
      estimated: false,
      rows: [],
    });
  }
  // Keep table order explicit even if the drafts list above is reordered.
  partitions.sort(
    (a, b) =>
      ANATOMY_PARTITION_KINDS.indexOf(a.kind) -
      ANATOMY_PARTITION_KINDS.indexOf(b.kind),
  );

  const anyGit =
    !!snapshot &&
    [
      ...(snapshot.skills ?? []),
      ...(snapshot.agents ?? []),
      ...(snapshot.systemContext?.files ?? []),
    ].some((e) => typeof e.gitStatus === 'string' && e.gitStatus.length > 0);

  return {
    total,
    attributed,
    internals,
    overBy,
    denominator,
    cpt,
    model: anchor.model,
    flags: {
      empty: main.length === 0,
      noSnapshot: !snapshot,
      noGitStatus: !!snapshot && !anyGit,
      noPromptSnapshot: !promptSnapshot,
      unknownTotal: total === null,
      overTotal: overBy !== null,
    },
    partitions,
  };
}

/** Snapshot entry of a listed skill (DD 9): exact name, else org-synced bare name of `p:x`. */
function resolveSkillEntry(
  name: string,
  skills: HarnessSnapshotSkill[],
): HarnessSnapshotSkill | null {
  const exact = skills.find((s) => s.name === name);
  if (exact) return exact;
  const colon = name.indexOf(':');
  if (colon > 0) {
    const bare = name.slice(colon + 1);
    const synced = skills.find(
      (s) => s.source === 'org-synced' && s.name === bare,
    );
    if (synced) return synced;
  }
  return null;
}
