/**
 * The caller's budget notices, shared by the bell tray and the global banner
 * (2026-11-05 budgets-threshold-alerts, DD-18). Both use the same `['budget-notices']`
 * infinite query, so marking a notice read in one updates the other.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchBudgetNotices, markBudgetNoticesRead } from '../api';
import type { BudgetNoticeDto } from '../../models/budgets';
import {
  BUDGET_LIMITS,
  browserTimeZone,
  budgetNoticePath,
} from '../pages/budgets/budget-format';
import { formatSpendPeriodLabel } from '../pages/spend/spend-format';

export const BUDGET_NOTICES_QUERY_KEY = ['budget-notices'] as const;

export function useBudgetNotices() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const query = useInfiniteQuery({
    queryKey: BUDGET_NOTICES_QUERY_KEY,
    queryFn: ({ pageParam, signal }) =>
      fetchBudgetNotices(
        { before: pageParam, limit: BUDGET_LIMITS.noticesPage.default },
        signal,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });

  const notices: BudgetNoticeDto[] =
    query.data?.pages.flatMap((p) => p.items) ?? [];
  const unreadCount = query.data?.pages[0]?.unreadCount ?? 0;

  const markRead = useMutation({
    mutationFn: markBudgetNoticesRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: BUDGET_NOTICES_QUERY_KEY,
      });
    },
  });

  /** Marks the notice read (when unread) and opens its Spend view. */
  const openNotice = useCallback(
    (notice: BudgetNoticeDto) => {
      if (!notice.read) markRead.mutate({ ids: [notice.id] });
      const path = budgetNoticePath(notice.link);
      if (path !== null) void navigate(path);
    },
    [markRead, navigate],
  );

  return { query, notices, unreadCount, markRead, openNotice };
}

/** DD-18 colours: amber below 100 %, red at 100 % and above. */
export function budgetNoticeToneClass(threshold: number): string {
  return threshold >= 100
    ? 'bg-red-50 text-red-700 ring-1 ring-red-100'
    : 'bg-amber-50 text-amber-700 ring-1 ring-amber-100';
}

/**
 * The period label of a notice in the viewer's time zone. The notice carries no time zone,
 * so both bounds are moved 12 h inwards first: the label stays right for any viewer whose
 * zone is within 12 h of the budget's.
 */
export function budgetNoticePeriodLabel(notice: BudgetNoticeDto): string {
  const HALF_DAY = 12 * 3_600_000;
  const s = Date.parse(notice.periodStart);
  const e = Date.parse(notice.periodEnd);
  if (Number.isNaN(s) || Number.isNaN(e)) return '';
  return formatSpendPeriodLabel(
    notice.period,
    new Date(s + HALF_DAY).toISOString(),
    new Date(e - HALF_DAY).toISOString(),
    browserTimeZone(),
  );
}

/** The notice's creation time in the browser time zone, e.g. `10 Nov, 14:05`. */
export function formatNoticeTime(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
