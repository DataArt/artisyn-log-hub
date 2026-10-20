import type {
  AiToolVersionHistoryEntry,
  ReleaseVersions,
} from './ai-tool-versions.types';

export interface ReleaseVersionsAt extends ReleaseVersions {
  /** ISO timestamp of the history entry the versions came from. */
  effectiveFrom: string;
}

/**
 * Picks the release versions that were current at `startIso`: the newest history entry
 * with `effectiveFrom <= startIso`. `history` must be in ascending `effectiveFrom` order.
 * Returns `null` when no entry qualifies or `startIso` is unparseable.
 */
export function pickReleaseVersionsAt(
  history: readonly AiToolVersionHistoryEntry[],
  startIso: string,
): ReleaseVersionsAt | null {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const effective = Date.parse(entry.effectiveFrom);
    if (!Number.isNaN(effective) && effective <= start) {
      return {
        latest: entry.versions.latest,
        stable: entry.versions.stable,
        effectiveFrom: entry.effectiveFrom,
      };
    }
  }
  return null;
}
