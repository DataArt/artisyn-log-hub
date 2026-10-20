import { splitCacheCreationTokens } from './claude-extractor';

/**
 * Server-side prompt-turn walk over a raw Claude transcript.
 *
 * This is the server twin of the client's turn detection in
 * `client/src/viewer/pages/repository/session-log/log-parser.ts`
 * (`isQualifyingUserEvent` + `collectTurnUuids`). It deliberately reproduces the *same*
 * two rules and nothing else — no pricing, no tool detail, no sub-agent folding — because
 * the only thing the server needs from a turn is:
 *
 * - how many cache-creation tokens the turn produced **on its own** assistant events, and
 * - which file paths it touched, plus whether a compaction boundary sits on its edge,
 *
 * i.e. exactly the inputs of the cache-creation cause decomposition.
 *
 * The walk is **threshold-free** on purpose: the "high cache creation" threshold is a
 * per-team (`team_repo_config`) / per-user (`repo_config`) field, so the same log has to be classified once per
 * config scope. {@link walkTurns} parses the transcript once; {@link classifyTurnCauses}
 * applies a threshold to that result and is cheap enough to call per scope.
 *
 * Invariant, asserted by the unit tests: for any threshold,
 * `compactionTokens + fileRereadTokens + unattributedTokens ===`
 * `extractClaudeStats(lines, '', isSubagentLog).cacheWriteTokens`.
 */

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as AnyRecord;
  }
  return null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** File tools whose paths feed the "file re-read" cause. Mirrors the client's `fileToolNames`. */
const FILE_TOOL_NAMES = new Set(['Read', 'Edit', 'Write', 'Glob']);

/** One prompt turn, with only the fields the cause decomposition needs. */
export interface WalkedTurn {
  /**
   * 1-based ordinal across ALL `type=user` events (not just qualifying ones), matching
   * the client's `PromptTurn.index` so the two sides can be compared turn by turn.
   */
  index: number;
  /** The qualifying user event's uuid; `null` for the (rare) uuid-less event. */
  uuid: string | null;
  /**
   * Cache-creation tokens (5m + 1h) on this turn's own in-scope `type=assistant` events.
   * De-duplicated by `message.id` across the whole session, exactly as
   * `extractClaudeStats()` does, so per-turn values never double-count a multi-block response.
   */
  creationTokens: number;
  /** Paths touched by `Read`/`Edit`/`Write`/`Glob` calls in this turn, in call order. */
  paths: string[];
  /** A `compact_boundary` system event sits inside, or immediately before, this turn. */
  hasCompactBoundary: boolean;
}

export interface TurnWalkResult {
  turns: WalkedTurn[];
  /**
   * Cache-creation tokens over every in-scope assistant event in the session —
   * equal to `ClaudeStats.cacheWriteTokens` for the same log.
   */
  totalCreationTokens: number;
  /**
   * Cache-creation tokens on in-scope assistant events that belong to no turn (no uuid, or
   * not reachable from any qualifying user event). Routed to `unattributed` by
   * {@link classifyTurnCauses} so the three buckets still sum to the session total.
   */
  orphanCreationTokens: number;
}

export interface TurnCauseTotals {
  compactionTokens: number;
  fileRereadTokens: number;
  unattributedTokens: number;
  compactionTurns: number;
  fileRereadTurns: number;
  unattributedTurns: number;
}

/**
 * Client parity: `log-parser.ts`'s `isQualifyingUserEvent`. Keep the two in sync — the
 * shared parity fixture test exists to catch drift.
 */
function isQualifyingUserEvent(
  rec: AnyRecord,
  isSubagentLog: boolean,
): boolean {
  if (rec['type'] !== 'user') return false;
  if (!isSubagentLog && rec['isSidechain'] === true) return false;
  if (rec['isMeta'] === true) return false;
  // Sub-agent completion events carry toolUseResult.agentId — not user-typed prompts.
  const toolUseResult = asRecord(rec['toolUseResult']);
  if (toolUseResult !== null && toolUseResult['agentId'] != null) return false;

  const message = asRecord(rec['message']);
  const content = message?.['content'];
  if (content === undefined || content === null) return false;

  if (typeof content === 'string') {
    if (content.length === 0) return false;
    const trimmed = content.trimStart();
    // Old-format slash commands (/clear etc.) and harness task notifications are not prompts;
    // the new <command-message> format IS a real user intent (skill invocations).
    if (trimmed.startsWith('<command-name>')) return false;
    if (trimmed.startsWith('<task-notification>')) return false;
    if (trimmed.startsWith('<command-message>')) return true;
    return true;
  }

  const blocks = asArray(content);
  if (blocks === null || blocks.length === 0) return false;
  return blocks.some((block) => asRecord(block)?.['type'] === 'text');
}

/**
 * Client parity: `log-parser.ts`'s `collectTurnUuids`. BFS over parent -> child, stopping at
 * the *other* turn roots so tokens stay attributed to a single turn. Note a stop uuid is
 * itself added to the set (it just isn't traversed through), exactly as on the client.
 */
function collectTurnUuids(
  startUuid: string,
  childrenByParent: Map<string, string[]>,
  stopUuids: Set<string>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [startUuid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current !== startUuid && stopUuids.has(current)) continue;
    const children = childrenByParent.get(current);
    if (children) {
      for (const child of children) {
        if (!visited.has(child)) queue.push(child);
      }
    }
  }
  return visited;
}

/**
 * Is a `compact_boundary` the last *real* transcript line before `lineIndex`?
 *
 * A compaction boundary is emitted just before the prompt that continues the conversation on
 * the compacted context, but the raw body is not purely a transcript: the hook interleaves
 * uuid-less bookkeeping lines (`mode`, `last-prompt`, `file-history-delta`, …) and `isMeta`
 * notices between real events. Comparing raw line indices alone would therefore miss the
 * boundary whenever one of those happened to be written in between, so they are skipped.
 */
function isPrecededByCompactBoundary(
  records: AnyRecord[],
  lineIndex: number,
  compactBoundaryLineIndices: Set<number>,
): boolean {
  for (let i = lineIndex - 1; i >= 0; i--) {
    if (compactBoundaryLineIndices.has(i)) return true;
    const rec = records[i];
    if (asString(rec['uuid']) === null || rec['isMeta'] === true) continue;
    return false;
  }
  return false;
}

function extractFilePath(toolName: string, input: AnyRecord): string | null {
  // Glob has no file_path — the client indexes it by its pattern, so do the same.
  const raw = asString(input[toolName === 'Glob' ? 'pattern' : 'file_path']);
  // An empty path carries no identity: keeping it would make every tool call with a missing
  // argument look like a re-read of every other one.
  return raw !== null && raw !== '' ? raw : null;
}

/**
 * Parses a raw Claude transcript into prompt turns carrying their own cache-creation
 * tokens, file paths and compaction flag. Threshold-free — see {@link classifyTurnCauses}.
 *
 * @param lines raw `logs.body` array (one transcript event per entry)
 * @param isSubagentLog `true` for a `claude-subagent` log, where every event legitimately
 *   carries `isSidechain: true`; on a main-session log those events are sub-agent proxies
 *   already counted in the sub-agent's own log and are skipped, matching `extractClaudeStats`.
 */
export function walkTurns(
  lines: object[],
  isSubagentLog: boolean = false,
): TurnWalkResult {
  const records: AnyRecord[] = [];
  for (const line of lines) {
    const rec = asRecord(line);
    if (rec !== null) records.push(rec);
  }

  const recordByUuid = new Map<string, AnyRecord>();
  const childrenByParent = new Map<string, string[]>();
  for (const rec of records) {
    const uuid = asString(rec['uuid']);
    if (uuid === null) continue;
    recordByUuid.set(uuid, rec);
    const parentUuid = asString(rec['parentUuid']);
    if (parentUuid === null) continue;
    const siblings = childrenByParent.get(parentUuid);
    if (siblings) siblings.push(uuid);
    else childrenByParent.set(parentUuid, [uuid]);
  }

  // Pass 1 — per-event cache creation, de-duplicated by message.id across the WHOLE session
  // (not per turn), so the per-turn sums add up to the same total `extractClaudeStats()` reports.
  const creationByUuid = new Map<string, number>();
  let totalCreationTokens = 0;
  const countedUsageKeys = new Set<string>();
  for (const rec of records) {
    if (rec['type'] !== 'assistant') continue;
    if (!isSubagentLog && rec['isSidechain'] === true) continue;
    const message = asRecord(rec['message']);
    if (message === null) continue;
    const usage = asRecord(message['usage']);
    if (usage === null) continue;
    const uuid = asString(rec['uuid']);
    const usageKey = asString(message['id']) ?? uuid;
    if (usageKey !== null) {
      if (countedUsageKeys.has(usageKey)) continue;
      countedUsageKeys.add(usageKey);
    }
    const { write5m, write1h } = splitCacheCreationTokens(usage);
    const created = write5m + write1h;
    if (created === 0) continue;
    totalCreationTokens += created;
    if (uuid !== null) {
      creationByUuid.set(uuid, (creationByUuid.get(uuid) ?? 0) + created);
    }
  }

  // Pass 2 — compaction boundaries, by uuid (inside a turn) and by line position
  // (immediately before a turn's root, which is where a post-compaction prompt lands).
  const compactBoundaryUuids = new Set<string>();
  const compactBoundaryLineIndices = new Set<number>();
  records.forEach((rec, lineIndex) => {
    if (rec['type'] !== 'system') return;
    if (rec['subtype'] !== 'compact_boundary') return;
    if (asRecord(rec['compactMetadata']) === null) return;
    compactBoundaryLineIndices.add(lineIndex);
    const uuid = asString(rec['uuid']);
    if (uuid !== null) compactBoundaryUuids.add(uuid);
  });

  // Pass 3 — qualifying user events, with the client's 1-based index over ALL user events.
  const qualifying: Array<{
    rec: AnyRecord;
    index: number;
    lineIndex: number;
  }> = [];
  let userEventCounter = 0;
  records.forEach((rec, lineIndex) => {
    if (rec['type'] !== 'user') return;
    userEventCounter++;
    if (isQualifyingUserEvent(rec, isSubagentLog)) {
      qualifying.push({ rec, index: userEventCounter, lineIndex });
    }
  });

  const allQualifyingUuids = new Set<string>();
  for (const q of qualifying) {
    const uuid = asString(q.rec['uuid']);
    if (uuid !== null) allQualifyingUuids.add(uuid);
  }

  const turns: WalkedTurn[] = [];
  const attributedUuids = new Set<string>();

  for (const { rec, index, lineIndex } of qualifying) {
    const uuid = asString(rec['uuid']);
    if (uuid === null) {
      // Mirrors the client, which still emits a turn (with empty metrics) for a uuid-less
      // qualifying user event — keeping the two turn lists index-for-index comparable.
      turns.push({
        index,
        uuid: null,
        creationTokens: 0,
        paths: [],
        hasCompactBoundary: false,
      });
      continue;
    }

    const stopUuids = new Set(allQualifyingUuids);
    stopUuids.delete(uuid);
    const uuidSet = collectTurnUuids(uuid, childrenByParent, stopUuids);

    let creationTokens = 0;
    const paths: string[] = [];
    let hasCompactBoundary = isPrecededByCompactBoundary(
      records,
      lineIndex,
      compactBoundaryLineIndices,
    );

    for (const memberUuid of uuidSet) {
      if (compactBoundaryUuids.has(memberUuid)) hasCompactBoundary = true;

      const created = creationByUuid.get(memberUuid);
      if (created !== undefined && !attributedUuids.has(memberUuid)) {
        attributedUuids.add(memberUuid);
        creationTokens += created;
      }

      const memberRec = recordByUuid.get(memberUuid);
      if (memberRec === undefined || memberRec['type'] !== 'assistant')
        continue;
      const content = asArray(asRecord(memberRec['message'])?.['content']);
      if (content === null) continue;
      for (const block of content) {
        const b = asRecord(block);
        if (b === null || b['type'] !== 'tool_use') continue;
        const name = asString(b['name']);
        if (name === null || !FILE_TOOL_NAMES.has(name)) continue;
        const input = asRecord(b['input']);
        if (input === null) continue;
        const filePath = extractFilePath(name, input);
        if (filePath !== null) paths.push(filePath);
      }
    }

    turns.push({ index, uuid, creationTokens, paths, hasCompactBoundary });
  }

  let attributedCreationTokens = 0;
  for (const memberUuid of attributedUuids) {
    attributedCreationTokens += creationByUuid.get(memberUuid) ?? 0;
  }

  return {
    turns,
    totalCreationTokens,
    orphanCreationTokens: Math.max(
      0,
      totalCreationTokens - attributedCreationTokens,
    ),
  };
}

/**
 * Applies a "high cache creation" threshold to a {@link walkTurns} result and buckets every
 * cache-creation token into exactly one cause.
 *
 * ```
 * seenPaths = ∅
 * for each turn T in order:
 *     reread(T) = paths(T) ∩ seenPaths ≠ ∅       // session-level, not per-turn
 *     seenPaths ∪= paths(T)
 *     if creation(T) >= threshold and compact(T): -> compaction
 *     elif creation(T) >= threshold and reread(T): -> fileReread
 *     else:                                       -> unattributed
 * unattributed += orphan cache-creation tokens
 * ```
 *
 * A turn matching both causes is attributed to compaction. Sub-threshold turns are
 * unattributed, so the three buckets always sum to the session's cache-write total —
 * re-running this with a different threshold moves tokens between buckets but never
 * changes that total.
 */
export function classifyTurnCauses(
  walk: TurnWalkResult,
  threshold: number,
): TurnCauseTotals {
  const totals: TurnCauseTotals = {
    compactionTokens: 0,
    fileRereadTokens: 0,
    unattributedTokens: walk.orphanCreationTokens,
    compactionTurns: 0,
    fileRereadTurns: 0,
    unattributedTurns: 0,
  };

  const seenPaths = new Set<string>();
  for (const turn of walk.turns) {
    let isReread = false;
    for (const filePath of turn.paths) {
      if (seenPaths.has(filePath)) isReread = true;
    }
    for (const filePath of turn.paths) seenPaths.add(filePath);

    const isHigh = turn.creationTokens >= threshold;
    if (isHigh && turn.hasCompactBoundary) {
      totals.compactionTokens += turn.creationTokens;
      totals.compactionTurns++;
    } else if (isHigh && isReread) {
      totals.fileRereadTokens += turn.creationTokens;
      totals.fileRereadTurns++;
    } else {
      totals.unattributedTokens += turn.creationTokens;
      totals.unattributedTurns++;
    }
  }

  return totals;
}

// ---------------------------------------------------------------------------
// Deferred tools — server-side port of the client's
// `deferredTools` computation in `log-parser.ts` (~lines 2660-2681), which does not exist
// server-side elsewhere. Used by `claude-extractor.ts`'s `extractHarnessUsage` to decide
// whether a tool was `initial` or `deferred` in a given session.
// ---------------------------------------------------------------------------

export interface DeferredToolsWalkResult {
  /**
   * Net current deferred-tool names at the end of the transcript — `addedNames`/
   * `readdedNames` accumulate, `removedNames` subtracts. Client parity (`deferredTools`)
   * only; the initial-vs-deferred inference below uses `firstDeferredLineIndexByName`
   * instead, which is never cleared by a removal.
   */
  deferredToolNames: string[];
  /**
   * The earliest raw transcript line index (0-based, over the whole `lines` array) at
   * which a tool name appeared in an `addedNames`/`readdedNames` list. A later
   * `removedNames` entry for the same name does not clear this — only
   * `deferredToolNames` above reflects removal.
   */
  firstDeferredLineIndexByName: Map<string, number>;
}

/**
 * Parses every `deferred_tools_delta` attachment event in a transcript (client parity:
 * `log-parser.ts`'s `deferredTools` computation), plus the per-name first-appearance line
 * index the `is_initial` inference needs on top of it.
 */
export function walkDeferredToolsDelta(
  lines: object[],
): DeferredToolsWalkResult {
  const deferredSet = new Set<string>();
  const firstDeferredLineIndexByName = new Map<string, number>();

  lines.forEach((line, lineIndex) => {
    const rec = asRecord(line);
    if (rec === null || rec['type'] !== 'attachment') return;
    const attachment = asRecord(rec['attachment']);
    if (attachment === null || attachment['type'] !== 'deferred_tools_delta') {
      return;
    }

    const addedNames = asArray(attachment['addedNames']) ?? [];
    const readdedNames = asArray(attachment['readdedNames']) ?? [];
    const removedNames = asArray(attachment['removedNames']) ?? [];

    for (const raw of [...addedNames, ...readdedNames]) {
      const name = asString(raw);
      if (name === null) continue;
      deferredSet.add(name);
      if (!firstDeferredLineIndexByName.has(name)) {
        firstDeferredLineIndexByName.set(name, lineIndex);
      }
    }
    for (const raw of removedNames) {
      const name = asString(raw);
      if (name === null) continue;
      deferredSet.delete(name);
    }
  });

  return {
    deferredToolNames: [...deferredSet],
    firstDeferredLineIndexByName,
  };
}

/**
 * Tool initial-vs-deferred inference: a tool is `deferred` iff its name
 * first appeared in a `deferred_tools_delta` attachment strictly before the first
 * `tool_use` block using that name in the same transcript; a name never seen in any delta
 * (or one that only appears at/after its first use) is `initial`.
 *
 * @param firstToolUseLineIndex 0-based raw transcript line index of the tool's first
 *   `tool_use` block.
 * @param firstDeferredLineIndex `firstDeferredLineIndexByName.get(toolName)` — `undefined`
 *   when the name never appeared in any `deferred_tools_delta` attachment.
 */
export function inferToolIsInitial(
  firstToolUseLineIndex: number,
  firstDeferredLineIndex: number | undefined,
): boolean {
  if (firstDeferredLineIndex === undefined) return true;
  return firstDeferredLineIndex >= firstToolUseLineIndex;
}
