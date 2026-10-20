/**
 * Change surface — the one-session read side.
 *
 * Two reads, deliberately split into two methods behind two routes:
 * the *aggregate* is needed by the Summary tab (tile + detectors) every time a session is
 * opened, while the per-path rows are only needed once the Change surface tab is actually
 * opened. Merging them into one payload would make every session open pay for a file list
 * nobody looked at.
 *
 * Both are **tree-scoped** — the session plus its whole sub-agent subtree — and
 * neither aggregates in SQL: the rows are loaded by `loadScopedChangedPaths()` and folded by
 * the single shared `computeChangeSurface()`, which is what keeps this surface in agreement
 * with the report and the chart by construction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import * as schema from '../../database/schema/index';
import { computeChangeSurface } from './change-surface-metrics';
import type {
  ChangeSurfaceAggregate,
  ChangeSurfaceFileRow,
  ChangedPathFact,
} from './change-surface.types';
import {
  loadScopeComputedFlags,
  loadScopedChangedPaths,
} from './changed-paths.sql';

/**
 * The access narrowing the controller has already resolved.
 *
 * `visibleUserIds` mirrors `getSessionContexts`' `ownerCondition`: the `logs.user_id`
 * values the caller's team access mode lets them see — `[caller]` for a plain member of a
 * `restricted` team, the acknowledged members for its owner/manager/trainer. `null` means
 * "emit no user predicate at all" (the personal view, or a `transparent` team), which is
 * the exact SQL this service ran before access modes existed.
 *
 * It is a second layer only: the controller has already 403'd a session outside the scope
 * via `RepositoriesService.assertSessionVisible`.
 */
export interface ChangeSurfaceSessionScope {
  visibleUserIds: number[] | null;
}

@Injectable()
export class ChangeSurfaceService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * One session tree's change surface.
   *
   * An unknown / inaccessible session and a never-recomputed one deliberately return the
   * *same* shape — a `computed: false` aggregate. Every client surface renders that as
   * "no data", which is both the honest answer for a session whose
   * extractor never ran and a non-answer for a session the caller may not see. A `0` here
   * would be a lie in every one of those cases.
   */
  async getSessionAggregate(
    repoIds: number[],
    sessionId: string,
    scope: ChangeSurfaceSessionScope,
  ): Promise<ChangeSurfaceAggregate> {
    const sessionRowId = await this.resolveSessionRowId(
      repoIds,
      sessionId,
      scope,
    );
    if (sessionRowId === null) return notComputedAggregate();

    const [computedFlags, scoped] = await Promise.all([
      loadScopeComputedFlags(this.db, [sessionRowId]),
      loadScopedChangedPaths(this.db, { rootSessionIds: [sessionRowId] }),
    ]);

    return computeChangeSurface(scoped.facts, {
      computed: computedFlags.get(sessionRowId) === true,
    });
  }

  /**
   * One session tree's per-path rows, one row per *logical* file.
   *
   * The stored rows are per session, so a file that the root and a sub-agent both edited
   * arrives twice; they are folded here on the same key `computeChangeSurface()` folds on
   * (`relPathKey`, falling back to `pathKey` for rows that never normalised). Without that
   * fold the tree would list one file twice and its leaf `+`/`-` would no longer sum to the
   * tile's totals, which is exactly the `sum(leaf +) === root +` identity.
   *
   * Out-of-repo rows are **included and flagged**, never dropped: the tab shows them under
   * its own "Outside repo / unnormalised" node so a session that spent its edits in
   * `~/.claude/` is visibly explained rather than silently empty.
   *
   * Returns the full list; `CHANGE_SURFACE_MAX_FILE_ROWS` is applied by the route, which is
   * also what reports `total`/`truncated` to the client.
   */
  async getSessionFiles(
    repoIds: number[],
    sessionId: string,
    scope: ChangeSurfaceSessionScope,
  ): Promise<ChangeSurfaceFileRow[]> {
    const sessionRowId = await this.resolveSessionRowId(
      repoIds,
      sessionId,
      scope,
    );
    if (sessionRowId === null) return [];

    const scoped = await loadScopedChangedPaths(this.db, {
      rootSessionIds: [sessionRowId],
    });
    return mergeFileRows(scoped.facts);
  }

  /**
   * `sessions.id` for a session the caller may see through `repoIds`, or `null`.
   *
   * The log-type is deliberately *not* pinned to `artisyn` the way `getSessionContexts`
   * pins it: a `claude-subagent` session has no artisyn log of its own, and both session
   * routes must still answer for one when it is opened directly.
   */
  private async resolveSessionRowId(
    repoIds: number[],
    sessionId: string,
    scope: ChangeSurfaceSessionScope,
  ): Promise<number | null> {
    if (repoIds.length === 0) return null;

    const repoCondition =
      repoIds.length === 1
        ? eq(schema.logRepositories.repoId, repoIds[0])
        : inArray(schema.logRepositories.repoId, repoIds);
    const ownerCondition =
      scope.visibleUserIds === null
        ? undefined
        : inArray(schema.logs.userId, scope.visibleUserIds);

    const rows = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .innerJoin(schema.logs, eq(schema.logs.sessionId, schema.sessions.id))
      .innerJoin(
        schema.logRepositories,
        eq(schema.logRepositories.logId, schema.logs.id),
      )
      .where(
        and(
          eq(schema.sessions.sessionId, sessionId),
          eq(schema.sessions.deleted, false),
          repoCondition,
          ownerCondition,
        ),
      )
      .limit(1);

    return rows[0]?.id ?? null;
  }
}

/** The "nothing to show" aggregate — `computed: false`, so every surface renders no data. */
function notComputedAggregate(): ChangeSurfaceAggregate {
  return computeChangeSurface([], { computed: false });
}

/**
 * Fold per-session path rows into one row per logical file.
 *
 * Counts add (the file really was edited in both sessions) while the file itself is listed
 * once, and `added` wins over `modified` — the same asymmetry and the same precedence
 * `mergeInRepoFiles()` applies inside `computeChangeSurface()`.
 */
export function mergeFileRows(
  facts: readonly ChangedPathFact[],
): ChangeSurfaceFileRow[] {
  const merged = new Map<string, ChangeSurfaceFileRow>();

  for (const fact of facts) {
    // In-repo rows fold on the case-folded relative path — the same distinctness key the
    // metric uses. A row that never normalised has no such key, so it keeps its own
    // `pathKey` identity, namespaced so it can never collide with a real relative path.
    const key =
      fact.relPathKey !== null && !fact.outsideRepo
        ? `rel:${fact.relPathKey}`
        : `raw:${fact.pathKey}`;

    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        rawPath: fact.rawPath,
        relPath: fact.relPath,
        folder: fact.folder,
        fileKind: fact.fileKind,
        extension: fact.extension,
        changeKind: fact.changeKind,
        editCalls: fact.editCalls,
        diffCoveredCalls: fact.diffCoveredCalls,
        linesAdded: fact.linesAdded,
        linesRemoved: fact.linesRemoved,
        outsideRepo: fact.outsideRepo,
      });
      continue;
    }

    existing.editCalls += fact.editCalls;
    existing.diffCoveredCalls += fact.diffCoveredCalls;
    existing.linesAdded += fact.linesAdded;
    existing.linesRemoved += fact.linesRemoved;
    if (fact.changeKind === 'added') existing.changeKind = 'added';
    else if (fact.changeKind === 'deleted' && existing.changeKind !== 'added') {
      existing.changeKind = 'deleted';
    }
  }

  // In-repo rows first, each block alphabetical: the tab builds its tree from this order
  // and the out-of-repo node belongs at the end, after the repo's own tree.
  return [...merged.values()].sort((a, b) => {
    if (a.outsideRepo !== b.outsideRepo) return a.outsideRepo ? 1 : -1;
    const left = (a.relPath ?? a.rawPath).toLowerCase();
    const right = (b.relPath ?? b.rawPath).toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
