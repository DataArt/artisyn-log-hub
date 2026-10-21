import type { ClaudeMdFile, RuleInjection, TelemetryEvent } from './types';

// Instruction files (CLAUDE.md / CLAUDE.local.md / ~/.claude/CLAUDE.md / .claude/rules/*.md) of a
// session. Three sources are merged into `summary.claudeMd`: the hook's harness snapshot
// (`systemContext`, old Claude Code), the Claude log `instructions` attachment (initial context) and
// the per-turn `nested_memory` injections (loaded on demand). File text is never kept.

type InstructionRole = NonNullable<ClaudeMdFile['role']>;

/**
 * Display form of a User-type path: `~/.claude/<rest after the first "/.claude/">`, else
 * `~/<basename>`. Never returns the absolute home path.
 */
export function toUserDisplayPath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const marker = '/.claude/';
  const idx = norm.indexOf(marker);
  if (idx >= 0) return '~/.claude/' + norm.slice(idx + marker.length);
  return '~/' + (norm.split('/').pop() ?? norm);
}

export function classifyInstructionRole(
  rawPath: string,
  type?: string,
): InstructionRole {
  const norm = rawPath.replace(/\\/g, '/');
  if (norm.includes('.claude/rules/')) return 'rule';
  const t = type?.toLowerCase();
  if (t === 'user') return 'user-md';
  if (t === 'local' || /CLAUDE\.local\.md$/i.test(norm)) return 'local-md';
  return 'claude-md';
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Files of every `instructions` attachment in the log (initial context), without their text. */
export function extractInstructionFiles(
  events: TelemetryEvent[],
): ClaudeMdFile[] {
  const result: ClaudeMdFile[] = [];
  for (const e of events) {
    if (e.type !== 'attachment') continue;
    const ae = e as {
      attachment?: {
        type?: string;
        files?: Array<{ path?: string; type?: string; content?: string }>;
      };
    };
    if (ae.attachment?.type !== 'instructions') continue;
    for (const f of ae.attachment.files ?? []) {
      if (!f.path) continue;
      const isUser = f.type?.toLowerCase() === 'user';
      result.push({
        path: isUser ? toUserDisplayPath(f.path) : f.path,
        bytes: f.content ? utf8Bytes(f.content) : 0,
        role: classifyInstructionRole(f.path, f.type),
        ...(f.type ? { typeLabel: f.type.toLowerCase() } : {}),
      });
    }
  }
  return result;
}

/** Instruction files loaded during the session (`nested_memory`), from the per-turn injections. */
export function rulesToInstructionFiles(
  rulesInjected: RuleInjection[],
): ClaudeMdFile[] {
  const result: ClaudeMdFile[] = [];
  for (const r of rulesInjected) {
    if (!r.path) continue;
    result.push({
      path: r.path,
      bytes: r.bytes ?? 0,
      role: classifyInstructionRole(r.path, r.type),
      ...(r.type ? { typeLabel: r.type.toLowerCase() } : {}),
      onDemand: true,
    });
  }
  return result;
}

/**
 * Union per normalised path (`\` → `/`, lowercased). Later lists overwrite earlier entries;
 * the first-seen order is kept.
 */
export function mergeInstructionFiles(lists: ClaudeMdFile[][]): ClaudeMdFile[] {
  const byKey = new Map<string, ClaudeMdFile>();
  for (const list of lists) {
    for (const f of list) {
      byKey.set(f.path.replace(/\\/g, '/').toLowerCase(), f);
    }
  }
  return Array.from(byKey.values());
}
