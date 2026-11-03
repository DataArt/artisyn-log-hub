/**
 * Session lenses (DD-7): a lens promotes the few session tabs that answer one question into the
 * single tab row, and moves every other visible tab into "More ▾", under its session group
 * header. The "All" lens puts every visible tab in the row (what does not fit the width goes to
 * More). The tab bar has exactly one level of tabs; the lens is a "View" select next to it.
 * Pure: no React, router or storage.
 */
import {
  tabRow,
  SESSION_GROUPS,
  type SessionGroup,
  type SessionTab,
} from '../../tab-ids';

export type LensId =
  | 'what-happened'
  | 'cost'
  | 'harness'
  | 'failed-tool'
  | 'all';

export interface LensDef {
  id: LensId;
  label: string;
  /** Tabs shown in the row, in this order; empty for `all` (every visible tab). */
  promoted: readonly SessionTab[];
  /** The tab a switch to this lens opens. */
  defaultTab: SessionTab;
}

/** All lenses, in select order. */
export const LENSES: readonly LensDef[] = [
  {
    id: 'what-happened',
    label: 'What happened',
    promoted: [
      'summary',
      'logs',
      'bash',
      'timeline',
      'agent-tree',
      'session-map',
      'change-surface',
    ],
    defaultTab: 'summary',
  },
  {
    id: 'cost',
    label: 'Cost',
    promoted: [
      'summary',
      'usage',
      'call-tree',
      'context-growth',
      'dashboard',
      'advisor',
      'otel',
    ],
    defaultTab: 'usage',
  },
  {
    id: 'harness',
    label: 'Harness & context',
    promoted: ['sysctx', 'context-usage', 'harness-usage', 'okf', 'info'],
    defaultTab: 'sysctx',
  },
  {
    id: 'failed-tool',
    label: 'Failed tool call',
    promoted: ['tools', 'logs', 'bash', 'tool-heatmap', 'otel'],
    defaultTab: 'tools',
  },
  { id: 'all', label: 'All tabs', promoted: [], defaultTab: 'summary' },
];

/** The lens used when neither the URL nor the remembered `session-lens` names one (FR-C3a). */
export const DEFAULT_LENS: LensId = 'cost';

/** The lens definition of `id`. */
export function lensDef(id: LensId): LensDef {
  return LENSES.find((l) => l.id === id) ?? LENSES[1];
}

/** A raw `lens=` value (or a stored one) as a lens id; `null` when it is not a known lens. */
export function parseLens(v: unknown): LensId | null {
  return LENSES.find((l) => l.id === v)?.id ?? null;
}

/** The group of a session tab, from its registry row. Unknown tabs fall back to `overview`. */
export function groupOf(tab: SessionTab): SessionGroup {
  return tabRow('session', tab)?.group ?? 'overview';
}

export interface LensRowResult {
  /** The promoted tabs that are visible, in lens order (every visible tab for `all`). */
  row: SessionTab[];
  /** The active tab when it is visible but not promoted — shown after a divider (c4). */
  extra: SessionTab | null;
  /** Every other visible tab, by group in `SESSION_GROUPS` order; empty groups dropped. */
  more: { group: SessionGroup; tabs: SessionTab[] }[];
}

/**
 * The tab row of `lens` for the `visible` tabs (in registry order). For `all` every visible tab
 * is in `row`, so nothing is extra or in More (tabs that do not fit the width still overflow
 * into More at render time).
 */
export function lensRow(
  lens: LensId,
  activeTab: SessionTab,
  visible: readonly SessionTab[],
): LensRowResult {
  if (lens === 'all') return { row: [...visible], extra: null, more: [] };
  const row = lensDef(lens).promoted.filter((t) => visible.includes(t));
  const extra =
    visible.includes(activeTab) && !row.includes(activeTab) ? activeTab : null;
  const rest = visible.filter((t) => !row.includes(t) && t !== extra);
  const more = SESSION_GROUPS.map((g) => ({
    group: g.id,
    tabs: rest.filter((t) => groupOf(t) === g.id),
  })).filter((g) => g.tabs.length > 0);
  return { row, extra, more };
}

/** The tab a switch to `lens` opens: its default tab, or `summary` when that one is hidden. */
export function lensDefaultTab(
  lens: LensId,
  visible: readonly SessionTab[],
): SessionTab {
  const tab = lensDef(lens).defaultTab;
  return visible.includes(tab) ? tab : 'summary';
}
