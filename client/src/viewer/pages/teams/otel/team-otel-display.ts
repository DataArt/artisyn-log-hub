/**
 * Pure display shaping of the team OTEL tab (2026-10-30 otel-tabs-traces, DD-29): the facts
 * route keys person / repository buckets by id, so the chart gets them relabelled to the e-mail /
 * repository URL; people beyond the top `OTEL_TEAM_TOP_PEOPLE` by cost are folded into
 * "others (N)" in the chart and the cost flow (the People table lists everyone).
 */
import type { OtelBucket, OtelFlowRow } from '../../../../models/repositories';
import type {
  TeamOtelFactsResponse,
  TeamOtelStackBy,
} from '../../../../models/teams';
import { OTEL_TEAM_TOP_PEOPLE } from '../../repository/otel/otel.constants';

/** The top people's e-mails (by cost, the People rows' order) and the folded label. */
export interface OtelTeamPeopleFold {
  top: ReadonlySet<string>;
  /** `others (N)`, or null when nobody is folded. */
  othersLabel: string | null;
}

export function otelTeamPeopleFold(
  facts: Pick<TeamOtelFactsResponse, 'people'>,
  limit: number = OTEL_TEAM_TOP_PEOPLE,
): OtelTeamPeopleFold {
  const top = new Set(facts.people.slice(0, limit).map((p) => p.email));
  const rest = facts.people.length - top.size;
  return { top, othersLabel: rest > 0 ? `others (${rest})` : null };
}

/** The display key of one bucket key for a stack-by. */
export function otelTeamDisplayKey(
  facts: Pick<TeamOtelFactsResponse, 'people' | 'filterOptions'>,
  fold: OtelTeamPeopleFold,
  stackBy: TeamOtelStackBy,
  key: string,
): string {
  if (key === '') return key;
  if (stackBy === 'person') {
    const id = Number(key);
    const email =
      facts.people.find((p) => p.userId === id)?.email ??
      facts.filterOptions.people.find((p) => p.userId === id)?.email ??
      `user #${key}`;
    return fold.top.has(email) || fold.othersLabel === null
      ? email
      : fold.othersLabel;
  }
  if (stackBy === 'repository') {
    const id = Number(key);
    return (
      facts.filterOptions.repositories.find((r) => r.repoId === id)?.repoUrl ??
      `repository #${key}`
    );
  }
  return key;
}

/** The buckets with display keys, plus a map from a raw `start|key` to its display one. */
export function otelTeamDisplayBuckets(
  facts: TeamOtelFactsResponse,
  stackBy: TeamOtelStackBy,
): { buckets: OtelBucket[]; displayKeyOf: (key: string) => string } {
  const fold = otelTeamPeopleFold(facts);
  const cache = new Map<string, string>();
  const displayKeyOf = (key: string): string => {
    let k = cache.get(key);
    if (k === undefined) {
      k = otelTeamDisplayKey(facts, fold, stackBy, key);
      cache.set(key, k);
    }
    return k;
  };
  return {
    buckets: facts.buckets.map((b) => ({ ...b, key: displayKeyOf(b.key) })),
    displayKeyOf,
  };
}

/** Highlighted `start|key` ids rewritten to display keys. */
export function otelTeamDisplayNewKeys(
  keys: ReadonlySet<string>,
  displayKeyOf: (key: string) => string,
): Set<string> {
  const out = new Set<string>();
  for (const id of keys) {
    const bar = id.indexOf('|');
    if (bar === -1) continue;
    out.add(`${id.slice(0, bar)}|${displayKeyOf(id.slice(bar + 1))}`);
  }
  return out;
}

/** Cost flow rows with people outside the top folded into "others (N)". */
export function otelTeamDisplayFlows(
  flows: readonly OtelFlowRow[],
  fold: OtelTeamPeopleFold,
): OtelFlowRow[] {
  if (fold.othersLabel === null) return [...flows];
  const label = fold.othersLabel;
  return flows.map((f) =>
    f.other || f.userEmail === null || fold.top.has(f.userEmail)
      ? f
      : { ...f, userEmail: label },
  );
}
