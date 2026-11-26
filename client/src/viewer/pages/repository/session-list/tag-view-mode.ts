import type { RepositorySession } from '../../../../models/repositories';
import {
  tagValuesOf,
  UNTAGGED_GROUP,
  UNTAGGED_LABEL,
} from '../../../lib/session-tags';

/** The session list's "By tag: <key>" view mode (2026-11-24 otel-session-tags, FR-6). */
export type TagViewMode = `tag:${string}`;

const PREFIX = 'tag:';

export function isTagViewMode(mode: string): mode is TagViewMode {
  return mode.startsWith(PREFIX) && mode.length > PREFIX.length;
}

export function tagViewMode(key: string): TagViewMode {
  return `${PREFIX}${key}`;
}

/** The grouped key of a tag view mode, `null` for any other mode. */
export function tagViewModeKey(mode: string): string | null {
  return isTagViewMode(mode) ? mode.slice(PREFIX.length) : null;
}

export interface TagGroup {
  /** The value, or `UNTAGGED_GROUP` for sessions without the key. */
  groupKey: string;
  label: string;
  sessions: RepositorySession[];
}

/**
 * Groups by the values of one tag key (FR-6): a session with several values of the key sits in
 * each of their groups (fan-out); sessions without the key form "(untagged)", always last.
 * Value groups are ordered by session count desc, then value asc.
 */
export function groupSessionsByTag(
  sessions: readonly RepositorySession[],
  key: string,
): TagGroup[] {
  const map = new Map<string, RepositorySession[]>();
  const untagged: RepositorySession[] = [];
  for (const s of sessions) {
    const values = tagValuesOf(s.tags, key);
    if (values.length === 0) {
      untagged.push(s);
      continue;
    }
    for (const v of values) {
      const group = map.get(v);
      if (group) group.push(s);
      else map.set(v, [s]);
    }
  }
  const groups: TagGroup[] = [...map]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([value, group]) => ({
      groupKey: value,
      label: value,
      sessions: group,
    }));
  if (untagged.length > 0) {
    groups.push({
      groupKey: UNTAGGED_GROUP,
      label: UNTAGGED_LABEL,
      sessions: untagged,
    });
  }
  return groups;
}
