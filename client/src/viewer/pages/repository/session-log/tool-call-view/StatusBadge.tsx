import { cn } from '../../../../lib/cn';
import type { ToolCallDetail, ToolCallStatus } from '../types';

const BADGE = 'rounded px-1.5 py-0.5 text-xs font-mono whitespace-nowrap';
const PERMISSION = 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300';

/** `toolDenialKind` → badge tooltip (DD-3); unknown kinds get no tooltip. */
const DENIAL_KIND_TITLE: Record<string, string> = {
  'user-rejected': 'rejected by the user',
  'permission-rule': 'blocked by a permission rule',
  'automode-blocked': 'blocked by auto mode',
};

export function denialKindTitle(kind: string | undefined): string | undefined {
  return kind ? DENIAL_KIND_TITLE[kind] : undefined;
}

type BadgeCall = Pick<
  ToolCallDetail,
  | 'status'
  | 'interrupted'
  | 'denialKind'
  | 'permissionRequested'
  | 'permissionDenied'
>;

/**
 * The one status + permission badge renderer for tool-call rows and headers (DD-3):
 * `⚠ denied` / `⚠ requested` (permission events), then `✗ error`, `⊘ rejected` /
 * `⏸ interrupted`, `output not captured` or — only with `showOk` — `✓ ok`.
 */
export function StatusBadge({
  call,
  showOk = false,
  className,
}: {
  call: BadgeCall;
  showOk?: boolean;
  className?: string;
}) {
  const permission = call.permissionDenied
    ? '⚠ denied'
    : call.permissionRequested
      ? '⚠ requested'
      : null;
  const status = statusBadge(call, showOk);
  if (!permission && !status) return null;
  return (
    <span
      className={cn('inline-flex items-center gap-1', className)}
      data-testid="tool-status-badge"
    >
      {permission && (
        <span className={cn(BADGE, PERMISSION)}>{permission}</span>
      )}
      {status}
    </span>
  );
}

function statusBadge(call: BadgeCall, showOk: boolean) {
  switch (call.status) {
    case 'error':
      return (
        <span
          className={cn(BADGE, 'bg-red-500/20 text-red-700 dark:text-red-300')}
        >
          ✗ error
        </span>
      );
    case 'rejected':
      return (
        <span
          className={cn(
            BADGE,
            'bg-amber-500/20 text-amber-700 dark:text-amber-300',
          )}
          title={denialKindTitle(call.denialKind)}
        >
          {call.interrupted ? '⏸ interrupted' : '⊘ rejected'}
        </span>
      );
    case 'missing':
      return (
        <span className={cn(BADGE, 'bg-muted text-muted-foreground')}>
          output not captured
        </span>
      );
    default:
      return showOk ? (
        <span
          className={cn(
            BADGE,
            'bg-green-500/20 text-green-700 dark:text-green-300',
          )}
        >
          ✓ ok
        </span>
      ) : null;
  }
}

/**
 * The compact mark before a Files / Skills row (DD-21): red `✗` for an error, amber `⊘` for a
 * rejection, nothing otherwise.
 */
export function StatusMark({
  status,
  title,
}: {
  status: ToolCallStatus | undefined;
  title?: string;
}) {
  if (status === 'error')
    return (
      <span
        className="shrink-0 font-mono text-xs text-red-600 dark:text-red-400"
        title={title}
        data-testid="tool-status-mark"
      >
        ✗
      </span>
    );
  if (status === 'rejected')
    return (
      <span
        className="shrink-0 font-mono text-xs text-amber-600 dark:text-amber-400"
        title={title}
        data-testid="tool-status-mark"
      >
        ⊘
      </span>
    );
  return null;
}
