/**
 * OKF usage — pure building blocks shared by the session and the repo route of
 * `okf-usage.service.ts` (impl-plan DD-29, DD-30, DD-39, DD-40). No DB, no I/O.
 *
 * - {@link applyOkfTeamFilter}: the team fail-closed filter (DD-30), applied before the verdict
 *   and the tree on both routes.
 * - {@link buildOkfTree}: bundle → folder → file nodes from the snapshot file lists plus the
 *   accessed paths, folder rows aggregated onto folder nodes, roll-ups and markers (DD-40).
 *
 * Tree conventions (mirrored by the client):
 * - A bundle node's `path` is its root as a folder key (`docs/knowledgebase/`, a bundle at the
 *   repo root is `/`); the synthetic "No longer in KB" / "no snapshot" group has `bundle: null`
 *   and `path: ''`.
 * - `readBytes` = `read` + `grep` bytes (own-edit rows included); `readCalls` = `read` + `grep`
 *   calls; `grepCalls` / `listCalls` / `writeCalls` count their op alone. Folder and bundle nodes
 *   carry their own folder rows plus the sum of their children; `agents` is the union of the
 *   distinct units (tree nodes on the session route, root sessions on the repo route).
 * - `size` of a folder / bundle is the sum of its children's known sizes (`null` when none).
 * - 2026-11-03 value signals: upkeep contributions (FR-5) count only in `upkeepReadCalls`;
 *   `rangedCalls` (FR-4) rolls up like the call counters; the per-article signal fields
 *   (`yield`, `searchedAfter`, `routingMiss`, `deadPointers`, `catalogFiles`) and the FR-10
 *   `stale` / `removed` flags sit on file nodes only, with the DD-18 markers.
 */
import type { OkfSnapshotBody, OkfSnapshotBundle } from './okf-snapshot';
import type { OkfTreeMarker, OkfTreeNode, OkfYield } from './okf-usage.types';
import type { OkfVerdictRow } from './okf-verdict';

// ── Path helpers ───────────────────────────────────────────────────────────────────────────────

/** `true` for a folder path key (ends in `/`; the repo root is `/`). */
export function isFolderKey(pathKey: string): boolean {
  return pathKey.endsWith('/');
}

/** A bundle root as a folder-key prefix: `docs/kb` → `docs/kb/`, repo root → `''`. */
export function rootPrefix(root: string): string {
  const r = root.replace(/\/+$/, '');
  return r === '' || r === '.' ? '' : `${r}/`;
}

/** The folder key of a bundle root (`docs/kb/`, repo root `/`). */
export function rootFolderKey(root: string): string {
  const p = rootPrefix(root);
  return p === '' ? '/' : p;
}

/** True when the path key (file or folder) is inside the folder prefix (`''` = everything). */
export function isUnderPrefix(pathKey: string, prefix: string): boolean {
  if (prefix === '') return true;
  return pathKey.startsWith(prefix);
}

/** The parent folder key of a file / folder key (`a/b/c.md` → `a/b/`, `a/` → `''`). */
function parentFolder(pathKey: string): string {
  const trimmed = pathKey.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx < 0 ? '' : trimmed.slice(0, idx + 1);
}

// ── DD-30 team filter ──────────────────────────────────────────────────────────────────────────

/**
 * One root tree as the team filter sees it: its own snapshot and per-node rows. `pointers` /
 * `events` are the node's `session_okf_pointer` / `session_okf_event` rows (2026-11-03 DD-24),
 * filtered only when present.
 */
export interface OkfTeamFilterTree {
  snapshot: OkfSnapshotBody | null;
  nodes: {
    rows: OkfVerdictRow[];
    pointers?: readonly { articlePath: string }[];
    events?: readonly unknown[];
  }[];
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
 * DD-30 (FR-17), fail closed. In a team view a path is kept only when the accessing root's own
 * snapshot lists it `ignored: false` and no contributing snapshot (any tree's own, or the bundle
 * source passed in) lists it ignored; a folder row is kept only when its own snapshot lists a
 * visible file under it. A snapshot-less tree contributes nothing. Bundles flagged ignored are
 * dropped, and every ignored file leaves the remaining bundles' file lists.
 *
 * DD-24 (2026-11-03), same fail-closed rule for the new rows: a snapshot-less tree keeps no
 * pointer and no event row; a pointer row is kept only when its article is a visible file of the
 * tree's own snapshot (so an ignored article's pointers go); event rows are not filtered by
 * `ignored`.
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
        nodes: tree.nodes.map((n) => ({
          ...n,
          rows: [],
          ...(n.pointers !== undefined ? { pointers: [] } : {}),
          ...(n.events !== undefined ? { events: [] } : {}),
        })),
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
        ...(n.pointers !== undefined
          ? { pointers: n.pointers.filter((p) => visible.has(p.articlePath)) }
          : {}),
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

// ── Tree building (DD-40) ──────────────────────────────────────────────────────────────────────

/** One top-level group of the tree: a snapshot bundle, or the synthetic `bundle: null` group. */
export interface OkfTreeGroupSpec {
  /** Contribution key of this group. */
  key: string;
  bundle: string | null;
  /** Folder-key prefix of paths in the group (`''` = any path). */
  prefix: string;
  /** The group node's own `path`. */
  path: string;
  inSnapshot: boolean;
  /** Snapshot files seeded as not-yet-read nodes. */
  files: readonly { path: string; size: number }[];
}

/** One access row of one unit (tree node / root session) placed into a group. */
export interface OkfTreeContribution {
  groupKey: string;
  unit: string | number;
  row: OkfVerdictRow;
  /**
   * FR-5 (DD-15): a `read` / `grep` row of an upkeep pair (the same node wrote the article). Its
   * calls go to `upkeepReadCalls` instead of the read totals.
   */
  upkeep?: boolean;
}

/** Per-article value signals shown on a file node (DD-14, API changes). */
export interface OkfTreeArticleSignals {
  yield: OkfYield | null;
  searchedAfter: { agents: number; searches: number } | null;
  routingMiss: { agents: number; areaAgents: number } | null;
  /** The routing miss reached `routingMinAgents` (a `routing_miss` finding). */
  routingMissFinding: boolean;
  deadPointers: number;
  catalogFiles: number | null;
}

/** FR-10 per-file flags taken from the verdict findings (DD-17). */
export interface OkfTreeFileFlags {
  stale?: { size: number | null; oldSize: number | null };
  removed?: boolean;
}

export interface OkfTreeMarkerInput {
  /** File paths to mark `entry_point` (session route). */
  entryPoints?: ReadonlySet<string>;
  /** File paths to mark `coarse` (repo route). */
  coarse?: ReadonlySet<string>;
  /** File path → 1-based `hotFiles` rank (repo route). */
  hotRank?: ReadonlyMap<string, number>;
  /** Article path → value signals (DD-14). */
  articleSignals?: ReadonlyMap<string, OkfTreeArticleSignals>;
  /** File path → FR-10 stale / removed flags. */
  fileFlags?: ReadonlyMap<string, OkfTreeFileFlags>;
  /** Mark snapshot files with no non-upkeep read `not_read` (DD-18; repo route). */
  notRead?: boolean;
}

interface Stats {
  readBytes: number;
  readCalls: number;
  ownEditReadBytes: number;
  grepCalls: number;
  listCalls: number;
  writeCalls: number;
  /** FR-4: read calls with a range (included in `readCalls`). */
  rangedCalls: number;
  /** FR-5: read / grep calls of upkeep pairs (not in `readCalls`). */
  upkeepReadCalls: number;
  /** Upkeep read rows after the node's own edit (keeps the `own_edit` marker). */
  upkeepOwnEditCalls: number;
}

interface Acc {
  kind: OkfTreeNode['kind'];
  bundle: string | null;
  path: string;
  inSnapshot: boolean;
  size: number | null;
  own: Stats;
  units: Set<string | number>;
  children: Map<string, Acc>;
}

function emptyStats(): Stats {
  return {
    readBytes: 0,
    readCalls: 0,
    ownEditReadBytes: 0,
    grepCalls: 0,
    listCalls: 0,
    writeCalls: 0,
    rangedCalls: 0,
    upkeepReadCalls: 0,
    upkeepOwnEditCalls: 0,
  };
}

function addRow(stats: Stats, row: OkfVerdictRow, upkeep: boolean): void {
  switch (row.op) {
    case 'read':
    case 'grep':
      if (upkeep) {
        stats.upkeepReadCalls += row.calls;
        if (row.afterOwnEdit) stats.upkeepOwnEditCalls += row.calls;
        break;
      }
      if (row.op === 'read') stats.rangedCalls += row.rangedCalls ?? 0;
      stats.readBytes += row.bytes;
      stats.readCalls += row.calls;
      if (row.afterOwnEdit) stats.ownEditReadBytes += row.bytes;
      if (row.op === 'grep') stats.grepCalls += row.calls;
      break;
    case 'list':
      stats.listCalls += row.calls;
      break;
    case 'write':
      stats.writeCalls += row.calls;
      break;
  }
}

function newAcc(
  kind: Acc['kind'],
  bundle: string | null,
  path: string,
  inSnapshot: boolean,
  size: number | null,
): Acc {
  return {
    kind,
    bundle,
    path,
    inSnapshot,
    size,
    own: emptyStats(),
    units: new Set(),
    children: new Map(),
  };
}

/** The folder acc for `folderKey` under the group, creating the chain of parents. */
function folderAcc(group: Acc, prefix: string, folderKey: string): Acc {
  if (folderKey === prefix || folderKey === '' || folderKey === '/') {
    return group;
  }
  const parent = folderAcc(group, prefix, parentFolder(folderKey));
  let acc = parent.children.get(folderKey);
  if (acc === undefined) {
    acc = newAcc('folder', group.bundle, folderKey, false, null);
    parent.children.set(folderKey, acc);
  }
  return acc;
}

function fileAcc(
  group: Acc,
  prefix: string,
  path: string,
  inSnapshot: boolean,
  size: number | null,
): Acc {
  const parent = folderAcc(group, prefix, parentFolder(path));
  let acc = parent.children.get(path);
  if (acc === undefined) {
    acc = newAcc('file', group.bundle, path, inSnapshot, size);
    parent.children.set(path, acc);
  }
  return acc;
}

function compareNodes(a: OkfTreeNode, b: OkfTreeNode): number {
  return (
    b.readBytes - a.readBytes ||
    b.readCalls + b.listCalls - (a.readCalls + a.listCalls) ||
    a.path.localeCompare(b.path)
  );
}

function finalize(
  acc: Acc,
  markers: OkfTreeMarkerInput,
): { node: OkfTreeNode; units: Set<string | number> } {
  const stats: Stats = { ...acc.own };
  const units = new Set(acc.units);
  const children: OkfTreeNode[] = [];
  let size: number | null = acc.kind === 'file' ? acc.size : null;
  let anyChildInSnapshot = false;
  for (const child of acc.children.values()) {
    const done = finalize(child, markers);
    children.push(done.node);
    for (const u of done.units) units.add(u);
    stats.readBytes += done.node.readBytes;
    stats.readCalls += done.node.readCalls;
    stats.ownEditReadBytes += done.node.ownEditReadBytes;
    stats.grepCalls += done.node.grepCalls;
    stats.listCalls += done.node.listCalls;
    stats.writeCalls += done.node.writeCalls;
    stats.rangedCalls += done.node.rangedCalls ?? 0;
    stats.upkeepReadCalls += done.node.upkeepReadCalls ?? 0;
    if (done.node.size !== null) size = (size ?? 0) + done.node.size;
    if (done.node.inSnapshot) anyChildInSnapshot = true;
  }

  const nodeMarkers: OkfTreeMarker[] = [];
  let hotRank: number | undefined;
  const fileExtras: Partial<OkfTreeNode> = {};
  if (acc.kind === 'file') {
    if (markers.entryPoints?.has(acc.path)) nodeMarkers.push('entry_point');
    if (stats.ownEditReadBytes > 0 || stats.upkeepOwnEditCalls > 0) {
      nodeMarkers.push('own_edit');
    }
    if (markers.coarse?.has(acc.path)) nodeMarkers.push('coarse');
    hotRank = markers.hotRank?.get(acc.path);
    if (hotRank !== undefined) nodeMarkers.push('hot');
    if (stats.rangedCalls > 0) nodeMarkers.push('section');
    if (stats.upkeepReadCalls > 0) nodeMarkers.push('upkeep');

    const signals = markers.articleSignals?.get(acc.path);
    if (signals !== undefined) {
      fileExtras.yield = signals.yield;
      if (signals.searchedAfter !== null) {
        fileExtras.searchedAfter = { ...signals.searchedAfter };
      }
      if (signals.routingMiss !== null) {
        fileExtras.routingMiss = { ...signals.routingMiss };
      }
      if (signals.routingMissFinding) nodeMarkers.push('routing_miss');
      if (signals.catalogFiles !== null) {
        fileExtras.catalogFiles = signals.catalogFiles;
        nodeMarkers.push('catalog');
      }
      if (signals.deadPointers > 0) {
        fileExtras.deadPointers = signals.deadPointers;
        nodeMarkers.push('dead');
      }
    }
    const flags = markers.fileFlags?.get(acc.path);
    if (flags?.stale !== undefined) {
      fileExtras.stale = { ...flags.stale };
      nodeMarkers.push('stale');
    }
    if (flags?.removed === true) fileExtras.removed = true;
    if (markers.notRead === true && acc.inSnapshot && stats.readCalls === 0) {
      nodeMarkers.push('not_read');
    }
  } else if (acc.own.grepCalls > 0 || acc.own.listCalls > 0) {
    nodeMarkers.push('folder_scan');
  }

  const node: OkfTreeNode = {
    bundle: acc.bundle,
    path: acc.path,
    kind: acc.kind,
    inSnapshot: acc.kind === 'folder' ? anyChildInSnapshot : acc.inSnapshot,
    size,
    readBytes: stats.readBytes,
    readCalls: stats.readCalls,
    ownEditReadBytes: stats.ownEditReadBytes,
    grepCalls: stats.grepCalls,
    listCalls: stats.listCalls,
    writeCalls: stats.writeCalls,
    agents: units.size,
    markers: nodeMarkers,
    ...(hotRank !== undefined ? { hotRank } : {}),
    ...(stats.rangedCalls > 0 ? { rangedCalls: stats.rangedCalls } : {}),
    ...(stats.upkeepReadCalls > 0
      ? { upkeepReadCalls: stats.upkeepReadCalls }
      : {}),
    ...fileExtras,
    ...(acc.kind === 'file' ? {} : { children: children.sort(compareNodes) }),
  };
  return { node, units };
}

/**
 * Builds the tree (DD-40): one node per group, its snapshot files seeded as nodes, every
 * contribution added onto its file node (created with `inSnapshot: false` when the snapshot does
 * not list it) or, for a folder row, onto its folder node (the group node for the group root).
 * Contributions with an unknown group or a path outside the group's prefix are ignored. Groups
 * are returned in the given order; children sorted by read bytes, then activity, then path.
 */
export function buildOkfTree(
  groups: readonly OkfTreeGroupSpec[],
  contributions: readonly OkfTreeContribution[],
  markers: OkfTreeMarkerInput = {},
): OkfTreeNode[] {
  const accs = new Map<string, { acc: Acc; spec: OkfTreeGroupSpec }>();
  for (const spec of groups) {
    const acc = newAcc('bundle', spec.bundle, spec.path, spec.inSnapshot, null);
    for (const f of spec.files) {
      if (isUnderPrefix(f.path, spec.prefix)) {
        fileAcc(acc, spec.prefix, f.path, true, f.size);
      }
    }
    accs.set(spec.key, { acc, spec });
  }

  for (const c of contributions) {
    const group = accs.get(c.groupKey);
    if (group === undefined) continue;
    const { acc, spec } = group;
    const key = c.row.pathKey;
    let target: Acc;
    if (isFolderKey(key)) {
      if (key === spec.path || (key === '/' && spec.prefix === '')) {
        target = acc;
      } else if (isUnderPrefix(key, spec.prefix)) {
        target = folderAcc(acc, spec.prefix, key);
      } else continue;
    } else {
      if (!isUnderPrefix(key, spec.prefix)) continue;
      target = fileAcc(acc, spec.prefix, key, false, null);
    }
    addRow(target.own, c.row, c.upkeep === true);
    target.units.add(c.unit);
  }

  return [...accs.values()].map(({ acc }) => finalize(acc, markers).node);
}

/** All file nodes of a tree, depth first. */
export function treeFiles(nodes: readonly OkfTreeNode[]): OkfTreeNode[] {
  const out: OkfTreeNode[] = [];
  const walk = (n: OkfTreeNode): void => {
    if (n.kind === 'file') out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  nodes.forEach(walk);
  return out;
}
