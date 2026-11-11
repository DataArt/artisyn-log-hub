import { CATALOG } from './catalog.ts';
import type { CatalogEntry, MatchedItem, RecommendationRow, StartupFacts } from './types.ts';

/** Bytes descending (unmeasured last), ties in first-seen order (Array.prototype.sort is stable). */
function sortItems(items: MatchedItem[]): MatchedItem[] {
  return [...items].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

function sumBytes(items: MatchedItem[]): number | null {
  let total: number | null = null;
  for (const item of items) {
    if (item.bytes !== null) total = (total ?? 0) + item.bytes;
  }
  return total;
}

/**
 * Runs the catalog over a session's startup facts. Each entry yields at most one row; rows keep
 * catalog order.
 */
export function matchRecommendations(facts: StartupFacts, catalog: CatalogEntry[] = CATALOG): RecommendationRow[] {
  const rows: RecommendationRow[] = [];
  for (const entry of catalog) {
    const matched = entry.match(facts);
    if (!matched || matched.length === 0) continue;
    const items = sortItems(matched);
    const bytes = sumBytes(items);
    const tokens = bytes === null ? null : Math.round(bytes / facts.cpt);
    const share = tokens === null ? null : facts.denominator === 0 ? 0 : tokens / facts.denominator;
    rows.push({
      id: entry.id,
      title: entry.title,
      controller: entry.controller,
      explanation: entry.explanation,
      items,
      bytes,
      tokens,
      share,
      disableText: entry.disable.text,
      snippet: entry.disable.snippet?.(items) ?? null,
      docs: entry.docs,
      note: entry.note?.(items) ?? null,
    });
  }
  return rows;
}
