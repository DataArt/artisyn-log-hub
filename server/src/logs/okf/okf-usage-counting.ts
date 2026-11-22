/**
 * OKF usage — every counting rule of the OKF tab (repo and session route), as one pure function
 * over already loaded rows. No DB, no I/O. Rules: `docs/knowledgebase/algorithms/okf-usage-counting.md`.
 *
 * - A read row is a `read` / `grep` row whose path has no glob character and lies in a bundle of
 *   the reference snapshot (deepest bundle; dot-paths under a root are not KB).
 * - `reads` = Σ `calls`, `tokens` = Σ `bytes` / {@link OKF_BYTES_PER_TOKEN} (not rounded).
 * - KB cost per node = `min(1, kbTokens / ctxTokens) × ctxCost`, spread over the node's read rows
 *   by tokens; file, folder-search and summary costs are sums of row costs.
 */
import { OKF_BYTES_PER_TOKEN, OKF_DEFAULT_BRANCH_NAMES } from './okf-constants';
import {
  articleMetaFlags,
  hasHookMeta,
  OKF_CURRENT_FORMAT_VERSION,
  okfVersionHint,
} from './okf-metadata';
import {
  bundleArticles,
  bundleOfPath,
  isFolderKey,
  isReservedOkfName,
  rootFolderKey,
  rootPrefix,
  type OkfUsageRow,
} from './okf-paths';
import type { OkfSnapshotBundle } from './okf-snapshot';
import type {
  OkfFormatProblem,
  OkfUsageFile,
  OkfUsageFolder,
  OkfUsageFormat,
  OkfUsageResponse,
  OkfUsageUnit,
  OkfUsageVersionRow,
} from './okf-usage.types';

export interface OkfCountingNode {
  /** Root session id (repo route) or node id (session route). */
  unit: number;
  rows: OkfUsageRow[];
  ctxTokens: number;
  /** null = the node has no computed cost. */
  ctxCost: number | null;
}

export interface OkfCountingInput {
  unit: OkfUsageUnit;
  /** Reference snapshot bundles after the team filter; null = no snapshot. */
  bundles: OkfSnapshotBundle[] | null;
  snapshot: { branch: string | null; takenAt: string } | null;
  /** Root of the bundle filter; undefined / unknown = all. */
  bundle?: string;
  nodes: OkfCountingNode[];
  unitsTotal: number;
  spend: number | null;
  refMs: number;
  /**
   * Team view (`bundles` are the team-filtered ones): a `supersededBy` whose target is not a
   * listed file is left out, so a hidden path never leaks.
   */
  teamView?: boolean;
}

/** Older extractor versions stored glob paths as path keys; such a row is not a read of a file. */
const GLOB_CHARS_RE = /[*?[\]{}]/;

/** Wrong-format groups in their fixed display order. */
const FORMAT_PROBLEM_ORDER: readonly OkfFormatProblem[] = [
  'no_front_matter',
  'no_type',
  'v01_timestamp',
  'deprecated',
  'past_stale_after',
];

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function startMs(startTime: string): number {
  const ms = Date.parse(startTime);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function newest<R extends { startTime: string }>(
  roots: readonly R[],
): R | null {
  let best: R | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const r of roots) {
    const ms = startMs(r.startTime);
    if (best === null || ms > bestMs) {
      best = r;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * The root whose snapshot the repo view is measured against: the newest (`startTime`) root on a
 * branch of {@link OKF_DEFAULT_BRANCH_NAMES}; when there is none, the newest of all; `null` for
 * an empty list. `roots` holds only roots that have a stored snapshot.
 */
export function pickReferenceRoot<
  R extends { startTime: string; branch: string | null },
>(roots: readonly R[]): R | null {
  const onDefault = roots.filter(
    (r) => r.branch !== null && OKF_DEFAULT_BRANCH_NAMES.includes(r.branch),
  );
  return newest(onDefault.length > 0 ? onDefault : roots);
}

/** Running totals of the read rows of one file / one folder search / the whole view. */
interface Agg {
  units: Set<number>;
  rows: number;
  pricedRows: number;
  reads: number;
  tokens: number;
  cost: number;
}

function newAgg(): Agg {
  return {
    units: new Set<number>(),
    rows: 0,
    pricedRows: 0,
    reads: 0,
    tokens: 0,
    cost: 0,
  };
}

function addToAgg(
  agg: Agg,
  unit: number,
  reads: number,
  tokens: number,
  cost: number | null,
): void {
  agg.units.add(unit);
  agg.rows += 1;
  agg.reads += reads;
  agg.tokens += tokens;
  if (cost !== null) {
    agg.pricedRows += 1;
    agg.cost += cost;
  }
}

/** `null` only when there are reads and none of them has a cost; `0` without reads. */
function aggCost(agg: Agg): number | null {
  return agg.rows > 0 && agg.pricedRows === 0 ? null : agg.cost;
}

/** The parent folder key of a file / folder key (`a/b/c.md` → `a/b/`, `a/` → `''`). */
function parentFolder(pathKey: string): string {
  const trimmed = pathKey.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx < 0 ? '' : trimmed.slice(0, idx + 1);
}

/**
 * Folder keys from the path's own folder up to the bundle root, root included. A file key starts
 * at its parent folder, a folder key at itself.
 */
function foldersUpToRoot(pathKey: string, root: string): string[] {
  const prefix = rootPrefix(root);
  const out: string[] = [];
  let cur = isFolderKey(pathKey)
    ? pathKey === '/'
      ? ''
      : pathKey
    : parentFolder(pathKey);
  while (cur !== '' && cur.length > prefix.length && cur.startsWith(prefix)) {
    out.push(cur);
    cur = parentFolder(cur);
  }
  out.push(rootFolderKey(root));
  return out;
}

function isReadRow(row: OkfUsageRow): boolean {
  return (
    (row.op === 'read' || row.op === 'grep') && !GLOB_CHARS_RE.test(row.pathKey)
  );
}

function emptyView(input: OkfCountingInput): OkfUsageResponse {
  return {
    unit: input.unit,
    snapshot: null,
    bundleRoots: [],
    currentFormat: OKF_CURRENT_FORMAT_VERSION,
    summary: {
      unitsRead: 0,
      unitsTotal: 0,
      reads: 0,
      tokens: 0,
      cost: null,
      readsWithoutCost: 0,
      spend: null,
    },
    versions: [],
    format: null,
    files: [],
    folders: [],
    notInSnapshotUnits: 0,
  };
}

function buildVersions(
  bundles: readonly OkfSnapshotBundle[],
): OkfUsageVersionRow[] {
  return bundles
    .map((b) => ({
      root: b.root,
      files: b.files.length,
      okfVersion: b.okfVersion ?? null,
      older: okfVersionHint(b.okfVersion),
      ignored: b.ignored,
    }))
    .sort((a, b) => byCodeUnit(a.root, b.root));
}

/**
 * `visible` (team view): the listed files of the whole team-filtered snapshot — a
 * `supersededBy` outside it is not shown. `null` = personal view, every target is shown.
 */
function buildFormat(
  bundles: readonly OkfSnapshotBundle[],
  refMs: number,
  visible: ReadonlySet<string> | null,
): OkfUsageFormat {
  const groups = new Map<
    OkfFormatProblem,
    { path: string; supersededBy?: string }[]
  >();
  const add = (
    problem: OkfFormatProblem,
    file: { path: string; supersededBy?: string },
  ): void => {
    const list = groups.get(problem);
    if (list === undefined) groups.set(problem, [file]);
    else list.push(file);
  };
  let articles = 0;
  let files = 0;
  let withProblems = 0;
  for (const bundle of bundles) {
    files += bundle.files.length;
    for (const file of bundleArticles(bundle)) {
      articles += 1;
      const flags = articleMetaFlags(file, bundle, refMs);
      for (const hint of flags.formatHints) add(hint, { path: file.path });
      if (flags.deprecated) {
        add(
          'deprecated',
          flags.supersededBy === null ||
            (visible !== null && !visible.has(flags.supersededBy))
            ? { path: file.path }
            : { path: file.path, supersededBy: flags.supersededBy },
        );
      }
      if (flags.pastStaleAfter) add('past_stale_after', { path: file.path });
      if (
        flags.formatHints.length > 0 ||
        flags.deprecated ||
        flags.pastStaleAfter
      ) {
        withProblems += 1;
      }
    }
  }
  return {
    articles,
    indexFiles: files - articles,
    withProblems,
    groups: FORMAT_PROBLEM_ORDER.flatMap((problem) => {
      const list = groups.get(problem);
      if (list === undefined) return [];
      return [
        {
          problem,
          files: list.sort((a, b) => byCodeUnit(a.path, b.path)),
        },
      ];
    }),
  };
}

interface FileEntry {
  bundle: string;
  inSnapshot: boolean;
  agg: Agg;
}

interface FolderEntry {
  bundle: string;
  /** Listed in the response: a bundle root, a folder with a snapshot file, or a searched one. */
  listed: boolean;
  units: Set<number>;
  search: Agg | null;
}

/** The OKF tab response of one scope: summary, versions, format, files and folders. */
export function buildOkfUsageView(input: OkfCountingInput): OkfUsageResponse {
  const all = input.bundles;
  if (all === null || input.snapshot === null) return emptyView(input);

  const selected =
    input.bundle === undefined
      ? undefined
      : all.find((b) => b.root === input.bundle);
  const shown = selected === undefined ? all : [selected];
  const isShown = (b: OkfSnapshotBundle): boolean =>
    selected === undefined || b === selected;

  // Snapshot files, each under the deepest bundle above it.
  const files = new Map<string, FileEntry>();
  const folders = new Map<string, FolderEntry>();
  const folderOf = (key: string, bundle: string): FolderEntry => {
    let entry = folders.get(key);
    if (entry === undefined) {
      entry = { bundle, listed: false, units: new Set<number>(), search: null };
      folders.set(key, entry);
    }
    return entry;
  };
  for (const b of shown) folderOf(rootFolderKey(b.root), b.root).listed = true;
  for (const listing of shown) {
    for (const f of listing.files) {
      if (files.has(f.path)) continue;
      const owner = bundleOfPath(f.path, all) ?? listing;
      if (!isShown(owner)) continue;
      files.set(f.path, {
        bundle: owner.root,
        inSnapshot: true,
        agg: newAgg(),
      });
      for (const key of foldersUpToRoot(f.path, owner.root)) {
        folderOf(key, owner.root).listed = true;
      }
    }
  }

  const summary = newAgg();
  const notInSnapshot = new Set<number>();
  let readsWithoutCost = 0;

  for (const node of input.nodes) {
    // The node's KB rows over every bundle: the cost share does not depend on the bundle filter.
    const kbRows: { row: OkfUsageRow; owner: OkfSnapshotBundle }[] = [];
    let kbTokens = 0;
    for (const row of node.rows) {
      if (!isReadRow(row)) continue;
      const owner = bundleOfPath(row.pathKey, all);
      if (owner === null) continue;
      kbRows.push({ row, owner });
      kbTokens += row.bytes / OKF_BYTES_PER_TOKEN;
    }
    const priced = node.ctxCost !== null && node.ctxTokens > 0;
    const nodeCost =
      node.ctxCost !== null && node.ctxTokens > 0
        ? Math.min(1, kbTokens / node.ctxTokens) * node.ctxCost
        : null;

    for (const { row, owner } of kbRows) {
      if (!isShown(owner)) continue;
      const tokens = row.bytes / OKF_BYTES_PER_TOKEN;
      const cost =
        nodeCost === null
          ? null
          : kbTokens > 0
            ? (nodeCost * tokens) / kbTokens
            : 0;
      if (!priced) readsWithoutCost += row.calls;
      addToAgg(summary, node.unit, row.calls, tokens, cost);

      if (isFolderKey(row.pathKey)) {
        const chain = foldersUpToRoot(row.pathKey, owner.root);
        const own = folderOf(chain[0], owner.root);
        own.listed = true;
        own.search ??= newAgg();
        addToAgg(own.search, node.unit, row.calls, tokens, cost);
        for (const key of chain) folderOf(key, owner.root).units.add(node.unit);
        continue;
      }

      let file = files.get(row.pathKey);
      if (file === undefined) {
        file = { bundle: owner.root, inSnapshot: false, agg: newAgg() };
        files.set(row.pathKey, file);
      }
      addToAgg(file.agg, node.unit, row.calls, tokens, cost);
      if (!file.inSnapshot) {
        notInSnapshot.add(node.unit);
        continue;
      }
      for (const key of foldersUpToRoot(row.pathKey, file.bundle)) {
        folderOf(key, file.bundle).units.add(node.unit);
      }
    }
  }

  const fileList: OkfUsageFile[] = [...files.entries()]
    .map(([path, f]) => ({
      bundle: f.bundle,
      path,
      inSnapshot: f.inSnapshot,
      index: isReservedOkfName(path),
      units: f.agg.units.size,
      reads: f.agg.reads,
      tokens: f.agg.tokens,
      cost: aggCost(f.agg),
    }))
    .sort((a, b) => byCodeUnit(a.path, b.path));

  const folderList: OkfUsageFolder[] = [...folders.entries()]
    .filter(([, f]) => f.listed)
    .map(([path, f]) => ({
      bundle: f.bundle,
      path,
      units: f.units.size,
      search:
        f.search === null
          ? null
          : {
              units: f.search.units.size,
              reads: f.search.reads,
              tokens: f.search.tokens,
              cost: aggCost(f.search),
            },
    }))
    .sort((a, b) => byCodeUnit(a.path, b.path));

  const hasMeta = all.some((b) => hasHookMeta(b));

  return {
    unit: input.unit,
    snapshot: {
      branch: input.snapshot.branch,
      takenAt: input.snapshot.takenAt,
      hasMeta,
    },
    bundleRoots: all.map((b) => b.root).sort(byCodeUnit),
    currentFormat: OKF_CURRENT_FORMAT_VERSION,
    summary: {
      unitsRead: summary.units.size,
      unitsTotal: input.unitsTotal,
      reads: summary.reads,
      tokens: summary.tokens,
      cost: aggCost(summary),
      readsWithoutCost,
      spend: input.spend,
    },
    versions: hasMeta ? buildVersions(shown) : [],
    format: hasMeta
      ? buildFormat(
          shown,
          input.refMs,
          input.teamView === true
            ? new Set(all.flatMap((b) => b.files.map((f) => f.path)))
            : null,
        )
      : null,
    files: fileList,
    folders: folderList,
    notInSnapshotUnits: notInSnapshot.size,
  };
}
