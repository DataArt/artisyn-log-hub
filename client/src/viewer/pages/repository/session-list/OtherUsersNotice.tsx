import { Users } from 'lucide-react';
import type { HiddenByUser } from './session-list-helpers';

export interface OtherUsersNoticeProps {
  hidden: HiddenByUser[];
  onShowAll: () => void;
}

/**
 * Tells the owner of a personal repo which sessions the default "my sessions only" filter is
 * withholding, and offers a one-click reveal.
 *
 * Amber, not destructive red: nothing is wrong, the view is just narrower than the data. Renders
 * nothing when the filter hides nothing, so it stays invisible in the common single-identity case.
 */
export function OtherUsersNotice({ hidden, onShowAll }: OtherUsersNoticeProps) {
  if (hidden.length === 0) return null;
  const total = hidden.reduce((n, h) => n + h.count, 0);
  return (
    <div
      data-testid="other-users-notice"
      className="flex items-start gap-2 border-b border-border bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {total} session{total === 1 ? '' : 's'} hidden — uploaded under{' '}
        {hidden.map((h) => `${h.email} (${h.count})`).join(', ')}
      </span>
      <button
        type="button"
        onClick={onShowAll}
        className="shrink-0 font-medium underline hover:no-underline"
      >
        Show all
      </button>
    </div>
  );
}
