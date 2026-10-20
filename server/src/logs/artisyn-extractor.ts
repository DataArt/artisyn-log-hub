// Type-only import — `claude-extractor.ts` owns the record shape because it is the module
// that consumes it (a hook record is an input to extraction). Nothing is
// imported the other way, so this introduces no cycle.
import type { HookEditRecord } from './claude-extractor';
// Type-only import — the harness inventory extractors below consume an already-loaded,
// already-validated `HarnessSnapshotBody` (DD-9/DD-10); they never read artisyn lines
// themselves for this purpose any more.
import type { HarnessSnapshotBody } from './harness-snapshot';

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as AnyRecord;
  }
  return null;
}

export function coerceContextValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return '';
}

export function extractRepoUrls(lines: object[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const rec = line as AnyRecord;
    const git = asRecord(rec.git);
    // A project with no git repo at all has `git: null`; newer hooks then send a top-level
    // `cwd`, which stands in as the (local-path) repo identity source.
    const repo = git ? git.repo : rec.git === null ? rec.cwd : undefined;
    if (typeof repo !== 'string' || repo === '') continue;
    if (seen.has(repo)) continue;
    seen.add(repo);
    result.push(repo);
  }
  return result;
}

function stripIdeOpenedFiles(text: string): string {
  return text
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
    .trim();
}

function extractFilenameFromIdeTag(text: string): string | null {
  const match = text.match(/The user opened the file (.+?) in the IDE/);
  if (!match) return null;
  const fullPath = match[1].trim();
  // Handle both Windows (\) and Unix (/) separators
  return fullPath.split(/[/\\]/).pop() ?? fullPath;
}

export function extractFirstPrompt(lines: object[]): string | null {
  for (const line of lines) {
    const rec = line as AnyRecord;
    let raw: string | null = null;

    if (
      (rec['event'] === 'prompt_start' || rec['event'] === 'prompt') &&
      typeof rec['prompt'] === 'string' &&
      rec['prompt'] !== ''
    ) {
      raw = rec['prompt'];
    } else if (rec['type'] === 'user') {
      if (typeof rec['text'] === 'string' && rec['text'] !== '')
        raw = rec['text'];
      else if (typeof rec['content'] === 'string' && rec['content'] !== '')
        raw = rec['content'];
    }

    if (raw === null) continue;

    const stripped = stripIdeOpenedFiles(raw);
    if (stripped !== '') return stripped;

    // Prompt contained only <ide_opened_file> — fall back to the filename
    const filename = extractFilenameFromIdeTag(raw);
    return filename ?? raw;
  }
  return null;
}

const NON_ACTIVITY_LINE_TYPES = new Set([
  'hook-status',
  'system-context',
  'skill-definitions',
  'agent-definitions',
  'mcp-config',
  // The harness snapshot — `harness-snapshot` (full body) and `harness-snapshot-ref` (the
  // ref-only line most uploads carry) — is the hook's self-reported skill/agent/MCP/rule
  // inventory (DD-1 in docs/tasks/todo/2026-10-16-sysctx-skill-source/impl-plan.md). Neither
  // is session activity.
  'harness-snapshot',
  'harness-snapshot-ref',
  // The code-inventory snapshot is a throttled repo-size report the hook prefixes
  // onto an upload, not session activity. Its `capturedAt`/`timestamp` can predate the
  // session by up to the 6h throttle window, so counting it would stretch the session's
  // start/end range.
  'code-inventory',
]);

export function extractTimestampRange(lines: object[]): {
  startTime: string | null;
  endTime: string | null;
} {
  let minTs: number | null = null;
  let maxTs: number | null = null;

  for (const line of lines) {
    if (NON_ACTIVITY_LINE_TYPES.has((line as AnyRecord)['type'] as string))
      continue;
    const ts = (line as AnyRecord)['timestamp'];
    if (typeof ts !== 'string' || ts === '') continue;
    const ms = Date.parse(ts);
    if (isNaN(ms)) continue;
    if (minTs === null || ms < minTs) minTs = ms;
    if (maxTs === null || ms > maxTs) maxTs = ms;
  }

  return {
    startTime: minTs !== null ? new Date(minTs).toISOString() : null,
    endTime: maxTs !== null ? new Date(maxTs).toISOString() : null,
  };
}

export function extractGitBranch(lines: object[]): string | null {
  for (const line of lines) {
    const git = asRecord((line as AnyRecord).git);
    const branch = git?.branch;
    if (typeof branch === 'string' && branch !== '') return branch;
  }
  return null;
}

/**
 * The two repo roots the hook uploads on `prompt_start` / `SessionStart`,
 * stored on `logs.git_repo_root` / `logs.git_worktree_root` exactly as
 * {@link extractGitBranch}'s result is stored on `logs.git_branch`.
 *
 * - `root` — `getGitRoot()`'s `--git-common-dir` answer, i.e. the *primary* checkout's root.
 * - `worktreeRoot` — `git rev-parse --show-toplevel`, which differs from `root` only inside a
 *   linked worktree. Without it every path of a worktree session normalises as out-of-repo.
 *
 * Both are `null` for an older hook that never sent them — which is not an error state: the
 * session simply stays un-normalised until an upload from an updated hook arrives, and
 * `renormaliseSessionChangedPaths()` then heals it from the stored raw paths.
 */
export function extractGitRoots(lines: object[]): {
  root: string | null;
  worktreeRoot: string | null;
} {
  let root: string | null = null;
  let worktreeRoot: string | null = null;
  for (const line of lines) {
    const git = asRecord((line as AnyRecord).git);
    if (git === null) continue;
    if (root === null) {
      const value = git['root'];
      if (typeof value === 'string' && value !== '') root = value;
    }
    if (worktreeRoot === null) {
      const value = git['worktreeRoot'];
      if (typeof value === 'string' && value !== '') worktreeRoot = value;
    }
    if (root !== null && worktreeRoot !== null) break;
  }
  return { root, worktreeRoot };
}

/**
 * One `code-inventory` snapshot: how big the tracked codebase was when the
 * hook last measured it. It is the denominator behind the report's "share of the codebase
 * touched" indicators, which is why a *history* is kept rather than one current row — a
 * report divides by the newest snapshot at or before its own period end.
 */
export interface CodeInventoryEvent {
  projectRoot: string | null;
  branch: string | null;
  commitSha: string | null;
  capturedAt: string;
  trackedFiles: number;
  trackedLines: number;
  trackedBinaryFiles: number;
}

/**
 * Extracts the newest `code-inventory` line of an artisyn upload, or `null`.
 *
 * Per-field `typeof` guards in the {@link extractHookStatus} style: neither logs route has a
 * DTO or a zod schema, so a hook that sends a half-built payload must be ignored here rather
 * than write a `NaN` row. The three counters and `capturedAt` are mandatory; `projectRoot`,
 * `branch` and `commitSha` are optional (a detached HEAD has no branch, a repo with no
 * commits has no sha).
 *
 * The *newest* line wins, not the first: an upload can carry more than one snapshot when the
 * previous run's prefix was never committed, and the later measurement is the true one.
 */
export function extractCodeInventory(
  lines: object[],
): CodeInventoryEvent | null {
  let best: CodeInventoryEvent | null = null;
  let bestMs = -Infinity;

  for (const line of lines) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'code-inventory') continue;

    const capturedAt =
      typeof rec['capturedAt'] === 'string'
        ? rec['capturedAt']
        : typeof rec['timestamp'] === 'string'
          ? rec['timestamp']
          : null;
    if (capturedAt === null) continue;
    const capturedMs = Date.parse(capturedAt);
    if (isNaN(capturedMs)) continue;

    if (
      typeof rec['trackedFiles'] !== 'number' ||
      typeof rec['trackedLines'] !== 'number'
    ) {
      continue;
    }

    if (capturedMs < bestMs) continue;
    bestMs = capturedMs;
    best = {
      projectRoot:
        typeof rec['projectRoot'] === 'string' && rec['projectRoot'] !== ''
          ? rec['projectRoot']
          : null,
      branch: typeof rec['branch'] === 'string' ? rec['branch'] : null,
      commitSha:
        typeof rec['commitSha'] === 'string' && rec['commitSha'] !== ''
          ? rec['commitSha']
          : null,
      capturedAt: new Date(capturedMs).toISOString(),
      trackedFiles: rec['trackedFiles'],
      trackedLines: rec['trackedLines'],
      trackedBinaryFiles:
        typeof rec['trackedBinaryFiles'] === 'number'
          ? rec['trackedBinaryFiles']
          : 0,
    };
  }

  return best;
}

export interface HookStatusEvent {
  hookVersion: string;
  timestamp: string;
  logTail: string[];
  nonUploadableLogs: { file: string; reason: string }[];
  recommendations: { rule: string; message: string; detectedAt: string }[];
}

export function extractHookStatus(lines: object[]): HookStatusEvent | null {
  for (const line of lines) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'hook-status') continue;

    const hookVersion = rec['hookVersion'];
    const timestamp = rec['timestamp'];
    if (typeof hookVersion !== 'string' || typeof timestamp !== 'string') {
      continue;
    }

    const logTail = Array.isArray(rec['logTail'])
      ? (rec['logTail'] as unknown[]).filter(
          (l): l is string => typeof l === 'string',
        )
      : [];

    const nonUploadableLogs = Array.isArray(rec['nonUploadableLogs'])
      ? (rec['nonUploadableLogs'] as unknown[])
          .map((entry) => {
            const r = asRecord(entry);
            if (
              r === null ||
              typeof r['file'] !== 'string' ||
              typeof r['reason'] !== 'string'
            ) {
              return null;
            }
            return { file: r['file'], reason: r['reason'] };
          })
          .filter((v): v is { file: string; reason: string } => v !== null)
      : [];

    const recommendations = Array.isArray(rec['recommendations'])
      ? (rec['recommendations'] as unknown[])
          .map((entry) => {
            const r = asRecord(entry);
            if (
              r === null ||
              typeof r['rule'] !== 'string' ||
              typeof r['message'] !== 'string' ||
              typeof r['detectedAt'] !== 'string'
            ) {
              return null;
            }
            return {
              rule: r['rule'],
              message: r['message'],
              detectedAt: r['detectedAt'],
            };
          })
          .filter(
            (v): v is { rule: string; message: string; detectedAt: string } =>
              v !== null,
          )
      : [];

    // At most one hook-status line is expected per artisyn upload — return on first match.
    return {
      hookVersion,
      timestamp,
      logTail,
      nonUploadableLogs,
      recommendations,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Harness element inventory — self-reported skill/rule/MCP inventory, mapped from the
// loaded harness snapshot (DD-9, DD-10; `harness-snapshot.ts`). These extractors only
// produce the *inventory* shape; usage/token attribution is computed separately from the
// `claude` transcript at ingest time (`claude-extractor.ts`).
// ---------------------------------------------------------------------------

const CLAUDE_RULES_PATH_MARKER = '.claude/rules/';

/**
 * Derives a stable rule "name" from a `.claude/rules/*.md` file path, mirroring the client's
 * own `normalizeRuleName()` (`client/src/viewer/pages/repository/session-log/log-parser.ts`):
 * basename, extension stripped. Kept in sync by convention rather than a shared import, since
 * `client/` and `server/` are isolated packages (see `client.md`).
 */
function ruleNameFromPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const filename = parts[parts.length - 1] ?? normalized;
  return filename.replace(/\.md$/i, '');
}

export interface HarnessRuleInventoryEntry {
  name: string;
  path: string;
  /**
   * File size in bytes (`claudeMd.files[].bytes`), used as the "chars" denominator for the
   * first-assistant-message token split. `0` when the hook's payload
   * doesn't carry a numeric `bytes` field.
   */
  bytes: number;
}

/**
 * Rule inventory: classified server-side from the loaded snapshot's
 * `systemContext.files[]` (DD-10). Only files whose path contains `.claude/rules/` (any
 * depth, backslash-normalized for Windows-authored paths) count as rules;
 * `CLAUDE.md`/`CLAUDE.local.md` files are not rule rows.
 */
export function extractHarnessRuleInventory(
  body: HarnessSnapshotBody,
): HarnessRuleInventoryEntry[] {
  const seen = new Set<string>();
  const result: HarnessRuleInventoryEntry[] = [];
  const files = body.systemContext?.files;
  if (!Array.isArray(files)) return result;

  for (const file of files) {
    const rawPath = file?.path;
    if (typeof rawPath !== 'string' || rawPath === '') continue;
    const normalized = rawPath.replace(/\\/g, '/');
    if (!normalized.includes(CLAUDE_RULES_PATH_MARKER)) continue;

    const name = ruleNameFromPath(rawPath);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const bytes = typeof file?.bytes === 'number' ? file.bytes : 0;
    result.push({ name, path: rawPath, bytes });
  }
  return result;
}

export interface HarnessSkillInventoryEntry {
  name: string;
  /**
   * File size in bytes (`skills[].bytes`), used as the "chars" denominator for the
   * first-assistant-message token split. `0` when the hook's payload
   * doesn't carry a numeric `bytes` field.
   */
  bytes: number;
  /**
   * The snapshot skill entry's own `source` (DD-1/DD-10): `'project' | 'user' | 'plugin'`.
   * `null` only if a malformed entry's `source` isn't one of those three strings.
   */
  source: 'project' | 'user' | 'plugin' | null;
}

/**
 * Skill inventory: from the loaded snapshot's `skills[]` (DD-10). Workflow entries
 * (`kind === 'workflow'`) are left out — harness-usage tracks those as workflow runs, not
 * skill-context injections.
 */
export function extractHarnessSkillInventory(
  body: HarnessSnapshotBody,
): HarnessSkillInventoryEntry[] {
  const seen = new Set<string>();
  const result: HarnessSkillInventoryEntry[] = [];
  if (!Array.isArray(body.skills)) return result;

  for (const skill of body.skills) {
    if (skill?.kind === 'workflow') continue;
    const name = skill?.name;
    if (typeof name !== 'string' || name === '' || seen.has(name)) continue;
    seen.add(name);
    const bytes = typeof skill?.bytes === 'number' ? skill.bytes : 0;
    const rawSource: unknown = skill?.source;
    const source =
      rawSource === 'project' || rawSource === 'user' || rawSource === 'plugin'
        ? rawSource
        : null;
    result.push({ name, bytes, source });
  }
  return result;
}

export interface HarnessMcpToolInventoryEntry {
  name: string;
  schemaSizeTokens: number;
}

export interface HarnessMcpServerInventoryEntry {
  name: string;
  /** `undefined` — the probe never ran for this snapshot (a ref-only resend, or an old hook). */
  connected: boolean | undefined;
  tools: HarnessMcpToolInventoryEntry[];
}

/**
 * MCP inventory: from the loaded snapshot's `mcpServers[]` (DD-10) — same shape as the
 * `mcp-config` event it replaces. The snapshot's top-level `perToolDetailSupported` capability
 * flag (DD-9 step 4) is read directly off the `HarnessSnapshotBody` by the ingest step, not
 * through this extractor, since it is no longer a per-event flag duplicated onto every server.
 */
export function extractHarnessMcpInventory(
  body: HarnessSnapshotBody,
): HarnessMcpServerInventoryEntry[] {
  const byName = new Map<string, HarnessMcpServerInventoryEntry>();
  if (!Array.isArray(body.mcpServers)) return [];

  for (const server of body.mcpServers) {
    const name = server?.name;
    if (typeof name !== 'string' || name === '') continue;

    const connected =
      typeof server?.connected === 'boolean' ? server.connected : undefined;

    const rawTools: unknown = server?.tools;
    const tools: HarnessMcpToolInventoryEntry[] = Array.isArray(rawTools)
      ? rawTools
          .map((t: unknown) => {
            const tool = asRecord(t);
            const toolName = tool?.['name'];
            if (typeof toolName !== 'string' || toolName === '') return null;
            const schemaSizeTokens =
              typeof tool?.['schemaSizeTokens'] === 'number'
                ? tool['schemaSizeTokens']
                : 0;
            return { name: toolName, schemaSizeTokens };
          })
          .filter((v): v is HarnessMcpToolInventoryEntry => v !== null)
      : [];

    // Last occurrence wins — matches the "last self-report wins" convention used for
    // hook-state columns elsewhere; a well-formed snapshot never repeats a server name.
    byName.set(name, { name, connected, tools });
  }
  return [...byName.values()];
}

export function extractContextPairs(
  lines: object[],
): Array<{ key: string; value: string }> {
  const seen = new Set<string>();
  const result: Array<{ key: string; value: string }> = [];
  for (const line of lines) {
    const context = asRecord((line as AnyRecord).context);
    if (context === null) continue;
    for (const [key, val] of Object.entries(context)) {
      if (!key) continue;
      const value = coerceContextValue(val);
      if (!value) continue;
      const pairKey = `${key}\0${value}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      result.push({ key, value });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Hook-derived per-edit-call records — the only source of `+`/`-` and
// `change_kind` for delegated work, whose transcripts carry no usable `toolUseResult`.
//
// These are an *input to extraction*, never a patch applied to a computed row:
// `session_stats` and `session_changed_paths` are rebuilt purely from
// the transcript by both `logs.service.ts` and `recomputeAllSessionStats`, so anything
// merged into a finished row would be erased by the next recompute.
// ---------------------------------------------------------------------------

/**
 * Records grouped by the node they belong to, each node's records keyed by `tool_use_id`.
 *
 * `root` holds the records with **no** `agent_id`. That absence is normal attribution data,
 * not an old-install marker: a root-session `PostToolUse` payload carries no
 * `agent_id`/`agent_type` at all. A record with neither `tool_use_id` nor `agent_id` is what
 * an old install produces, and is dropped — matching by file path and call ordering would be
 * a guess, and it collapses outright on two writes of the same path in one turn.
 */
export interface HookEditRecordIndex {
  root: Map<string, HookEditRecord>;
  byAgentId: Map<string, Map<string, HookEditRecord>>;
  /** Total records indexed — `0` means "no coverage from this source", never an error. */
  total: number;
}

/** The empty index, shared by every "no artisyn log (yet)" call site. */
export const EMPTY_HOOK_EDIT_RECORDS: HookEditRecordIndex = {
  root: new Map(),
  byAgentId: new Map(),
  total: 0,
};

function readChangeKind(value: unknown): 'added' | 'modified' | null {
  return value === 'added' || value === 'modified' ? value : null;
}

/**
 * Reads the hook's derived per-call record off one `PostToolUse` event.
 *
 * The hook emits it as a nested `edit_result` object; the flat form is accepted as well so a
 * payload shape difference cannot silently drop coverage. `added`/`removed` stay `null`
 * unless both are numbers — a half-filled record is not a diff, and crediting it as `+0/−0`
 * would turn an uncovered call into a covered one.
 */
function readEditResultPayload(rec: AnyRecord): {
  added: number | null;
  removed: number | null;
  changeKind: 'added' | 'modified' | null;
  filePath: string | null;
} | null {
  const payload =
    asRecord(rec['edit_result']) ?? asRecord(rec['editResult']) ?? rec;

  const hasAny =
    typeof payload['added'] === 'number' ||
    typeof payload['removed'] === 'number' ||
    readChangeKind(payload['changeKind']) !== null ||
    typeof payload['filePath'] === 'string';
  if (!hasAny) return null;

  const bothCounts =
    typeof payload['added'] === 'number' &&
    typeof payload['removed'] === 'number';

  return {
    added: bothCounts ? (payload['added'] as number) : null,
    removed: bothCounts ? (payload['removed'] as number) : null,
    changeKind: readChangeKind(payload['changeKind']),
    filePath:
      typeof payload['filePath'] === 'string' && payload['filePath'] !== ''
        ? payload['filePath']
        : null,
  };
}

/**
 * Indexes every hook-derived edit record in one artisyn upload, by node and `tool_use_id`.
 *
 * Same per-field `typeof`-guard style as {@link extractCodeInventory}: the logs routes have
 * no DTO, so every field is checked rather than trusted. The first record for a given
 * `tool_use_id` wins — an upload can repeat an event, and the earliest is the real one.
 */
export function extractEditResultRecords(lines: object[]): HookEditRecordIndex {
  const index: HookEditRecordIndex = {
    root: new Map(),
    byAgentId: new Map(),
    total: 0,
  };

  for (const line of lines) {
    const rec = line as AnyRecord;
    if (rec['hook_event_name'] !== 'PostToolUse') continue;

    // No `tool_use_id` — an old install. The record cannot be joined on call identity, and
    // matching on `(file_path, ordinal)` instead is explicitly not acceptable.
    const toolUseId = rec['tool_use_id'];
    if (typeof toolUseId !== 'string' || toolUseId === '') continue;

    const payload = readEditResultPayload(rec);
    if (payload === null) continue;

    const agentIdRaw = rec['agent_id'];
    const agentId =
      typeof agentIdRaw === 'string' && agentIdRaw !== '' ? agentIdRaw : null;

    const target =
      agentId === null
        ? index.root
        : (index.byAgentId.get(agentId) ??
          index.byAgentId.set(agentId, new Map()).get(agentId)!);

    if (target.has(toolUseId)) continue;
    target.set(toolUseId, { toolUseId, agentId, ...payload });
    index.total += 1;
  }

  return index;
}

/**
 * Picks the records belonging to one session node.
 *
 * A `claude` log is the root transcript and takes the un-attributed records. A
 * `claude-subagent` log is one agent, and its `sessions.session_id` is the transcript file's
 * name: `<agent-id>` for a `Task` sub-agent and `agent-<agent-id>` for a workflow agent
 * (`send-logs-hook.js` builds both). The hook's `agent_id` is matched against both spellings
 * so neither naming convention silently loses its coverage.
 */
export function selectEditResultRecordsForSession(
  index: HookEditRecordIndex,
  sessionId: string,
  isSubagentLog: boolean,
): ReadonlyMap<string, HookEditRecord> {
  if (!isSubagentLog) return index.root;
  const stripped = sessionId.startsWith('agent-')
    ? sessionId.slice('agent-'.length)
    : null;
  return (
    index.byAgentId.get(sessionId) ??
    (stripped !== null ? index.byAgentId.get(stripped) : undefined) ??
    index.byAgentId.get(`agent-${sessionId}`) ??
    EMPTY_HOOK_EDIT_RECORDS.root
  );
}
