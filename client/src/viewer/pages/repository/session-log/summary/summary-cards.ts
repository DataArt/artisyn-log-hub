/**
 * Summary hub cards (DD-20, FR-D1–D4): the "Where to look next" block under the executive band.
 *
 * Pure: every figure comes from values the session pane has already loaded and the band already
 * shows (the derive, the token breakdown, the change-surface aggregate, the Bash collector and
 * the Turn-End advisor result) — no request, no lazy tab chunk and no new formula. Titles and
 * descriptions come from the tab registry, so a card always names its tab the way the bar does.
 */
import { tabRow, type SessionTab } from '../../../../tab-ids';
import type { LensId } from '../../session-lenses';
import type { ChangeSurfaceAggregate } from '../../../../../models/repositories';
import type { TokenBreakdown } from '../types';
import type { SessionSummaryDerived } from './session-summary-derive';

/** One card. `headline`/`subline` are display strings; `null` renders nothing in that slot. */
export interface SummaryCard {
  tab: SessionTab;
  title: string;
  /** The registry description — shown under the title of every card. */
  description: string;
  headline: string | null;
  subline: string | null;
  /** The tab has no data in this session (decided from loaded data only, FR-D3). */
  dimmed: boolean;
}

/** The text a dimmed card shows in place of its figures. */
export const NO_DATA_TEXT = 'No data in this session';

export interface SummaryCardsInput {
  /** The session cost the band's Cost tile shows; `null` when it cannot be computed. */
  sessionCost: number | null;
  /** Main-thread token breakdown (`parsedLogs.summary.tokenBreakdown`). */
  tokenBreakdown: Pick<TokenBreakdown, 'cacheRead' | 'output'> | null;
  derived: Pick<
    SessionSummaryDerived,
    | 'peakContextTokens'
    | 'contextWindowPct'
    | 'subAgentCount'
    | 'workflowCount'
    | 'delegationCostShare'
  >;
  /** Bash calls of the session tree (`collectBashCalls`); `undefined` = not known yet. */
  bashCount: number | undefined;
  /** The tree's change-surface aggregate; `null` = never computed or not fetched. */
  changeSurface: ChangeSurfaceAggregate | null;
  /** That aggregate's request is still in flight. */
  changeSurfaceLoading: boolean;
  /** The Turn-End advisor result; `null` omits the Advisor card. */
  advisor: { costFactors: string[]; harnessAdvice: string[] } | null;
}

const int = (n: number): string => n.toLocaleString('en-US');
const pct = (ratio: number | null): string =>
  ratio != null ? `${Math.round(ratio * 100)} %` : 'n/a';
const plural = (n: number, one: string, many: string): string =>
  `${int(n)} ${n === 1 ? one : many}`;

function card(
  tab: SessionTab,
  headline: string | null,
  subline: string | null,
  dimmed = false,
): SummaryCard {
  const row = tabRow('session', tab);
  return {
    tab,
    title: row?.label ?? tab,
    description: row?.description ?? '',
    headline: dimmed ? null : headline,
    subline: dimmed ? NO_DATA_TEXT : subline,
    dimmed,
  };
}

/** The cards in DD-20 order: 7, or 8 with an advisor result. */
export function buildSummaryCards(input: SummaryCardsInput): SummaryCard[] {
  const {
    sessionCost,
    tokenBreakdown,
    derived,
    bashCount,
    changeSurface,
    changeSurfaceLoading,
    advisor,
  } = input;
  const cards: SummaryCard[] = [];

  cards.push(
    card(
      'usage',
      sessionCost != null ? `$${sessionCost.toFixed(4)}` : 'n/a',
      tokenBreakdown
        ? `cache read ${int(tokenBreakdown.cacheRead)} · out ${int(tokenBreakdown.output)} tokens`
        : null,
    ),
  );

  const noUsage = derived.peakContextTokens == null;
  cards.push(
    card(
      'context-growth',
      noUsage ? null : `${int(derived.peakContextTokens ?? 0)} tokens peak`,
      `${pct(derived.contextWindowPct)} of window`,
      noUsage,
    ),
  );

  cards.push(
    card(
      'info',
      plural(derived.subAgentCount, 'sub-agent', 'sub-agents'),
      `${plural(derived.workflowCount, 'workflow', 'workflows')} · ${pct(derived.delegationCostShare)} of cost`,
    ),
  );

  if (changeSurfaceLoading) {
    cards.push(card('change-surface', null, 'Loading…'));
  } else {
    const files =
      changeSurface?.computed === true ? changeSurface.changedFiles : 0;
    cards.push(
      card(
        'change-surface',
        plural(files, 'changed file', 'changed files'),
        changeSurface
          ? `${plural(changeSurface.foldersTouched, 'folder', 'folders')} · +${int(changeSurface.linesAdded)} / −${int(changeSurface.linesRemoved)} lines`
          : null,
        files === 0,
      ),
    );
  }

  cards.push(
    card(
      'bash',
      bashCount != null ? plural(bashCount, 'call', 'calls') : null,
      null,
      bashCount === 0,
    ),
  );

  if (advisor) {
    const factors = advisor.costFactors.length;
    const tips = advisor.harnessAdvice.length;
    // The advisor result carries no severity field; its two finding lists stand in for it.
    cards.push(
      card(
        'advisor',
        plural(factors + tips, 'finding', 'findings'),
        `${plural(factors, 'cost factor', 'cost factors')} · ${plural(tips, 'harness tip', 'harness tips')}`,
      ),
    );
  }

  // Their data sits behind the tab's own query (FR-D3): description only, never dimmed.
  cards.push(card('tools', null, null));
  cards.push(card('okf', null, null));

  return cards;
}

/** One "Explore" chip (DD-20): a question that switches to a lens and its default tab. */
export interface ExploreChip {
  lens: LensId;
  label: string;
}

/** The four Explore chips, in display order. */
export const EXPLORE_CHIPS: readonly ExploreChip[] = [
  { lens: 'cost', label: 'Why so expensive?' },
  { lens: 'what-happened', label: 'What happened?' },
  { lens: 'harness', label: 'What gets loaded?' },
  { lens: 'failed-tool', label: 'Which tool failed?' },
];
