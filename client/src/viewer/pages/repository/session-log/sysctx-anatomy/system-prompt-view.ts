// Pure builder of the "View system prompt" modal on the System context anatomy tab: turns the
// session's `prompt_snapshot` attachments into a readable, path-masked view model, plus its
// Markdown export. Rules and worked examples: docs/knowledgebase/algorithms/system-prompt-view.md
// (the table test `system-prompt-view.algo.test.ts` runs them).
//
// Observed shape (Claude Code 2.1.280+, internal and undocumented — see
// docs/knowledgebase/log-schema/attachment-types.md § "Attachment type: prompt_snapshot" →
// "Shape details"):
// - a session has at least two snapshots: the startup one, in the startup block before the first
//   assistant reply, has no `tools`; a later one, written after the first reply, carries `tools`;
// - `systemPrompt` is an array of plain strings, one of which is the literal boundary marker
//   `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` — parts before it are shared across sessions, parts after
//   it are per-session (`# Environment`, …);
// - `tools[]` items have `name`, `description`, `schema` (the whole wire tool object
//   `{name, description, input_schema, …}`) and, on MCP tools only, `server`; the tools are read
//   through `findToolDefinitions`, shared with the anatomy's Tool definitions partition;
// - every other key of a snapshot is a flag (`cliPrefix`, `contextRendering`, booleans).
// Texts carry absolute local paths, so every display string is masked (`maskLocalPaths`) while
// every size is taken from the raw text, to match the anatomy rows.

import {
  OUTSIDE_PATH_PREFIX,
  PROJECT_SLUG_PLACEHOLDER,
} from './sysctx-anatomy-constants';
import {
  blockText,
  DYNAMIC_BOUNDARY_MARKER,
  isObj,
  startupBlockLines,
  utf8,
} from './sysctx-anatomy';
import {
  findToolDefinitions,
  type ToolDefinition,
  type ToolSource,
} from './tool-definitions';

export { DYNAMIC_BOUNDARY_MARKER };

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type PromptGroup = 'shared' | 'session';

export interface PromptPartItem {
  /** 1-based position in the raw `systemPrompt` array (= the anatomy "Block n" number). */
  index: number;
  /** Masked. */
  title: string;
  /** Masked. */
  text: string;
  /** UTF-8 bytes of the raw (unmasked) text. */
  bytes: number;
  tokens: number;
  /** `null` when the snapshot has no boundary marker. */
  group: PromptGroup | null;
}

export interface ToolItem {
  /** 1-based position in the source's `tools`. */
  index: number;
  /** Masked; `(unnamed tool #n)` when the tool has no name. */
  name: string;
  /**
   * MCP server name of the tool (the optional `tools[].server` string; absent on built-in
   * tools), masked. `null` when absent or not a string. Shown as a badge, never counted in
   * `bytes`.
   */
  server: string | null;
  /** Masked; `null` when absent. */
  description: string | null;
  /** Masked input schema as pretty JSON; `null` when absent. */
  schemaJson: string | null;
  /** Raw UTF-8 bytes of the definition (`tool-definitions.ts`). */
  bytes: number;
  tokens: number;
  /** Share of the tools' bytes, 0–100, unrounded. */
  share: number;
}

export interface FlagItem {
  key: string;
  /** Masked display value: string as-is, scalars via `String`, objects as pretty JSON. */
  value: string;
  isObject: boolean;
}

export interface SystemPromptView {
  prompt: {
    status: 'ok' | 'unrecognised' | 'missing';
    parts: PromptPartItem[];
    grouped: boolean;
    bytes: number;
    tokens: number;
  };
  tools: {
    status: 'ok' | 'none';
    /** Where the tools were read from (the anatomy's Tool definitions source); `null` when none. */
    source: ToolSource | null;
    items: ToolItem[];
    bytes: number;
    tokens: number;
  };
  flags: FlagItem[];
  totals: { parts: number; tools: number; bytes: number; tokens: number };
  error: string | null;
}

export interface BuildSystemPromptViewInput {
  /** The raw main transcript lines. */
  main: Record<string, unknown>[];
  /** Absolute repository root, for path masking. Empty when unknown. */
  repoRoot: string;
  /** Bytes per token (the anatomy's `cpt`). */
  cpt: number;
}

// UI strings shared with the modal (DD 12).
export const SYSTEM_PROMPT_VIEW_ERROR =
  'Could not read the system prompt snapshot';
export const MSG_NO_TOOLS = 'No tool definitions in this session';
export const MSG_UNRECOGNISED = 'System prompt not in a recognised format';
export const MSG_NO_PARTS = 'No system prompt parts';
export const MSG_NO_FLAGS = 'No flags';
export const MSG_NO_DESCRIPTION = 'no description';

// ---------------------------------------------------------------------------
// Snapshot selection (DD 1)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function snapshotOf(line: Obj): Obj | null {
  if (line.isSidechain === true || line.type !== 'attachment') return null;
  const att = line.attachment;
  return isObj(att) && att.type === 'prompt_snapshot' ? att : null;
}

/** True when `main` has any non-sidechain `prompt_snapshot` attachment line. */
export function hasPromptSnapshot(main: Record<string, unknown>[]): boolean {
  return main.some((l) => snapshotOf(l) !== null);
}

function firstSnapshot(
  lines: Record<string, unknown>[],
  pred: (s: Obj) => boolean = () => true,
): Obj | null {
  for (const line of lines) {
    const s = snapshotOf(line);
    if (s && pred(s)) return s;
  }
  return null;
}

/** First snapshot in the startup block, else the first one anywhere. */
function startupSnapshot(main: Record<string, unknown>[]): Obj | null {
  return firstSnapshot(startupBlockLines(main)) ?? firstSnapshot(main);
}

// ---------------------------------------------------------------------------
// Path masking (DD 6)
// ---------------------------------------------------------------------------

/** Characters that end a path inside free text. */
const PATH_REST = `[^\\s'"\`)\\]}>]*`;
const PATH_END = `[\\s'"\`)\\]}>]`;
/** No path starts right after a word char, `.`, `~` or a separator (keeps URLs and relatives). */
const NOT_AFTER = '(?<![\\w.~\\/\\\\])';
const OTHER_ABS_PATH_RE = new RegExp(
  `${NOT_AFTER}(?:[A-Za-z]:[\\\\/]|\\/(?:Users|home|tmp|var|opt|mnt)\\/)${PATH_REST}`,
  'g',
);
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitTrailingPunct(s: string): [string, string] {
  const trail = TRAILING_PUNCT_RE.exec(s)?.[0] ?? '';
  return [s.slice(0, s.length - trail.length), trail];
}

function rootRegExp(repoRoot: string): RegExp | null {
  const root = repoRoot.replace(/[\\/]+$/, '');
  if (!root) return null;
  const body = root
    .split(/[\\/]+/)
    .map(escapeRegExp)
    .join('[\\\\/]+');
  return new RegExp(
    `${NOT_AFTER}${body}(?=[\\\\/]|[.,;:!?]*(?:${PATH_END}|$))(${PATH_REST})`,
    'gi',
  );
}

function maskOtherPath(match: string): string {
  const [raw, trail] = splitTrailingPunct(match);
  const fwd = raw.replace(/\\/g, '/');
  const claude = fwd.indexOf('/.claude/');
  if (claude >= 0) {
    const rest = fwd
      .slice(claude + '/.claude/'.length)
      .replace(/^projects\/[^/]+/, `projects/${PROJECT_SLUG_PLACEHOLDER}`);
    return `~/.claude/${rest}${trail}`;
  }
  const trimmed = fwd.replace(/\/+$/, '');
  const segs = trimmed.split('/');
  const base = /^[A-Za-z]:$/.test(trimmed) ? '' : segs[segs.length - 1];
  const masked = base
    ? OUTSIDE_PATH_PREFIX + base
    : OUTSIDE_PATH_PREFIX.replace(/\/$/, '');
  return masked + trail;
}

/**
 * Masks absolute local paths inside free text (DD 6). Paths under `repoRoot` become
 * repo-relative (`.` for the root itself); paths under a `.claude` folder become `~/.claude/…`
 * with the project slug hidden; any other absolute path becomes `<outside>/<basename>`.
 */
export function maskLocalPaths(text: string, repoRoot: string): string {
  let out = text;
  const rootRe = rootRegExp(repoRoot);
  if (rootRe) {
    out = out.replace(rootRe, (_m, rest: string) => {
      const [raw, trail] = splitTrailingPunct(rest);
      const rel = raw
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/')
        .replace(/^\//, '');
      return (rel || '.') + trail;
    });
  }
  return out.replace(OTHER_ABS_PATH_RE, maskOtherPath);
}

/** Masks every string value inside a JSON value; keys are untouched. */
function deepMask(v: unknown, repoRoot: string): unknown {
  if (typeof v === 'string') return maskLocalPaths(v, repoRoot);
  if (Array.isArray(v)) return v.map((x) => deepMask(x, repoRoot));
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepMask(x, repoRoot);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Titles (DD 5)
// ---------------------------------------------------------------------------

const TITLE_MAX = 80;
const TITLE_WORDS = 8;
const HEADING_RE = /^#{1,6}\s+\S/;

/** Title of a (masked) prompt part: its first heading, else its first 8 words. */
export function partTitle(text: string): string {
  if (text.trim() === '') return '(empty part)';
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let title: string | null = null;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && HEADING_RE.test(line)) {
      title = line.trim();
      break;
    }
  }
  if (title === null) {
    const first = lines.find((l) => l.trim() !== '') ?? '';
    const words = first.trim().split(/\s+/);
    title =
      words.slice(0, TITLE_WORDS).join(' ') +
      (words.length > TITLE_WORDS ? '…' : '');
  }
  return title.length > TITLE_MAX ? title.slice(0, TITLE_MAX - 1) + '…' : title;
}

// ---------------------------------------------------------------------------
// Builder (DD 3, 4, 7, 8)
// ---------------------------------------------------------------------------

const NON_FLAG_KEYS = new Set(['systemPrompt', 'tools', 'rendered', 'type']);

function emptyView(error: string | null): SystemPromptView {
  return {
    prompt: {
      status: 'missing',
      parts: [],
      grouped: false,
      bytes: 0,
      tokens: 0,
    },
    tools: { status: 'none', source: null, items: [], bytes: 0, tokens: 0 },
    flags: [],
    totals: { parts: 0, tools: 0, bytes: 0, tokens: 0 },
    error,
  };
}

function buildParts(
  systemPrompt: unknown[],
  repoRoot: string,
  tok: (bytes: number) => number,
): { parts: PromptPartItem[]; grouped: boolean } {
  const texts = systemPrompt.map(blockText);
  const grouped = texts.some((t) => t.trim() === DYNAMIC_BOUNDARY_MARKER);
  const parts: PromptPartItem[] = [];
  let afterMarker = false;
  texts.forEach((raw, i) => {
    if (raw.trim() === DYNAMIC_BOUNDARY_MARKER) {
      afterMarker = true;
      return;
    }
    if (raw.trim() === '') return;
    const text = maskLocalPaths(raw, repoRoot);
    const bytes = utf8(raw);
    parts.push({
      index: i + 1,
      title: partTitle(text),
      text,
      bytes,
      tokens: tok(bytes),
      group: grouped ? (afterMarker ? 'session' : 'shared') : null,
    });
  });
  return { parts, grouped };
}

function buildTools(
  defs: ToolDefinition[],
  total: number,
  repoRoot: string,
  tok: (bytes: number) => number,
): ToolItem[] {
  return defs.map((d) => ({
    index: d.index,
    name:
      d.name !== null
        ? maskLocalPaths(d.name, repoRoot)
        : `(unnamed tool #${d.index})`,
    server: d.server !== null ? maskLocalPaths(d.server, repoRoot) : null,
    description:
      d.description !== null ? maskLocalPaths(d.description, repoRoot) : null,
    schemaJson:
      d.inputSchema !== null && d.inputSchema !== undefined
        ? JSON.stringify(deepMask(d.inputSchema, repoRoot), null, 2)
        : null,
    bytes: d.bytes,
    tokens: tok(d.bytes),
    share: total > 0 ? (d.bytes / total) * 100 : 0,
  }));
}

function buildFlags(snapshot: Obj, repoRoot: string): FlagItem[] {
  const flags: FlagItem[] = [];
  for (const [key, v] of Object.entries(snapshot)) {
    if (NON_FLAG_KEYS.has(key)) continue;
    if (typeof v === 'string') {
      flags.push({ key, value: maskLocalPaths(v, repoRoot), isObject: false });
    } else if (typeof v === 'object' && v !== null) {
      flags.push({
        key,
        value: JSON.stringify(deepMask(v, repoRoot), null, 2),
        isObject: true,
      });
    } else {
      flags.push({ key, value: String(v), isObject: false });
    }
  }
  return flags;
}

function build(input: BuildSystemPromptViewInput): SystemPromptView {
  const { main, repoRoot, cpt } = input;
  const tok = (bytes: number): number =>
    cpt > 0 && Number.isFinite(cpt) ? Math.round(bytes / cpt) : 0;
  const startup = startupSnapshot(main);
  const view = emptyView(null);

  if (startup) {
    if (Array.isArray(startup.systemPrompt)) {
      const { parts, grouped } = buildParts(
        startup.systemPrompt,
        repoRoot,
        tok,
      );
      const bytes = parts.reduce((s, p) => s + p.bytes, 0);
      view.prompt = { status: 'ok', parts, grouped, bytes, tokens: tok(bytes) };
    } else {
      view.prompt.status = 'unrecognised';
    }
    view.flags = buildFlags(startup, repoRoot);
  }

  const defs = findToolDefinitions(startupBlockLines(main), main);
  if (defs && defs.tools.length > 0) {
    const items = buildTools(defs.tools, defs.bytes, repoRoot, tok);
    view.tools = {
      status: 'ok',
      source: defs.source,
      items,
      bytes: defs.bytes,
      tokens: tok(defs.bytes),
    };
  }

  const totalBytes = view.prompt.bytes + view.tools.bytes;
  view.totals = {
    parts: view.prompt.parts.length,
    tools: view.tools.items.length,
    bytes: totalBytes,
    tokens: tok(totalBytes),
  };
  return view;
}

/** Builds the modal's view model. Never throws: a failure gives an empty view with `error`. */
export function buildSystemPromptView(
  input: BuildSystemPromptViewInput,
): SystemPromptView {
  try {
    return build(input);
  } catch {
    return emptyView(SYSTEM_PROMPT_VIEW_ERROR);
  }
}

// ---------------------------------------------------------------------------
// Markdown export (DD 10)
// ---------------------------------------------------------------------------

function fenced(lang: string, content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g))
    longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

function promptBlocks(view: SystemPromptView): string[] {
  const { prompt } = view;
  if (prompt.status === 'unrecognised') return [MSG_UNRECOGNISED];
  if (prompt.parts.length === 0) return [MSG_NO_PARTS];
  const part = (p: PromptPartItem): string[] => [
    `### Part ${p.index} · ${p.bytes} B`,
    p.text,
  ];
  if (!prompt.grouped) return prompt.parts.flatMap(part);
  const out: string[] = [];
  const groups: [PromptGroup, string][] = [
    ['shared', '## Shared'],
    ['session', '## Session-specific'],
  ];
  for (const [group, heading] of groups) {
    const parts = prompt.parts.filter((p) => p.group === group);
    if (parts.length === 0) continue;
    out.push(heading, ...parts.flatMap(part));
  }
  return out;
}

function toolBlocks(view: SystemPromptView): string[] {
  if (view.tools.items.length === 0) return [MSG_NO_TOOLS];
  return view.tools.items.flatMap((t) => [
    `## ${t.name}${t.server !== null ? ` · server ${t.server}` : ''}`,
    t.description ?? `_${MSG_NO_DESCRIPTION}_`,
    ...(t.schemaJson !== null ? [fenced('json', t.schemaJson)] : []),
  ]);
}

function flagBlocks(view: SystemPromptView): string[] {
  if (view.flags.length === 0) return [MSG_NO_FLAGS];
  return view.flags.map((f) => {
    if (!f.isObject) return `- \`${f.key}\`: ${f.value}`;
    const block = fenced('json', f.value)
      .split('\n')
      .map((l) => (l ? `  ${l}` : l))
      .join('\n');
    return `- \`${f.key}\`:\n\n${block}`;
  });
}

/** The whole view as Markdown, for Copy and Download (DD 10). */
export function systemPromptViewToMarkdown(view: SystemPromptView): string {
  const blocks =
    view.error !== null
      ? ['# System prompt', view.error]
      : [
          '# System prompt',
          ...promptBlocks(view),
          '# Tool definitions',
          ...toolBlocks(view),
          '# Flags',
          ...flagBlocks(view),
        ];
  return blocks.join('\n\n') + '\n';
}

/** `system-prompt-<first string sessionId>.md`, else `system-prompt.md`. */
export function exportFileName(main: Record<string, unknown>[]): string {
  const line = main.find(
    (l) => typeof l.sessionId === 'string' && l.sessionId !== '',
  );
  const id =
    line && typeof line.sessionId === 'string'
      ? line.sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
      : '';
  return id ? `system-prompt-${id}.md` : 'system-prompt.md';
}
