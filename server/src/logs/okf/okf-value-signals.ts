/**
 * OKF usage — pure read-time value signals (impl-plan DD-12..DD-15 of 2026-11-03-okf-view-kb-value).
 *
 * No DB, no I/O: the read side (`okf-usage.service.ts`) loads `session_okf_pointer` /
 * `session_okf_event` rows of the view (team filter already applied, DD-24) and hands them in
 * together with the resolved thresholds. The thresholds are applied here, never at extraction.
 *
 * - **Area (DD-12)** of an article, over all-time pointer rows of the scope: the non-partial new
 *   pointers that are files under a `codeRoots` folder, minus the pointers that are new pointers
 *   of more than `pointerMaxArticles` distinct articles. Built for the article's current hash; if
 *   that hash has no reads, for the hash read most recently (`areaFromOlderVersion`). An article
 *   with no reads has no area.
 * - **FR-1 yield:** `n` = non-partial reads that showed at least one new pointer, `k` = those
 *   reads with at least one followed new pointer.
 * - **FR-2 searched after (DD-13/DD-14):** a (node, article) read pair whose node made at least
 *   `exploredMinSearches` in-area `search` events after its first read of the article. For FR-2
 *   only, a search of a folder that holds an area file also counts, when the folder is at least
 *   `OKF_SEARCH_FOLDER_MIN_DEPTH` segments deep.
 * - **FR-3 routing miss:** nodes with at least `routingMinSearches` in-area searches and no read
 *   of the article (X) of the nodes with at least one in-area search (Y); a finding when
 *   X ≥ `routingMinAgents`. Skipped for catalog articles.
 * - **FR-13 dead pointers:** an (article, pointer) pair shown as new in non-partial reads of at
 *   least `deadPointerMinShown` distinct nodes and never followed; `notFound` when no all-time
 *   event / access touched the path (or anything under it) and the latest snapshot has no such file.
 * - **FR-14 patterns:** top `OKF_TOP_PATTERNS` by count, ties by pattern ascending, never masked.
 * - **FR-15 catalog:** an area of more than `areaMaxFiles` files → an `info` finding.
 *
 * Every per-node signal ignores upkeep pairs (DD-15: the node also wrote the article) and is
 * computed over the period rows only; the area alone uses the all-time rows.
 *
 * Findings carry the DD-26 params (`file`, `patterns`, `area`, `files`, `path`) plus counts.
 */
import { OKF_SEARCH_FOLDER_MIN_DEPTH, OKF_TOP_PATTERNS } from './okf-constants';
import type { ResolvedOkfThresholds } from './okf-thresholds';
import type { OkfFinding, OkfYield } from './okf-usage.types';

// ── Inputs ─────────────────────────────────────────────────────────────────────────────────────

/** Tree-node identity (a `sessions.id` or `sessions.session_id`); the caller keeps it consistent. */
export type OkfNodeId = string | number;

/** The value-signal group of the thresholds (DD-19). */
export type OkfValueSignalThresholds = Pick<
  ResolvedOkfThresholds,
  | 'exploredMinSearches'
  | 'routingMinSearches'
  | 'routingMinAgents'
  | 'pointerMaxArticles'
  | 'areaMaxFiles'
  | 'deadPointerMinShown'
  | 'codeRoots'
>;

/** One period `session_okf_pointer` row (DD-1a) with its node. */
export interface OkfSignalPointerRow {
  nodeId: OkfNodeId;
  articlePath: string;
  articleHash: string | null;
  readOrd: number;
  /** `''` = a partial read with no pointers. */
  pointer: string;
  isNew: boolean;
  followed: boolean;
  partial: boolean;
}

/**
 * One all-time pointer aggregate (DD-28: `GROUP BY article_path, article_hash, pointer`, plus the
 * `is_new` / `partial` flags). Any row of a (path, hash) means that version had reads.
 */
export interface OkfSignalAllTimePointerRow {
  articlePath: string;
  articleHash: string | null;
  /** `''` = a partial read with no pointers. */
  pointer: string;
  isNew: boolean;
  partial: boolean;
  /** Latest start time (ms) of a session with this row; picks the older-hash fallback (DD-12). */
  lastReadAt: number | null;
}

/** One period `session_okf_event` row (DD-1a) with its node. */
export interface OkfSignalEventRow {
  nodeId: OkfNodeId;
  ord: number;
  op: 'read' | 'search' | 'write';
  /** Repo-relative; folders end in `/`, the repo root is `/`. */
  path: string;
  pattern: string | null;
}

/** A node read a KB article in the period (a `read` access row of a stored `.md` key). */
export interface OkfSignalNodeRead {
  nodeId: OkfNodeId;
  articlePath: string;
  /**
   * Ordinal of the node's first non-partial read of the article, when the caller knows it.
   * Otherwise the minimum `readOrd` of the pair's non-partial pointer rows is used; with neither,
   * the pair is left out of FR-2 (its first-read position is unknown).
   */
  firstReadOrd?: number | null;
}

/** A (node, article) upkeep pair (DD-15): the node has a `write` row for the article. */
export interface OkfSignalUpkeepPair {
  nodeId: OkfNodeId;
  articlePath: string;
}

export interface OkfValueSignalsInput {
  /** Period pointer rows of the view's trees. */
  pointers: readonly OkfSignalPointerRow[];
  /** All-time (period-free, same scope) pointer aggregates — the area only (DD-12). */
  allTimePointers: readonly OkfSignalAllTimePointerRow[];
  /** Period code events of the view's trees. */
  events: readonly OkfSignalEventRow[];
  /** All-time touched paths (events and access keys; folders end in `/`) — FR-13 `notFound`. */
  allTimeTouchedPaths: ReadonlySet<string> | readonly string[];
  /** Period KB article reads per node. */
  reads: readonly OkfSignalNodeRead[];
  /** Period upkeep pairs. */
  upkeep: readonly OkfSignalUpkeepPair[];
  /**
   * Files of the latest snapshot (path → hash / size); gives the current hash (DD-12) and the
   * "file of the latest snapshot" test of FR-13. Absent = no snapshot, no older-version flag.
   */
  latestFiles?: ReadonlyMap<
    string,
    { hash: string | null; size: number | null }
  >;
  thresholds: OkfValueSignalThresholds;
  /** Bundle root of an article for `OkfFinding.node.bundle`; absent → `null`. */
  bundleOf?: (articlePath: string) => string | null;
}

// ── Outputs ────────────────────────────────────────────────────────────────────────────────────

export interface OkfPatternCount {
  pattern: string;
  count: number;
}

export interface OkfArticleArea {
  /** Area files, sorted. Empty when the article has no reads or no qualifying pointer. */
  files: string[];
  /** The hash the area was built for; `null` also when the article has no reads. */
  hash: string | null;
  /** True when the current hash had no reads and an older version's pointers were used. */
  areaFromOlderVersion: boolean;
  /** Whether any all-time read of the article exists (else there is no area). */
  hasReads: boolean;
}

export interface OkfArticlePointerSignal {
  pointer: string;
  /** Distinct non-upkeep nodes that saw the pointer as new in a non-partial read. */
  shown: number;
  /** Distinct of those nodes that followed it. */
  followed: number;
  dead: boolean;
  /** Only computed for dead pointers; `false` otherwise. */
  notFound: boolean;
}

export interface OkfArticleSignals {
  path: string;
  area: OkfArticleArea;
  /** FR-1; `null` when no non-partial read showed a new pointer. */
  yield: OkfYield | null;
  /** Period reads of the article by non-upkeep nodes. */
  reads: { nonPartial: number; partial: number };
  /** FR-2; `null` when no pair reached `exploredMinSearches`. */
  searchedAfter: {
    agents: number;
    searches: number;
    patterns: OkfPatternCount[];
    pairs: { nodeId: OkfNodeId; searches: number }[];
  } | null;
  /** FR-3; `null` for a catalog article, an article with no area or no node searching the area. */
  routingMiss: {
    /** X: nodes with ≥ `routingMinSearches` in-area searches and no read of the article. */
    agents: number;
    /** Y: nodes with ≥ 1 in-area search. */
    areaAgents: number;
    patterns: OkfPatternCount[];
    missing: { nodeId: OkfNodeId; searches: number; patterns: string[] }[];
  } | null;
  /** FR-13 per pointer: dead first, then `shown` desc, then pointer asc. */
  pointers: OkfArticlePointerSignal[];
  deadPointers: number;
  /** FR-15; `null` unless the area has more than `areaMaxFiles` files. */
  catalog: { files: number } | null;
  /** This article's value-signal findings. */
  findings: OkfFinding[];
}

export interface OkfNodeSignals {
  nodeId: OkfNodeId;
  /** FR-1 of this node; `null` when none of its non-partial reads showed a new pointer. */
  yield: OkfYield | null;
  /** All `search` events of the node in the period. */
  searches: number;
  /** New pointers the node saw in non-partial, non-upkeep reads (one per article / pointer). */
  pointers: { article: string; pointer: string; followed: boolean }[];
  /** FR-3 articles this node missed. */
  routingMisses: { article: string; searches: number; patterns: string[] }[];
  /** FR-2 articles this node searched after reading. */
  searchedAfter: { article: string; searches: number }[];
}

export interface OkfValueSignalsResult {
  /** Per article, keyed by article path. */
  articles: Map<string, OkfArticleSignals>;
  /** Per node, keyed by node id. */
  nodes: Map<OkfNodeId, OkfNodeSignals>;
  /** FR-1 over all period reads; `null` when `n` = 0. */
  yield: OkfYield | null;
  summary: {
    readsWithNewPointers: number;
    readsFollowed: number;
    routingMissArticles: number;
    routingMissPairs: number;
    searchedAfterPairs: number;
    deadPointers: number;
  };
  /** All value-signal findings, `fix` before `info`, then by article path. */
  findings: OkfFinding[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────

function pairKey(nodeId: OkfNodeId, path: string): string {
  return `${typeof nodeId}:${String(nodeId)}\u0000${path}`;
}

function hashKey(hash: string | null): string {
  return hash === null ? '\u0000null' : `h:${hash}`;
}

/** A pointer names a file: no trailing `/` and its last segment has an extension. */
export function isFilePointer(pointer: string): boolean {
  if (pointer === '' || pointer.endsWith('/')) return false;
  const last = pointer.slice(pointer.lastIndexOf('/') + 1);
  return /^.+\.[^./]+$/.test(last);
}

function underCodeRoot(pointer: string, codeRoots: readonly string[]): boolean {
  return codeRoots.some((root) => pointer.startsWith(root));
}

/** Path without a trailing `/` (the repo root `/` becomes `''`). */
function stripSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/** The path itself and each ancestor folder, without trailing `/`, deepest first. */
function selfAndAncestors(path: string): string[] {
  const p = stripSlash(path);
  if (p === '') return [];
  const out = [p];
  let i = p.lastIndexOf('/');
  while (i > 0) {
    out.push(p.slice(0, i));
    i = p.lastIndexOf('/', i - 1);
  }
  return out;
}

/** FR-14: top patterns by count desc, ties by pattern asc. */
export function topPatterns(
  patterns: Iterable<string | null>,
  limit: number = OKF_TOP_PATTERNS,
): OkfPatternCount[] {
  const counts = new Map<string, number>();
  for (const p of patterns) {
    if (p === null || p === '') continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0),
    )
    .slice(0, limit);
}

/** The common folder of the area files (ends in `/`; `/` when they share none). */
export function commonFolder(files: readonly string[]): string {
  if (files.length === 0) return '/';
  let common = files[0].split('/').slice(0, -1);
  for (const f of files.slice(1)) {
    const parts = f.split('/').slice(0, -1);
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) {
      i += 1;
    }
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  return common.length === 0 ? '/' : `${common.join('/')}/`;
}

/** DD-26 `path` param: at most 3 pointers comma-joined, then "…". */
function joinPaths(paths: readonly string[]): string {
  const head = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${head}, …` : head;
}

function joinPatterns(patterns: readonly OkfPatternCount[]): string {
  return patterns.map((p) => p.pattern).join(', ');
}

// ── DD-12 area ─────────────────────────────────────────────────────────────────────────────────

/**
 * DD-12: the area of every article that has all-time reads. The shared-pointer drop counts the
 * distinct articles a pointer is a non-partial new pointer of, across all versions.
 */
export function computeArticleArea(
  allTimePointers: readonly OkfSignalAllTimePointerRow[],
  thresholds: Pick<
    OkfValueSignalThresholds,
    'codeRoots' | 'pointerMaxArticles'
  >,
  latestFiles?: ReadonlyMap<string, { hash: string | null }>,
): Map<string, OkfArticleArea> {
  // pointer → distinct articles it is a new pointer of
  const pointerArticles = new Map<string, Set<string>>();
  // article → hash key → { hash, lastReadAt, candidate pointers }
  const versions = new Map<
    string,
    Map<
      string,
      { hash: string | null; lastReadAt: number | null; files: Set<string> }
    >
  >();

  for (const row of allTimePointers) {
    let byHash = versions.get(row.articlePath);
    if (!byHash) {
      byHash = new Map();
      versions.set(row.articlePath, byHash);
    }
    const hk = hashKey(row.articleHash);
    let version = byHash.get(hk);
    if (!version) {
      version = { hash: row.articleHash, lastReadAt: null, files: new Set() };
      byHash.set(hk, version);
    }
    if (
      row.lastReadAt !== null &&
      (version.lastReadAt === null || row.lastReadAt > version.lastReadAt)
    ) {
      version.lastReadAt = row.lastReadAt;
    }
    if (row.isNew && !row.partial && row.pointer !== '') {
      let arts = pointerArticles.get(row.pointer);
      if (!arts) {
        arts = new Set();
        pointerArticles.set(row.pointer, arts);
      }
      arts.add(row.articlePath);
      if (
        isFilePointer(row.pointer) &&
        underCodeRoot(row.pointer, thresholds.codeRoots)
      ) {
        version.files.add(row.pointer);
      }
    }
  }

  const areas = new Map<string, OkfArticleArea>();
  for (const [article, byHash] of versions) {
    const currentHash = latestFiles?.get(article)?.hash ?? null;
    let chosen = latestFiles ? byHash.get(hashKey(currentHash)) : undefined;
    let older = false;
    if (!chosen) {
      // Most recent version with reads; ties / unknown times by hash ascending for determinism.
      for (const v of byHash.values()) {
        if (
          !chosen ||
          (v.lastReadAt ?? -Infinity) > (chosen.lastReadAt ?? -Infinity) ||
          ((v.lastReadAt ?? -Infinity) === (chosen.lastReadAt ?? -Infinity) &&
            hashKey(v.hash) < hashKey(chosen.hash))
        ) {
          chosen = v;
        }
      }
      older = latestFiles !== undefined && chosen !== undefined;
    }
    if (!chosen) continue;
    const files = [...chosen.files]
      .filter(
        (f) =>
          (pointerArticles.get(f)?.size ?? 0) <= thresholds.pointerMaxArticles,
      )
      .sort();
    areas.set(article, {
      files,
      hash: chosen.hash,
      areaFromOlderVersion: older,
      hasReads: true,
    });
  }
  return areas;
}

// ── DD-13 in-area index ────────────────────────────────────────────────────────────────────────

/** The DD-13 lookup of the article areas: by area file, and by deep-enough folder (FR-2 only). */
export interface OkfAreaIndex {
  /** Area file → articles whose area holds it. */
  files: Map<string, string[]>;
  /** Folder (≥ `OKF_SEARCH_FOLDER_MIN_DEPTH` segments, no trailing `/`) holding an area file → articles. */
  folders: Map<string, Set<string>>;
}

/** DD-13: indexes the area files of every article (article path → its area files). */
export function buildAreaIndex(
  areas: ReadonlyMap<string, { area: { files: readonly string[] } }>,
): OkfAreaIndex {
  const files = new Map<string, string[]>();
  const folders = new Map<string, Set<string>>();
  for (const [path, a] of areas) {
    for (const f of a.area.files) {
      const list = files.get(f);
      if (list) list.push(path);
      else files.set(f, [path]);
      for (const folder of selfAndAncestors(f).slice(1)) {
        if (folder.split('/').length < OKF_SEARCH_FOLDER_MIN_DEPTH) break;
        const arts = folders.get(folder);
        if (arts) arts.add(path);
        else folders.set(folder, new Set([path]));
      }
    }
  }
  return { files, folders };
}

/**
 * DD-13: the articles whose area `path` falls in — the path, without a trailing `/`, is an area
 * file or lies under one (`false`); with `folderRule`, also a folder that holds an area file and
 * is at least `OKF_SEARCH_FOLDER_MIN_DEPTH` segments deep (`true` = matched by the folder rule
 * only).
 */
export function inAreaArticles(
  index: OkfAreaIndex,
  path: string,
  folderRule: boolean,
): Map<string, boolean> {
  const hit = new Map<string, boolean>();
  for (const p of selfAndAncestors(path)) {
    const arts = index.files.get(p);
    if (arts) for (const art of arts) hit.set(art, false);
  }
  if (folderRule) {
    const folderArts = index.folders.get(stripSlash(path));
    if (folderArts) {
      for (const art of folderArts) if (!hit.has(art)) hit.set(art, true);
    }
  }
  return hit;
}

// ── computeArticleSignals ──────────────────────────────────────────────────────────────────────

interface ReadAgg {
  nodeId: OkfNodeId;
  articlePath: string;
  readOrd: number;
  partial: boolean;
  newPointers: Map<string, boolean>; // pointer → followed
}

function emptyNode(nodeId: OkfNodeId): OkfNodeSignals {
  return {
    nodeId,
    yield: null,
    searches: 0,
    pointers: [],
    routingMisses: [],
    searchedAfter: [],
  };
}

function emptyArticle(path: string): OkfArticleSignals {
  return {
    path,
    area: {
      files: [],
      hash: null,
      areaFromOlderVersion: false,
      hasReads: false,
    },
    yield: null,
    reads: { nonPartial: 0, partial: 0 },
    searchedAfter: null,
    routingMiss: null,
    pointers: [],
    deadPointers: 0,
    catalog: null,
    findings: [],
  };
}

/** DD-12..DD-15: every value signal of the view, per article and per node, plus the findings. */
export function computeArticleSignals(
  input: OkfValueSignalsInput,
): OkfValueSignalsResult {
  const t = input.thresholds;
  const bundleOf = input.bundleOf ?? (() => null);

  const upkeep = new Set(
    input.upkeep.map((u) => pairKey(u.nodeId, u.articlePath)),
  );
  const isUpkeep = (nodeId: OkfNodeId, article: string): boolean =>
    upkeep.has(pairKey(nodeId, article));

  const articles = new Map<string, OkfArticleSignals>();
  const article = (path: string): OkfArticleSignals => {
    let a = articles.get(path);
    if (!a) {
      a = emptyArticle(path);
      articles.set(path, a);
    }
    return a;
  };
  const nodes = new Map<OkfNodeId, OkfNodeSignals>();
  const node = (id: OkfNodeId): OkfNodeSignals => {
    let n = nodes.get(id);
    if (!n) {
      n = emptyNode(id);
      nodes.set(id, n);
    }
    return n;
  };

  // ── Area (DD-12) ──
  const areas = computeArticleArea(input.allTimePointers, t, input.latestFiles);
  for (const [path, area] of areas) article(path).area = area;

  // ── Reads from period pointer rows (one read = node + article + readOrd) ──
  const readsByKey = new Map<string, ReadAgg>();
  for (const row of input.pointers) {
    if (isUpkeep(row.nodeId, row.articlePath)) continue;
    const key = `${pairKey(row.nodeId, row.articlePath)}\u0000${row.readOrd}`;
    let r = readsByKey.get(key);
    if (!r) {
      r = {
        nodeId: row.nodeId,
        articlePath: row.articlePath,
        readOrd: row.readOrd,
        partial: false,
        newPointers: new Map(),
      };
      readsByKey.set(key, r);
    }
    if (row.partial) r.partial = true;
    if (row.isNew && row.pointer !== '') {
      r.newPointers.set(
        row.pointer,
        (r.newPointers.get(row.pointer) ?? false) || row.followed,
      );
    }
  }

  // Per pair: min non-partial read ord (FR-2 fallback); per article / pointer: shown / followed nodes.
  const pairFirstOrd = new Map<string, number>();
  const pointerNodes = new Map<
    string,
    Map<string, { shown: Set<string>; followed: Set<string> }>
  >();
  const nodePointerSeen = new Map<string, OkfNodeSignals['pointers'][number]>();
  const nodeYield = new Map<OkfNodeId, OkfYield>();
  let totalN = 0;
  let totalK = 0;

  for (const r of readsByKey.values()) {
    const a = article(r.articlePath);
    if (r.partial) {
      a.reads.partial += 1;
      continue;
    }
    a.reads.nonPartial += 1;
    const pk = pairKey(r.nodeId, r.articlePath);
    const prev = pairFirstOrd.get(pk);
    if (prev === undefined || r.readOrd < prev) pairFirstOrd.set(pk, r.readOrd);

    if (r.newPointers.size === 0) continue;
    const followedAny = [...r.newPointers.values()].some(Boolean);
    a.yield = {
      n: (a.yield?.n ?? 0) + 1,
      k: (a.yield?.k ?? 0) + (followedAny ? 1 : 0),
    };
    const ny = nodeYield.get(r.nodeId) ?? { k: 0, n: 0 };
    ny.n += 1;
    if (followedAny) ny.k += 1;
    nodeYield.set(r.nodeId, ny);
    totalN += 1;
    if (followedAny) totalK += 1;

    let byPointer = pointerNodes.get(r.articlePath);
    if (!byPointer) {
      byPointer = new Map();
      pointerNodes.set(r.articlePath, byPointer);
    }
    const nodeKey = `${typeof r.nodeId}:${String(r.nodeId)}`;
    for (const [pointer, followed] of r.newPointers) {
      let pn = byPointer.get(pointer);
      if (!pn) {
        pn = { shown: new Set(), followed: new Set() };
        byPointer.set(pointer, pn);
      }
      pn.shown.add(nodeKey);
      if (followed) pn.followed.add(nodeKey);

      const seenKey = `${pk}\u0000${pointer}`;
      const seen = nodePointerSeen.get(seenKey);
      if (seen) {
        seen.followed = seen.followed || followed;
      } else {
        const entry = { article: r.articlePath, pointer, followed };
        nodePointerSeen.set(seenKey, entry);
        node(r.nodeId).pointers.push(entry);
      }
    }
  }
  for (const [id, y] of nodeYield) node(id).yield = y;

  // ── Read pairs (FR-2 / FR-3 "has a read row") ──
  const readPairs = new Map<string, OkfSignalNodeRead>();
  for (const r of input.reads) {
    if (isUpkeep(r.nodeId, r.articlePath)) continue;
    const pk = pairKey(r.nodeId, r.articlePath);
    const prev = readPairs.get(pk);
    if (
      !prev ||
      (r.firstReadOrd != null &&
        (prev.firstReadOrd == null || r.firstReadOrd < prev.firstReadOrd))
    ) {
      readPairs.set(pk, r);
    }
    article(r.articlePath);
  }
  // A pair known only from pointer rows still counts as read.
  for (const r of readsByKey.values()) {
    const pk = pairKey(r.nodeId, r.articlePath);
    if (!readPairs.has(pk)) {
      readPairs.set(pk, { nodeId: r.nodeId, articlePath: r.articlePath });
    }
  }

  // ── Events: in-area search index (DD-13) ──
  // Catalog articles included; FR-2 still applies to them.
  const areaIndex = buildAreaIndex(articles);
  // node → article → in-area search events (ord, pattern; `folder` = a folder search, FR-2 only)
  const nodeArticleSearches = new Map<
    OkfNodeId,
    Map<string, { ord: number; pattern: string | null; folder: boolean }[]>
  >();
  for (const e of input.events) {
    if (e.op !== 'search') continue;
    node(e.nodeId).searches += 1;
    const hit = inAreaArticles(areaIndex, e.path, true);
    if (hit.size === 0) continue;
    let byArticle = nodeArticleSearches.get(e.nodeId);
    if (!byArticle) {
      byArticle = new Map();
      nodeArticleSearches.set(e.nodeId, byArticle);
    }
    for (const [art, folder] of hit) {
      const list = byArticle.get(art);
      const item = { ord: e.ord, pattern: e.pattern, folder };
      if (list) list.push(item);
      else byArticle.set(art, [item]);
    }
  }

  // ── FR-15 catalog ──
  for (const a of articles.values()) {
    if (a.area.files.length > t.areaMaxFiles) {
      a.catalog = { files: a.area.files.length };
    }
  }

  // ── FR-2 searched after ──
  const searchedPatterns = new Map<string, (string | null)[]>();
  for (const [pk, r] of readPairs) {
    const firstOrd = r.firstReadOrd ?? pairFirstOrd.get(pk);
    if (firstOrd === undefined || firstOrd === null) continue;
    const searches = nodeArticleSearches
      .get(r.nodeId)
      ?.get(r.articlePath)
      ?.filter((s) => s.ord > firstOrd);
    if (!searches || searches.length < t.exploredMinSearches) continue;
    const a = article(r.articlePath);
    const sa = a.searchedAfter ?? {
      agents: 0,
      searches: 0,
      patterns: [],
      pairs: [],
    };
    sa.agents += 1;
    sa.searches += searches.length;
    sa.pairs.push({ nodeId: r.nodeId, searches: searches.length });
    a.searchedAfter = sa;
    const pats = searchedPatterns.get(r.articlePath) ?? [];
    for (const s of searches) pats.push(s.pattern);
    searchedPatterns.set(r.articlePath, pats);
    node(r.nodeId).searchedAfter.push({
      article: r.articlePath,
      searches: searches.length,
    });
  }
  for (const [path, pats] of searchedPatterns) {
    const sa = articles.get(path)?.searchedAfter;
    if (sa) sa.patterns = topPatterns(pats);
  }

  // ── FR-3 routing miss ──
  // article → nodes with in-area searches (non-upkeep)
  const articleSearchers = new Map<
    string,
    { nodeId: OkfNodeId; searches: { ord: number; pattern: string | null }[] }[]
  >();
  for (const [nodeId, byArticle] of nodeArticleSearches) {
    for (const [art, all] of byArticle) {
      if (isUpkeep(nodeId, art)) continue;
      // A folder search does not say which article the agent was after: file searches only.
      const searches = all.filter((s) => !s.folder);
      if (searches.length === 0) continue;
      const list = articleSearchers.get(art);
      const item = { nodeId, searches };
      if (list) list.push(item);
      else articleSearchers.set(art, [item]);
    }
  }
  let routingMissPairs = 0;
  for (const [art, searchers] of articleSearchers) {
    const a = article(art);
    if (a.catalog !== null) continue;
    const missing = searchers.filter(
      (s) =>
        s.searches.length >= t.routingMinSearches &&
        !readPairs.has(pairKey(s.nodeId, art)),
    );
    const patterns = topPatterns(
      missing.flatMap((m) => m.searches.map((s) => s.pattern)),
    );
    a.routingMiss = {
      agents: missing.length,
      areaAgents: searchers.length,
      patterns,
      missing: missing.map((m) => ({
        nodeId: m.nodeId,
        searches: m.searches.length,
        patterns: topPatterns(m.searches.map((s) => s.pattern)).map(
          (p) => p.pattern,
        ),
      })),
    };
    if (missing.length >= t.routingMinAgents) {
      routingMissPairs += missing.length;
      for (const m of a.routingMiss.missing) {
        node(m.nodeId).routingMisses.push({
          article: art,
          searches: m.searches,
          patterns: m.patterns,
        });
      }
    }
  }

  // ── FR-13 dead pointers ──
  const touched = new Set<string>();
  for (const p of input.allTimeTouchedPaths) {
    for (const anc of selfAndAncestors(p)) touched.add(anc);
  }
  for (const [art, byPointer] of pointerNodes) {
    const a = article(art);
    const list: OkfArticlePointerSignal[] = [];
    for (const [pointer, pn] of byPointer) {
      const dead =
        pn.shown.size >= t.deadPointerMinShown && pn.followed.size === 0;
      const p = stripSlash(pointer);
      const notFound =
        dead && !touched.has(p) && !(input.latestFiles?.has(p) ?? false);
      list.push({
        pointer,
        shown: pn.shown.size,
        followed: pn.followed.size,
        dead,
        notFound,
      });
    }
    list.sort(
      (x, y) =>
        Number(y.dead) - Number(x.dead) ||
        y.shown - x.shown ||
        (x.pointer < y.pointer ? -1 : x.pointer > y.pointer ? 1 : 0),
    );
    a.pointers = list;
    a.deadPointers = list.filter((p) => p.dead).length;
  }

  // ── Findings ──
  let routingMissArticles = 0;
  let searchedAfterPairs = 0;
  let deadPointers = 0;
  const findings: OkfFinding[] = [];
  const sortedPaths = [...articles.keys()].sort();
  for (const path of sortedPaths) {
    const a = articles.get(path)!;
    const bundle = bundleOf(path);
    const findingNode = { bundle, path };
    const area = commonFolder(a.area.files);

    if (a.routingMiss && a.routingMiss.agents >= t.routingMinAgents) {
      routingMissArticles += 1;
      a.findings.push({
        rule: 'routing_miss',
        severity: 'fix',
        params: {
          file: path,
          area,
          patterns: joinPatterns(a.routingMiss.patterns),
          agents: a.routingMiss.agents,
          areaAgents: a.routingMiss.areaAgents,
        },
        node: findingNode,
      });
    }
    if (a.searchedAfter) {
      searchedAfterPairs += a.searchedAfter.agents;
      a.findings.push({
        rule: 'searched_after',
        severity: 'fix',
        params: {
          file: path,
          patterns: joinPatterns(a.searchedAfter.patterns),
          agents: a.searchedAfter.agents,
          searches: a.searchedAfter.searches,
        },
        node: findingNode,
      });
    }
    if (a.deadPointers > 0) {
      deadPointers += a.deadPointers;
      const dead = a.pointers.filter((p) => p.dead);
      a.findings.push({
        rule: 'dead_pointers',
        severity: 'fix',
        params: {
          file: path,
          path: joinPaths(dead.map((p) => p.pointer)),
          dead: dead.length,
          notFound: dead.filter((p) => p.notFound).length,
        },
        node: findingNode,
      });
    }
    if (a.catalog) {
      a.findings.push({
        rule: 'catalog',
        severity: 'info',
        params: { file: path, files: a.catalog.files, area },
        node: findingNode,
      });
    }
    findings.push(...a.findings);
  }
  findings.sort(
    (x, y) => Number(x.severity === 'info') - Number(y.severity === 'info'),
  );

  return {
    articles,
    nodes,
    yield: totalN > 0 ? { k: totalK, n: totalN } : null,
    summary: {
      readsWithNewPointers: totalN,
      readsFollowed: totalK,
      routingMissArticles,
      routingMissPairs,
      searchedAfterPairs,
      deadPointers,
    },
    findings,
  };
}
