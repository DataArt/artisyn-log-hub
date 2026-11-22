import { X } from 'lucide-react';
import { Button } from '../../../ui/button';

/**
 * Result of the last create-user / resend-link action on the Users tab, shown
 * until the admin dismisses it (the client has no toast component).
 */
export interface AdminUsersNoticeValue {
  tone: 'success' | 'warning';
  text: string;
}

const TONE_CLASSES: Record<AdminUsersNoticeValue['tone'], string> = {
  success: 'border-success/50 bg-success/10 text-success',
  warning:
    'border-warning/50 bg-warning/15 text-warning-foreground dark:bg-warning/20 dark:text-warning',
};

interface Props {
  notice: AdminUsersNoticeValue;
  onDismiss: () => void;
}

export function AdminUsersNotice({ notice, onDismiss }: Props) {
  return (
    <div
      role="status"
      data-testid="admin-users-notice"
      data-tone={notice.tone}
      className={`flex max-w-2xl items-start gap-2 rounded-md border px-3 py-2 text-sm ${TONE_CLASSES[notice.tone]}`}
    >
      <span className="flex-1">{notice.text}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss notice"
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}
