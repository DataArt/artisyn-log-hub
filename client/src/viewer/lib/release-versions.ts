import type {
  AiToolVersionHistoryEntry,
  ReleaseVersions,
} from '../../models/ai-tool-versions';

/** Release versions current at a session's start, plus when they were first recorded. */
export interface ReleaseVersionsAtStart extends ReleaseVersions {
  /** ISO timestamp of the history entry the versions came from. */
  effectiveFrom: string;
}

/**
 * Picks the release versions that were current at `startIso`: the newest history entry
 * with `effectiveFrom <= startIso`. `history` must be in ascending `effectiveFrom` order.
 * Returns `null` when no entry qualifies or `startIso` is unparseable.
 * Mirrors server/src/ai-tool-versions/release-at.ts.
 */
export function pickReleaseVersionsAt(
  history: readonly AiToolVersionHistoryEntry[],
  startIso: string,
): ReleaseVersionsAtStart | null {
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
