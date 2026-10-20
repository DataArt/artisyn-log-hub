/**
 * Change surface — the `session_changed_paths` writer.
 *
 * Two entry points, one body:
 *
 * - {@link upsertSessionChangedPaths} runs at ingest, from the raw paths the extractor
 *   produced for one node.
 * - {@link renormaliseSessionChangedPaths} runs when the `artisyn` log finally lands and the
 *   repo root becomes known, rebuilding the normalised columns of a whole session tree from
 *   the `raw_path` values already stored. That is what makes a claude-before-artisyn upload
 *   order self-heal — without it, a session whose transcript arrived
 *   first would stay permanently un-normalised.
 *
 * Both write the `cs_*` aggregates on `session_stats` in the same call, so the counters can
 * never describe a different set of rows than the table holds.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { logs, sessionChangedPaths } from '../../database/schema/index';
import { getDescendantSessionIds } from '../session-tree.sql';
import {
  type SessionChangeSurfaceCounters,
  upsertSessionChangeSurfaceCounters,
} from '../session-stats-writer';
import type {
  ChangeKind,
  ChangedPathFact,
  FileKind,
  RawChangedPath,
} from './change-surface.types';
import { resolveSessionRepoRoots } from './changed-paths.sql';
import { classifyFileKind, fileExtension } from './file-kind';
import { normaliseChangedPath, truncateChangedPath } from './path-normalise';

/**
 * Rows per `INSERT`. A single statement carries 18 parameters per row and Postgres caps a
 * statement at 65,535 of them, so a 5,000-path session would blow the limit as one insert.
 * 500 rows = 9,000 parameters, comfortably inside it, and still one round trip per 500 paths
 * rather than per path.
 */
const INSERT_CHUNK_ROWS = 500;

/**
 * Turns the extractor's raw per-`file_path` facts into stored rows: normalise against the
 * session's candidate repo roots, then **aggregate by `path_key`**.
 *
 * The aggregation is not an optimisation. `path_key` is the row identity, so two spellings of
 * one logical file (`D:\a\repo\src\X.ts` and `/home/u/repo/src/x.ts`) must become one row —
 * inserting both would violate the unique index and, worse, double-count their lines, which
 * breaks the `sum(leaf +) === root +` identity.
 */
export function buildChangedPathFacts(
  rawPaths: readonly RawChangedPath[],
  candidateRoots: readonly (string | null | undefined)[],
): ChangedPathFact[] {
  const byPathKey = new Map<string, ChangedPathFact>();

  for (const raw of rawPaths) {
    const normalised = normaliseChangedPath(raw.rawPath, candidateRoots);
    const existing = byPathKey.get(normalised.pathKey);

    if (existing !== undefined) {
      existing.editCalls += raw.editCalls;
      existing.diffCoveredCalls += raw.diffCoveredCalls;
      existing.linesAdded += raw.linesAdded;
      existing.linesRemoved += raw.linesRemoved;
      // `added` wins: the file was created somewhere in this session, whatever any later
      // call did to it.
      if (raw.createdByAnyCall) existing.changeKind = 'added';
      continue;
    }

    const fileKind: FileKind | null = classifyFileKind(normalised.relPath);
    const changeKind: ChangeKind = raw.createdByAnyCall ? 'added' : 'modified';

    byPathKey.set(normalised.pathKey, {
      pathKey: normalised.pathKey,
      // `raw_path` keeps the FIRST raw spelling seen for this key, verbatim, so
      // re-normalisation never needs the transcript again.
      rawPath: truncateChangedPath(raw.rawPath),
      relPath: normalised.relPath,
      relPathKey: normalised.relPathKey,
      folder: normalised.folder,
      folderKey: normalised.folderKey,
      topModuleKey: normalised.topModuleKey,
      depth: normalised.depth,
      fileKind,
      // Derived from the repo-relative path, so it is `null` for exactly the rows whose
      // `fileKind` is `null` — a guessed extension for an unresolvable path would be
      // indistinguishable from a real one on the display-only extension axis.
      extension:
        normalised.relPath === null ? null : fileExtension(normalised.relPath),
      outsideRepo: normalised.outsideRepo,
      changeKind,
      editCalls: raw.editCalls,
      diffCoveredCalls: raw.diffCoveredCalls,
      linesAdded: raw.linesAdded,
      linesRemoved: raw.linesRemoved,
    });
  }

  return [...byPathKey.values()];
}

/**
 * The three `session_stats.cs_*` counters plus the `cs_computed_at` marker for one node.
 *
 * `computedAt` is set whenever the extractor ran, **including when it found zero changed
 * paths** — the counters are then `0`, not `NULL`, which is what separates a genuine
 * zero-change session (renders `0 files · 0 folders`) from a never-recomputed one (renders
 * "no data"). The single exception is the unknown-repo-root state:
 * nothing could be normalised there, so every count would be a lie and the marker stays
 * `NULL`.
 */
function countersFor(
  facts: readonly ChangedPathFact[],
  repoRootKnown: boolean,
): SessionChangeSurfaceCounters {
  if (!repoRootKnown) {
    return {
      changedFiles: null,
      foldersTouched: null,
      outsideRepoFiles: null,
      computedAt: null,
    };
  }

  const folders = new Set<string>();
  let changedFiles = 0;
  let outsideRepoFiles = 0;
  for (const fact of facts) {
    if (fact.outsideRepo || fact.relPathKey === null) {
      outsideRepoFiles += 1;
      continue;
    }
    changedFiles += 1;
    folders.add(fact.folderKey ?? '.');
  }

  return {
    changedFiles,
    foldersTouched: folders.size,
    outsideRepoFiles,
    computedAt: new Date(),
  };
}

/** At least one usable candidate root — the whole of "the repo root is known". */
function hasKnownRoot(
  candidateRoots: readonly (string | null | undefined)[],
): boolean {
  return candidateRoots.some(
    (root) => typeof root === 'string' && root.trim() !== '',
  );
}

/** Deletes a node's rows and inserts the given facts, chunked. */
async function replaceRows(
  db: DrizzleDb,
  sessionRowId: number,
  facts: readonly ChangedPathFact[],
): Promise<void> {
  // Delete-then-insert rather than an upsert, mirroring `session-tool-stats-writer.ts`: the
  // set of paths a session touched can *shrink* when a longer body replaces a shorter one or
  // an extractor fix is recomputed, and an upsert would leave the stale rows behind. Every
  // caller runs inside the upload/recompute transaction, so the gap is never observable.
  await db
    .delete(sessionChangedPaths)
    .where(eq(sessionChangedPaths.sessionId, sessionRowId));

  for (let i = 0; i < facts.length; i += INSERT_CHUNK_ROWS) {
    await db.insert(sessionChangedPaths).values(
      facts.slice(i, i + INSERT_CHUNK_ROWS).map((fact) => ({
        sessionId: sessionRowId,
        pathKey: fact.pathKey,
        rawPath: fact.rawPath,
        relPath: fact.relPath,
        relPathKey: fact.relPathKey,
        folder: fact.folder,
        folderKey: fact.folderKey,
        topModuleKey: fact.topModuleKey,
        depth: fact.depth,
        fileKind: fact.fileKind,
        extension: fact.extension,
        outsideRepo: fact.outsideRepo,
        changeKind: fact.changeKind,
        editCalls: fact.editCalls,
        diffCoveredCalls: fact.diffCoveredCalls,
        linesAdded: fact.linesAdded,
        linesRemoved: fact.linesRemoved,
      })),
    );
  }
}

/**
 * Replaces one session node's changed-path rows and its `cs_*` aggregates.
 *
 * `candidateRoots` is what {@link resolveSessionRepoRoots} returned for the node (empty when
 * no `artisyn` log has arrived yet, or it came from a hook that does not upload the root).
 * The rows are stored either way — `raw_path` is verbatim — so the later
 * {@link renormaliseSessionChangedPaths} can fill in every normalised column without the
 * transcript.
 */
export async function upsertSessionChangedPaths(
  db: DrizzleDb,
  sessionRowId: number,
  rawPaths: readonly RawChangedPath[],
  candidateRoots: readonly (string | null | undefined)[],
): Promise<SessionChangeSurfaceCounters> {
  const repoRootKnown = hasKnownRoot(candidateRoots);
  const facts = buildChangedPathFacts(rawPaths, candidateRoots);

  await replaceRows(db, sessionRowId, facts);

  const counters = countersFor(facts, repoRootKnown);
  await upsertSessionChangeSurfaceCounters(db, sessionRowId, counters);
  return counters;
}

/** The stored columns re-normalisation needs — everything except the normalised ones. */
interface StoredRawRow {
  sessionId: number;
  rawPath: string;
  changeKind: string;
  editCalls: number;
  diffCoveredCalls: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Re-normalises a whole session tree from its stored `raw_path` values.
 *
 * Called from the `artisyn` ingest branch, right after `logs.git_repo_root` is written: the
 * agent transcripts and the artisyn log are separate uploads in either order, and a
 * `claude-subagent` session never has an artisyn log of its own, so at changed-path write
 * time the root is routinely still unknown. This pass is the one that heals that.
 *
 * Nodes with no rows are re-marked too, not skipped: a session that genuinely changed
 * nothing must flip from "no data" (`cs_computed_at IS NULL`, root unknown) to a real
 * `0 files · 0 folders` once the root is known. "The extractor ran for
 * this node" is defined as "the node has a `claude`/`claude-subagent` log", which is exactly
 * the condition under which {@link upsertSessionChangedPaths} was called for it.
 */
export async function renormaliseSessionChangedPaths(
  db: DrizzleDb,
  rootSessionRowId: number,
): Promise<void> {
  const descendantsByRoot = await getDescendantSessionIds(db, [
    rootSessionRowId,
  ]);
  const treeIds = [
    ...new Set([
      rootSessionRowId,
      ...(descendantsByRoot.get(rootSessionRowId) ?? []),
    ]),
  ];

  // One resolution for the whole tree: the walk starts at the node and climbs to the root's
  // `artisyn` log, so every node in this tree resolves to the same candidate roots anyway.
  const candidateRoots = await resolveSessionRepoRoots(db, rootSessionRowId);
  const repoRootKnown = hasKnownRoot(candidateRoots);

  const storedRows = (await db
    .select({
      sessionId: sessionChangedPaths.sessionId,
      rawPath: sessionChangedPaths.rawPath,
      changeKind: sessionChangedPaths.changeKind,
      editCalls: sessionChangedPaths.editCalls,
      diffCoveredCalls: sessionChangedPaths.diffCoveredCalls,
      linesAdded: sessionChangedPaths.linesAdded,
      linesRemoved: sessionChangedPaths.linesRemoved,
    })
    .from(sessionChangedPaths)
    .where(inArray(sessionChangedPaths.sessionId, treeIds))) as StoredRawRow[];

  const extractedNodes = await db
    .selectDistinct({ sessionId: logs.sessionId })
    .from(logs)
    .where(
      and(
        inArray(logs.sessionId, treeIds),
        inArray(logs.logType, ['claude', 'claude-subagent']),
      ),
    );

  const rawBySession = new Map<number, RawChangedPath[]>();
  for (const row of storedRows) {
    const list = rawBySession.get(row.sessionId) ?? [];
    list.push({
      rawPath: row.rawPath,
      editCalls: row.editCalls,
      diffCoveredCalls: row.diffCoveredCalls,
      linesAdded: row.linesAdded,
      linesRemoved: row.linesRemoved,
      createdByAnyCall: row.changeKind === 'added',
    });
    rawBySession.set(row.sessionId, list);
  }

  const nodeIds = new Set<number>([
    ...rawBySession.keys(),
    ...extractedNodes.map((row) => row.sessionId),
  ]);

  for (const sessionRowId of nodeIds) {
    const facts = buildChangedPathFacts(
      rawBySession.get(sessionRowId) ?? [],
      candidateRoots,
    );
    await replaceRows(db, sessionRowId, facts);
    await upsertSessionChangeSurfaceCounters(
      db,
      sessionRowId,
      countersFor(facts, repoRootKnown),
    );
  }
}
