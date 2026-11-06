/**
 * OKF usage — the agent trail of the session OKF tab (2026-11-03 okf-view-kb-value, package 3).
 *
 * Pure: turns one tree node's ordered access sequence (`extractOkfDetail(...).seq`, rebuilt from
 * its transcript per request) into the trail items the tab groups into episodes, and marks which
 * KB articles' areas each code read / search falls in. Rule 11 of
 * `docs/knowledgebase/algorithms/okf-value-signals.md`:
 *
 * - `inArea` of a code `search` item: the articles whose DD-13 area its path falls in, the folder
 *   rule included (as for FR-2); of a code `read` item: the articles whose area holds the file.
 *   Only articles the node read (`kb_read`) at an earlier ordinal, and not upkeep articles (the
 *   node also wrote them, DD-15). Sorted; absent when empty. `kb_*` and `write` items get none.
 * - `followedAt` of a `kb_read` item with new pointers: per new pointer, the ordinal of the first
 *   later item whose path (without a trailing `/`) is the pointer or lies under it — the DD-9
 *   "followed" test, so a pointer shown here as never followed is exactly an unfollowed pointer.
 *   Computed over the whole sequence, before the cap.
 * - The first `cap` items are kept; `truncated` says more existed.
 */
import type { OkfSeqItem } from './okf-access-extractor';
import { OKF_TRAIL_MAX_ITEMS } from './okf-constants';
import type { OkfTrailItem } from './okf-usage.types';
import { buildAreaIndex, inAreaArticles } from './okf-value-signals';

export interface OkfTrailInput {
  /** The node's ordered accesses (team filter already applied). */
  seq: readonly OkfSeqItem[];
  /** DD-12 area files per article of the view (article path → sorted area files). */
  areas: ReadonlyMap<string, readonly string[]>;
  /** Item cap; default `OKF_TRAIL_MAX_ITEMS`. */
  cap?: number;
}

export interface OkfTrailResult {
  items: OkfTrailItem[];
  truncated: boolean;
}

function stripSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/** Rule 11: the trail items of one node. */
export function buildOkfTrail(input: OkfTrailInput): OkfTrailResult {
  const cap = input.cap ?? OKF_TRAIL_MAX_ITEMS;
  const index = buildAreaIndex(
    new Map(
      [...input.areas].map(([path, files]) => [path, { area: { files } }]),
    ),
  );

  const firstRead = new Map<string, number>();
  const upkeep = new Set<string>();
  for (const item of input.seq) {
    if (item.op === 'kb_read' && !firstRead.has(item.path)) {
      firstRead.set(item.path, item.ord);
    } else if (item.op === 'kb_write') {
      upkeep.add(item.path);
    }
  }

  // Path and each ancestor folder (no trailing `/`) → ordinals that touched it, ascending.
  const touchedAt = new Map<string, number[]>();
  for (const item of input.seq) {
    const segs = stripSlash(item.path).split('/');
    for (let k = 1; k <= segs.length; k++) {
      const key = segs.slice(0, k).join('/');
      if (key === '') continue;
      const list = touchedAt.get(key);
      if (list === undefined) touchedAt.set(key, [item.ord]);
      else if (list[list.length - 1] !== item.ord) list.push(item.ord);
    }
  }
  const firstTouchAfter = (pointer: string, ord: number): number | null => {
    const list = touchedAt.get(stripSlash(pointer));
    if (list === undefined) return null;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= ord) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length ? list[lo] : null;
  };

  const items: OkfTrailItem[] = input.seq.map((item) => {
    const out: OkfTrailItem = { ord: item.ord, op: item.op, path: item.path };
    if (item.offset !== undefined) out.offset = item.offset;
    if (item.limit !== undefined) out.limit = item.limit;
    if (item.pattern !== undefined) out.pattern = item.pattern;
    if (item.hit !== undefined) out.hit = item.hit;
    if (item.newPointers !== undefined) {
      out.newPointers = [...item.newPointers];
      const followedAt: Record<string, number> = {};
      for (const pointer of item.newPointers) {
        const at = firstTouchAfter(pointer, item.ord);
        if (at !== null) followedAt[pointer] = at;
      }
      if (Object.keys(followedAt).length > 0) out.followedAt = followedAt;
    }
    if (item.op === 'search' || item.op === 'read') {
      const inArea = [
        ...inAreaArticles(index, item.path, item.op === 'search').keys(),
      ]
        .filter((article) => {
          const first = firstRead.get(article);
          return (
            first !== undefined && first < item.ord && !upkeep.has(article)
          );
        })
        .sort();
      if (inArea.length > 0) out.inArea = inArea;
    }
    return out;
  });

  return {
    items: items.slice(0, cap),
    truncated: items.length > cap,
  };
}
