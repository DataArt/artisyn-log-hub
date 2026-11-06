/**
 * Agent trail of the session OKF tab (package 3): groups the server's trail items into episodes
 * that start at a KB article read, so a reader sees "read article X → it showed paths P → then
 * searched / opened …" and can judge by hand whether the article helped.
 *
 * - An episode starts at a `kb_read` that follows a code item (or opens the trail); the KB items
 *   right after it (index → article, a KB search) stay in its head. Items before any KB read form
 *   one leading episode with no article.
 * - "After reading" counts, over the episode's code items: searches marked in the area of an
 *   article read in its head, and distinct files opened (code reads).
 * - A new code path of a KB read is "opened at #N" / "searched at #N" / "used at #N" by the item
 *   at the server's `followedAt` call number, "never opened" when absent.
 *
 * Pure UI logic: no rule here changes a number the server computed.
 */
import type {
  OkfAgent,
  OkfTrailItem,
} from '../../../../../models/repositories';

export interface OkfTrailEpisode {
  /** KB articles read in the head (in order); empty for the leading episode. */
  articles: string[];
  /** KB items that open the episode. */
  head: OkfTrailItem[];
  /** The code (and later KB search / write) items after the head. */
  body: OkfTrailItem[];
  /** Searches in the area of a head article, after it. */
  areaSearches: number;
  /** Distinct code files read in the episode body. */
  filesOpened: number;
}

export function isKbItem(item: OkfTrailItem): boolean {
  return item.op.startsWith('kb_');
}

/** A bundle's `index.md` (the catalog every agent reads first). */
export function isIndexPath(path: string): boolean {
  return path === 'index.md' || path.endsWith('/index.md');
}

/** First agent with a searched-after pair / a routing miss: where section B's tile links lead. */
export function okfTrailLinkAgents(
  agents: readonly Pick<OkfAgent, 'id' | 'searchedAfter' | 'routingMisses'>[],
): { searchedAfter: string | null; routingMiss: string | null } {
  return {
    searchedAfter:
      agents.find((a) => (a.searchedAfter?.length ?? 0) > 0)?.id ?? null,
    routingMiss:
      agents.find((a) => (a.routingMisses?.length ?? 0) > 0)?.id ?? null,
  };
}

/** Number of distinct calls in the trail. */
export function trailCallCount(items: readonly OkfTrailItem[]): number {
  return new Set(items.map((i) => i.ord)).size;
}

function summarise(e: OkfTrailEpisode): OkfTrailEpisode {
  const articles = new Set(e.articles);
  const opened = new Set<string>();
  let areaSearches = 0;
  for (const item of e.body) {
    if (item.op === 'read') opened.add(item.path);
    if (
      item.op === 'search' &&
      (item.inArea ?? []).some((a) => articles.has(a))
    ) {
      areaSearches += 1;
    }
  }
  return { ...e, areaSearches, filesOpened: opened.size };
}

/** The episodes of a trail, in call order. */
export function groupOkfTrail(
  items: readonly OkfTrailItem[],
): OkfTrailEpisode[] {
  const episodes: OkfTrailEpisode[] = [];
  let current: OkfTrailEpisode | null = null;
  const start = (): OkfTrailEpisode => ({
    articles: [],
    head: [],
    body: [],
    areaSearches: 0,
    filesOpened: 0,
  });
  for (const item of items) {
    if (
      current === null ||
      (item.op === 'kb_read' && current.body.length > 0)
    ) {
      current = start();
      episodes.push(current);
    }
    if (current.body.length === 0 && isKbItem(item)) {
      current.head.push(item);
      if (item.op === 'kb_read' && !current.articles.includes(item.path)) {
        current.articles.push(item.path);
      }
    } else {
      current.body.push(item);
    }
  }
  return episodes.map(summarise);
}

/** What happened to a new code path of a KB read: the call that first touched it, if any. */
export function pointerFate(
  read: OkfTrailItem,
  pointer: string,
  byOrd: ReadonlyMap<number, OkfTrailItem>,
): { ord: number; verb: 'opened' | 'searched' | 'used' } | null {
  const ord = read.followedAt?.[pointer];
  if (ord === undefined) return null;
  const by = byOrd.get(ord);
  const verb =
    by?.op === 'read' ? 'opened' : by?.op === 'search' ? 'searched' : 'used';
  return { ord, verb };
}

/** Call number → its first item (for `pointerFate`). */
export function itemsByOrd(
  items: readonly OkfTrailItem[],
): Map<number, OkfTrailItem> {
  const out = new Map<number, OkfTrailItem>();
  for (const item of items) if (!out.has(item.ord)) out.set(item.ord, item);
  return out;
}

/** "lines 1–120" / "from line 10" / "last 20 lines" of a ranged read, else null. */
export function rangeText(item: OkfTrailItem): string | null {
  if (item.offset === undefined) return null;
  if (item.offset < 0) return `last ${-item.offset} lines`;
  if (item.limit === undefined) return `from line ${item.offset}`;
  return `lines ${item.offset}–${item.offset + item.limit - 1}`;
}

/** The op word shown in a trail row. */
export function opWord(item: OkfTrailItem): string {
  switch (item.op) {
    case 'kb_read':
    case 'read':
      return 'read';
    case 'kb_search':
    case 'search':
      return 'search';
    default:
      return 'write';
  }
}
