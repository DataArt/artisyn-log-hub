/**
 * OKF usage — the team fail-closed filter, applied before counting on both routes
 * (`okf-usage-counting.ts`). Pure, no DB, no I/O.
 */
import { isFolderKey, isUnderPrefix, type OkfUsageRow } from './okf-paths';
import type { OkfSnapshotBody, OkfSnapshotBundle } from './okf-snapshot';

/** One root tree as the team filter sees it: its own snapshot and per-node rows. */
export interface OkfTeamFilterTree {
  /** The tree's own bound snapshot; null = none. */
  snapshot: OkfSnapshotBody | null;
  nodes: { rows: OkfUsageRow[] }[];
}

/** Files flagged ignored (by themselves or through their bundle's `index.md`) in any body. */
function ignoredPathsOf(
  bundleLists: readonly (readonly OkfSnapshotBundle[])[],
) {
  const ignored = new Set<string>();
  for (const bundles of bundleLists) {
    for (const b of bundles) {
      if (b.ignored) ignored.add(b.index);
      for (const f of b.files) {
        if (f.ignored || b.ignored) ignored.add(f.path);
      }
    }
  }
  return ignored;
}

/** Files of one snapshot a team viewer may see: listed, not ignored anywhere. */
function teamVisibleFiles(
  snapshot: OkfSnapshotBody,
  ignoredAnywhere: ReadonlySet<string>,
): Set<string> {
  const visible = new Set<string>();
  for (const b of snapshot.bundles) {
    if (b.ignored) continue;
    for (const f of b.files) {
      if (!f.ignored && !ignoredAnywhere.has(f.path)) visible.add(f.path);
    }
  }
  return visible;
}

/**
 * Fail closed. In a team view a path is kept only when the accessing root's own snapshot lists it
 * `ignored: false` and no contributing snapshot (any tree's own, or the reference bundles passed
 * in) lists it ignored; a folder row is kept only when its own snapshot lists a visible file under
 * it. A snapshot-less tree contributes nothing. Bundles flagged ignored are dropped, and every
 * ignored file leaves the remaining bundles' file lists.
 */
export function applyOkfTeamFilter<T extends OkfTeamFilterTree>(
  trees: readonly T[],
  bundles: readonly OkfSnapshotBundle[] | null,
): { trees: T[]; bundles: OkfSnapshotBundle[] | null } {
  const bundleLists: OkfSnapshotBundle[][] = trees
    .map((t) => t.snapshot?.bundles ?? null)
    .filter((b): b is OkfSnapshotBundle[] => b !== null);
  if (bundles !== null) bundleLists.push([...bundles]);
  const ignoredAnywhere = ignoredPathsOf(bundleLists);

  const filteredTrees = trees.map((tree) => {
    if (tree.snapshot === null) {
      return {
        ...tree,
        nodes: tree.nodes.map((n) => ({ ...n, rows: [] })),
      };
    }
    const visible = teamVisibleFiles(tree.snapshot, ignoredAnywhere);
    const visibleList = [...visible];
    const keep = (pathKey: string): boolean => {
      if (!isFolderKey(pathKey)) return visible.has(pathKey);
      const prefix = pathKey === '/' ? '' : pathKey;
      return visibleList.some((p) => isUnderPrefix(p, prefix));
    };
    return {
      ...tree,
      nodes: tree.nodes.map((n) => ({
        ...n,
        rows: n.rows.filter((r) => keep(r.pathKey)),
      })),
    };
  });

  const filteredBundles =
    bundles === null
      ? null
      : bundles
          .filter((b) => !b.ignored)
          .map((b) => ({
            ...b,
            files: b.files.filter(
              (f) => !f.ignored && !ignoredAnywhere.has(f.path),
            ),
          }));

  return { trees: filteredTrees, bundles: filteredBundles };
}
