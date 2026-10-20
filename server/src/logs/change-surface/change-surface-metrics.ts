/**
 * Change surface — the one definition of the concentration metric.
 *
 * Every surface in the feature — the session tab, the summary tile, the detectors, the
 * report and the analytics chart — renders numbers that come out of this function, for
 * its own scope. That is what makes "all surfaces agree" structural instead of a
 * testing promise: there is nowhere else a second, subtly different aggregation could
 * live. Concentration is deliberately **not** stored on `session_stats` for the same
 * reason — a per-node value cannot be summed or averaged into a tree value, so a stored
 * copy would immediately disagree with every recomputed one.
 *
 * The input is always `ChangedPathFact[]`: one already-normalised row per logical path
 * per session. Feeding it two sessions' rows yields the **union** — distinctness is on
 * `relPathKey` — never the sum, which is exactly what the tree scope needs.
 */
import {
  ChangeBand,
  ChangeKind,
  ChangeSurfaceAggregate,
  ChangeSurfaceExtensionRow,
  ChangeSurfaceFileKindRow,
  ChangeSurfaceFolderRow,
  ChangedPathFact,
  FileKind,
} from './change-surface.types';

/** Weights of the four components. They sum to `1`. */
const WEIGHT_ENTROPY = 0.4;
const WEIGHT_LARGEST_SHARE = 0.25;
const WEIGHT_MODULE_FOCUS = 0.2;
const WEIGHT_PROXIMITY = 0.15;

/**
 * Small changes get lenient treatment, in two tiers:
 *
 * 1. **Focused floor** (`FOCUSED_SMALL_CHANGE_MAX_FILES`): a scope of 1–5 changed files is
 *    always at least `BAND_FOCUSED_MIN`, so it bands `focused` no matter how its files land.
 *    `E`/`S` are *proportional* measures — 2 files split one-per-folder score identically to
 *    200 files split evenly across 200 folders — but a change of up to five files is trivially
 *    small however it happens to land (server API + client form + doc is a very focused
 *    change), while a 200-file one genuinely is spread out.
 * 2. **Closeness blend** (`SMALL_CHANGE_MAX_FILES`): below this many changed files, `E` and
 *    `S` are blended toward their fully-concentrated value of `1`, scaled by both how small
 *    the change is and by `componentD` (folder proximity). With the floor covering everything
 *    up to 5 files, the blend still shapes the score of the 6-file case — and of any small
 *    change already above the floor.
 */
const SMALL_CHANGE_MAX_FILES = 6;
/** ≤ this many changed files ⇒ concentration is floored to `BAND_FOCUSED_MIN` ("focused");
 *  6+ files keep pure score-based banding. */
const FOCUSED_SMALL_CHANGE_MAX_FILES = 5;

/** Band boundaries, from the chart wireframe. */
const BAND_FOCUSED_MIN = 60;
const BAND_MIXED_MIN = 40;

/** Canonical order of the fixed taxonomy, used only to break display ties. */
const FILE_KIND_ORDER: readonly FileKind[] = [
  'source',
  'test',
  'config',
  'docs',
  'other',
];

/** Optional overrides for the two state flags this function cannot know by itself. */
export interface ComputeChangeSurfaceOptions {
  /**
   * `cs_computed_at IS NOT NULL` for the scope. Defaults to `true` — a caller holding
   * facts has by definition run the extractor; the read services pass the real value
   * so a never-recomputed session renders "no data" rather than a truthful-looking `0`.
   */
  computed?: boolean;
  /** Defaults to a derivation from the facts (see {@link deriveRepoRootKnown}). */
  repoRootKnown?: boolean;
}

/** One logical file, folded across every session in the scope. */
interface MergedFile {
  folder: string;
  folderKey: string;
  topModuleKey: string;
  topModuleLabel: string;
  fileKind: FileKind;
  extension: string;
  changeKind: ChangeKind;
  diffCovered: boolean;
  linesAdded: number;
  linesRemoved: number;
}

/** One touched folder, with its file count `n_i`. */
interface FolderGroup {
  label: string;
  segments: string[];
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * `focused >= 60`, `mixed 40-59`, `scattered < 40`; `null` in, `null` out.
 *
 * A `null` concentration is the zero-changed-files state, which has no band — it is
 * not "scattered", and colouring it as such would invent a finding out of nothing.
 */
export function concentrationBand(value: number | null): ChangeBand | null {
  if (value === null) return null;
  if (value >= BAND_FOCUSED_MIN) return 'focused';
  if (value >= BAND_MIXED_MIN) return 'mixed';
  return 'scattered';
}

/**
 * The repo root counts as known unless *every* fact is in the un-normalisable,
 * not-outside-the-repo state reserved for "no root was learned".
 * With no facts at all there is nothing to contradict a known root, so it stays `true`
 * and the zero-change session is not misreported as a missing-root one.
 */
function deriveRepoRootKnown(facts: readonly ChangedPathFact[]): boolean {
  if (facts.length === 0) return true;
  return !facts.every((f) => f.relPathKey === null && !f.outsideRepo);
}

/** Segments of a folder path; the repo-root folder `'.'` has none. */
function folderSegments(folderKey: string): string[] {
  if (folderKey === '' || folderKey === '.') return [];
  return folderKey.split('/').filter((seg) => seg.length > 0);
}

/** Number of leading segments two folders share. */
function commonPrefixLength(
  a: readonly string[],
  b: readonly string[],
): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Fold the scope's rows into one row per logical file.
 *
 * Line counts add up across sessions (a file edited in two sessions really was changed
 * by both), but the file itself is counted once — that asymmetry is the whole point of
 * the union scope.
 */
function mergeInRepoFiles(
  facts: readonly ChangedPathFact[],
): Map<string, MergedFile> {
  const files = new Map<string, MergedFile>();
  for (const fact of facts) {
    if (fact.outsideRepo || fact.relPathKey === null) continue;
    const existing = files.get(fact.relPathKey);
    const folderKey = fact.folderKey ?? '.';
    if (existing === undefined) {
      files.set(fact.relPathKey, {
        folder: fact.folder ?? '.',
        folderKey,
        topModuleKey: fact.topModuleKey ?? '.',
        topModuleLabel: topModuleLabelOf(fact),
        fileKind: fact.fileKind ?? 'other',
        extension: fact.extension ?? '',
        changeKind: fact.changeKind,
        diffCovered: fact.diffCoveredCalls > 0,
        linesAdded: fact.linesAdded,
        linesRemoved: fact.linesRemoved,
      });
      continue;
    }
    existing.linesAdded += fact.linesAdded;
    existing.linesRemoved += fact.linesRemoved;
    existing.diffCovered = existing.diffCovered || fact.diffCoveredCalls > 0;
    // `added` wins: the file was created inside the scope, whatever else happened to
    // it afterwards.
    if (fact.changeKind === 'added') existing.changeKind = 'added';
    else if (fact.changeKind === 'deleted' && existing.changeKind !== 'added') {
      existing.changeKind = 'deleted';
    }
  }
  return files;
}

/** Display name of a fact's top-level module — original case, `'.'` at the root. */
function topModuleLabelOf(fact: ChangedPathFact): string {
  if (fact.folder === null || fact.folder === '.') return '.';
  const first = fact.folder.split('/')[0];
  return first.length > 0 ? first : '.';
}

/** Group the merged files by folder, keeping the original-case folder for display. */
function groupByFolder(files: Iterable<MergedFile>): Map<string, FolderGroup> {
  const folders = new Map<string, FolderGroup>();
  for (const file of files) {
    const group = folders.get(file.folderKey);
    if (group === undefined) {
      folders.set(file.folderKey, {
        label: file.folder,
        segments: folderSegments(file.folderKey),
        files: 1,
        linesAdded: file.linesAdded,
        linesRemoved: file.linesRemoved,
      });
      continue;
    }
    group.files += 1;
    group.linesAdded += file.linesAdded;
    group.linesRemoved += file.linesRemoved;
  }
  return folders;
}

/**
 * The pairwise folder-distance pass (the `D` term, plus the raw hop count
 * the tab displays).
 *
 * `sep` is normalised by `d_u + d_v` on purpose: `a/b/c` and `a/b/d` are two hops
 * apart and so are `a` and `z`, but only the depth-normalised form scores the first
 * pair as closer, which is what the near/far ranking demands. The loop is `O(K^2)` and runs exactly,
 * with no sampling and no cap, so the value is deterministic: a 300-file session
 * is ~45k cheap integer comparisons.
 */
function folderSeparation(groups: readonly FolderGroup[]): {
  meanSep: number;
  meanRawHops: number;
} {
  const count = groups.length;
  if (count < 2) return { meanSep: 0, meanRawHops: 0 };
  let sepSum = 0;
  let hopSum = 0;
  let pairs = 0;
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      const a = groups[i].segments;
      const b = groups[j].segments;
      const common = commonPrefixLength(a, b);
      const hops = a.length - common + (b.length - common);
      const depthSum = a.length + b.length;
      sepSum += depthSum === 0 ? 0 : hops / depthSum;
      hopSum += hops;
      pairs += 1;
    }
  }
  return { meanSep: sepSum / pairs, meanRawHops: hopSum / pairs };
}

/** Shannon entropy of the folder distribution, in nats. */
function folderEntropy(
  groups: readonly FolderGroup[],
  fileCount: number,
): number {
  let entropy = 0;
  for (const group of groups) {
    const p = group.files / fileCount;
    if (p > 0) entropy -= p * Math.log(p);
  }
  return entropy;
}

/** Segment count of the common ancestor folder of every in-repo changed path. */
function commonAncestorDepthOf(groups: readonly FolderGroup[]): number {
  if (groups.length === 0) return 0;
  let common = groups[0].segments;
  for (let i = 1; i < groups.length; i += 1) {
    common = common.slice(0, commonPrefixLength(common, groups[i].segments));
    if (common.length === 0) break;
  }
  return common.length;
}

function buildExtensionRows(
  files: Iterable<MergedFile>,
): ChangeSurfaceExtensionRow[] {
  const rows = new Map<string, ChangeSurfaceExtensionRow>();
  for (const file of files) {
    const row = rows.get(file.extension);
    if (row === undefined) {
      rows.set(file.extension, {
        extension: file.extension,
        files: 1,
        linesAdded: file.linesAdded,
        linesRemoved: file.linesRemoved,
      });
      continue;
    }
    row.files += 1;
    row.linesAdded += file.linesAdded;
    row.linesRemoved += file.linesRemoved;
  }
  return [...rows.values()].sort(
    (a, b) => b.files - a.files || compareText(a.extension, b.extension),
  );
}

function buildFileKindRows(
  files: Iterable<MergedFile>,
  fileCount: number,
): ChangeSurfaceFileKindRow[] {
  const rows = new Map<FileKind, ChangeSurfaceFileKindRow>();
  for (const file of files) {
    const row = rows.get(file.fileKind);
    if (row === undefined) {
      rows.set(file.fileKind, {
        kind: file.fileKind,
        files: 1,
        share: 0,
        linesAdded: file.linesAdded,
        linesRemoved: file.linesRemoved,
      });
      continue;
    }
    row.files += 1;
    row.linesAdded += file.linesAdded;
    row.linesRemoved += file.linesRemoved;
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      share: fileCount === 0 ? 0 : round6(row.files / fileCount),
    }))
    .sort(
      (a, b) =>
        b.files - a.files ||
        FILE_KIND_ORDER.indexOf(a.kind) - FILE_KIND_ORDER.indexOf(b.kind),
    );
}

function buildFolderRows(
  groups: Iterable<FolderGroup>,
): ChangeSurfaceFolderRow[] {
  return [...groups]
    .map((group) => ({
      folder: group.label,
      files: group.files,
      linesAdded: group.linesAdded,
      linesRemoved: group.linesRemoved,
    }))
    .sort((a, b) => b.files - a.files || compareText(a.folder, b.folder));
}

/** Locale-independent string order — the same everywhere, which "all surfaces agree" needs. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Aggregate one scope's changed-path facts.
 *
 * Rows that are outside the repo — or that could not be normalised because no repo
 * root was known — take no part in any spread computation and are reported through the
 * three `outsideRepo*` fields instead, so `~/.claude/settings.json` can never drag a
 * session's concentration down.
 */
export function computeChangeSurface(
  facts: readonly ChangedPathFact[],
  options: ComputeChangeSurfaceOptions = {},
): ChangeSurfaceAggregate {
  const merged = mergeInRepoFiles(facts);
  const files = [...merged.values()];
  const fileCount = files.length;

  const folderMap = groupByFolder(files);
  const folders = [...folderMap.values()];
  const folderCount = folders.length;

  const moduleLabels = new Map<string, string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  let diffCoveredFiles = 0;
  const byChangeKind = { added: 0, modified: 0, deleted: 0 };
  for (const file of files) {
    if (!moduleLabels.has(file.topModuleKey)) {
      moduleLabels.set(file.topModuleKey, file.topModuleLabel);
    }
    linesAdded += file.linesAdded;
    linesRemoved += file.linesRemoved;
    if (file.diffCovered) diffCoveredFiles += 1;
    byChangeKind[file.changeKind] += 1;
  }

  // Excluded rows: outside the repo, or recorded before any root was known. Counted
  // by `pathKey`, which is the row identity when there is no `relPathKey` to fold on.
  const excluded = new Map<string, ChangedPathFact>();
  for (const fact of facts) {
    if (!fact.outsideRepo && fact.relPathKey !== null) continue;
    const existing = excluded.get(fact.pathKey);
    if (existing === undefined) {
      excluded.set(fact.pathKey, { ...fact });
      continue;
    }
    existing.linesAdded += fact.linesAdded;
    existing.linesRemoved += fact.linesRemoved;
  }
  let outsideRepoLinesAdded = 0;
  let outsideRepoLinesRemoved = 0;
  for (const fact of excluded.values()) {
    outsideRepoLinesAdded += fact.linesAdded;
    outsideRepoLinesRemoved += fact.linesRemoved;
  }

  const topLevelModules = [...moduleLabels.entries()]
    .sort((a, b) => compareText(a[0], b[0]))
    .map(([, label]) => label);

  const base = {
    computed: options.computed ?? true,
    repoRootKnown: options.repoRootKnown ?? deriveRepoRootKnown(facts),
    changedFiles: fileCount,
    foldersTouched: folderCount,
    topLevelModules,
    singleFileFolders: folders.filter((group) => group.files === 1).length,
    linesAdded,
    linesRemoved,
    diffCoveredFiles,
    outsideRepoFiles: excluded.size,
    outsideRepoLinesAdded,
    outsideRepoLinesRemoved,
    byExtension: buildExtensionRows(files),
    byFileKind: buildFileKindRows(files, fileCount),
    byChangeKind,
    folderDistribution: buildFolderRows(folders),
  };

  // No in-repo change: every spread number is undefined, not zero. A `0`
  // concentration would read as "maximally scattered" for a session that touched
  // nothing at all.
  if (fileCount === 0) {
    return {
      ...base,
      concentration: null,
      band: null,
      filesPerFolder: null,
      largestFolderShare: null,
      folderEntropyNorm: null,
      meanPathDistanceHops: null,
      commonAncestorDepth: null,
    };
  }

  const entropy = folderEntropy(folders, fileCount);
  // `ln 1 = 0` makes the normalisation undefined for a single folder; a single folder
  // is the maximally focused case, so `E` is defined as `1` there — while the
  // *displayed* raw entropy is `0`.
  const entropyNorm =
    folderCount === 1 ? 0 : entropy / Math.log(folderCount || 1);
  const rawComponentE = folderCount === 1 ? 1 : 1 - entropyNorm;

  const largestFolder = folders.reduce(
    (max, group) => Math.max(max, group.files),
    0,
  );
  const rawComponentS = largestFolder / fileCount;

  const moduleCount = moduleLabels.size;
  const componentM = moduleCount === 0 ? 1 : 1 / moduleCount;

  const { meanSep, meanRawHops } = folderSeparation(folders);
  const componentD = folderCount < 2 ? 1 : 1 - meanSep;

  // Small-change leniency (see `SMALL_CHANGE_MAX_FILES`): blend `E`/`S` toward `1`, scaled by
  // both how small the change is and how close its folders already are.
  const smallness =
    fileCount <= SMALL_CHANGE_MAX_FILES
      ? 1 - (fileCount - 1) / SMALL_CHANGE_MAX_FILES
      : 0;
  const closeness = smallness * componentD;
  const componentE = rawComponentE + closeness * (1 - rawComponentE);
  const componentS = rawComponentS + closeness * (1 - rawComponentS);

  const score =
    WEIGHT_ENTROPY * componentE +
    WEIGHT_LARGEST_SHARE * componentS +
    WEIGHT_MODULE_FOCUS * componentM +
    WEIGHT_PROXIMITY * componentD;
  let concentration = Math.min(100, Math.max(0, Math.round(100 * score)));
  // Small-change focused floor (see `FOCUSED_SMALL_CHANGE_MAX_FILES`): a 1–5-file scope is
  // always at least `BAND_FOCUSED_MIN`, so it bands `focused` via `concentrationBand()`.
  // Zero-file scopes never reach this point — they return `concentration: null` above.
  if (fileCount >= 1 && fileCount <= FOCUSED_SMALL_CHANGE_MAX_FILES) {
    concentration = Math.max(concentration, BAND_FOCUSED_MIN);
  }

  return {
    ...base,
    concentration,
    band: concentrationBand(concentration),
    filesPerFolder: round6(fileCount / folderCount),
    // The true, unblended share — small-change leniency only adjusts the score's inputs,
    // it must never change what this displayed tile reports.
    largestFolderShare: round6(rawComponentS),
    folderEntropyNorm: round6(entropyNorm),
    meanPathDistanceHops: round1(meanRawHops),
    commonAncestorDepth: commonAncestorDepthOf(folders),
  };
}
