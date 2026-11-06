/**
 * The two titled sections of the OKF tabs (2026-11-05): "A · How the KB was navigated
 * (verified)" — structure, counted from tool calls — and "B · Did the articles help?
 * (heuristic — check by hand)" — value proxies. `OkfSignalsSection` is section B's frame with
 * the "N signals to check" count and the intro line.
 */
import type { ReactNode } from 'react';
import { okfCount } from '@/lib/okf/okf-check-text';
import type { OkfSignalSummary } from '../../../../../models/repositories';

export function OkfSection({
  title,
  aside,
  testId,
  children,
}: {
  title: string;
  /** Muted text right after the title (a count). */
  aside?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} className="space-y-2">
      <h3 className="flex flex-wrap items-baseline gap-x-2 border-b border-border pb-1 text-sm font-semibold">
        <span data-testid="okf-section-title">{title}</span>
        {aside ? (
          <span className="text-xs font-normal text-muted-foreground">
            {aside}
          </span>
        ) : null}
      </h3>
      {children}
    </section>
  );
}

export const OKF_SECTION_A_TITLE = 'A · How the KB was navigated (verified)';
export const OKF_SECTION_B_TITLE =
  'B · Did the articles help? (heuristic — check by hand)';

/** Section B's count on the session tab: non-zero value signals; null on an older server. */
export function okfSessionSignalCount(
  signals: OkfSignalSummary | undefined,
): number | null {
  if (!signals) return null;
  return (
    signals.searchedAfterPairs +
    signals.routingMissArticles +
    signals.deadPointers
  );
}

/** Section B: title, "N signals to check" / "nothing to check", the intro line, the content. */
export function OkfSignalsSection({
  count,
  children,
}: {
  /** Non-zero value signals; null when the server sent none (older server). */
  count: number | null;
  children: ReactNode;
}) {
  return (
    <OkfSection
      testId="okf-section-b"
      title={OKF_SECTION_B_TITLE}
      aside={
        count === null ? undefined : (
          <span data-testid="okf-section-b-count">
            {count > 0
              ? `${okfCount(count, 'signal', 'signals')} to check`
              : 'nothing to check'}
          </span>
        )
      }
    >
      <p
        data-testid="okf-section-b-intro"
        className="max-w-4xl text-[11px] text-muted-foreground"
      >
        Proxies from what agents did after reading — they cannot know what a
        search was about; open the agent and judge the search patterns yourself.
      </p>
      {children}
    </OkfSection>
  );
}
