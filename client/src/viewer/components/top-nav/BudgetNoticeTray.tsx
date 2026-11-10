import type { UIEvent } from 'react';
import { Wallet } from 'lucide-react';
import type { BudgetNoticeDto } from '../../../models/budgets';
import {
  budgetNoticePeriodLabel,
  budgetNoticeToneClass,
  formatNoticeTime,
  type useBudgetNotices,
} from '../../hooks/useBudgetNotices';
import { formatUsdMicros } from '../../pages/budgets/budget-format';

type BudgetNotices = ReturnType<typeof useBudgetNotices>;

/**
 * The budget notices section of the bell panel (DD-18): newest first, older pages load on
 * scroll, a row opens its Spend view and marks it read, "Mark all read" posts `{all: true}`.
 */
export function BudgetNoticeTray({
  notices,
  onOpen,
}: {
  notices: BudgetNotices;
  /** Called after a row was opened (the bell closes its panel). */
  onOpen: () => void;
}) {
  const { query, notices: items, unreadCount, markRead, openNotice } = notices;

  const onScroll = (e: UIEvent<HTMLUListElement>) => {
    const el = e.currentTarget;
    if (
      el.scrollTop + el.clientHeight >= el.scrollHeight - 24 &&
      query.hasNextPage &&
      !query.isFetchingNextPage
    ) {
      void query.fetchNextPage();
    }
  };

  return (
    <div className="border-t border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <p className="text-sm font-medium">Budget notices</p>
        {unreadCount > 0 && (
          <button
            type="button"
            className="text-xs text-primary hover:underline disabled:opacity-50"
            onClick={() => markRead.mutate({ all: true })}
            disabled={markRead.isPending}
            data-testid="budget-notice-mark-all"
          >
            Mark all read
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground text-center">
          {query.isLoading ? 'Loading…' : 'No budget notices'}
        </p>
      ) : (
        <ul className="max-h-80 overflow-y-auto" onScroll={onScroll}>
          {items.map((n) => (
            <NoticeRow
              key={n.id}
              notice={n}
              onClick={() => {
                openNotice(n);
                onOpen();
              }}
            />
          ))}
          {query.isFetchingNextPage && (
            <li className="px-3 py-2 text-xs text-muted-foreground text-center">
              Loading older notices…
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function NoticeRow({
  notice,
  onClick,
}: {
  notice: BudgetNoticeDto;
  onClick: () => void;
}) {
  return (
    <li className="border-b border-border last:border-0">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
        onClick={onClick}
        data-testid="budget-notice-row"
        data-read={notice.read ? 'true' : 'false'}
      >
        <Wallet className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${budgetNoticeToneClass(notice.threshold)}`}
            >
              {notice.threshold} %
            </span>
            <span className="truncate text-sm">{notice.scopeLabel}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            {notice.budgetLabel} · {formatUsdMicros(notice.spendMicros)} of{' '}
            {formatUsdMicros(notice.amountMicros)}
          </span>
          <span className="text-xs text-muted-foreground">
            {budgetNoticePeriodLabel(notice)} ·{' '}
            {formatNoticeTime(notice.createdAt)}
          </span>
        </span>
        {!notice.read && (
          <span
            className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-500"
            aria-label="Unread"
          />
        )}
      </button>
    </li>
  );
}
