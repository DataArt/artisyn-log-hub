import { useState, type FormEvent } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { ApiError, changePassword } from '../../api';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';

interface Props {
  /** Shown in the success state's notification note. */
  email: string;
  onClose: () => void;
}

/**
 * Change-password dialog, opened from the user menu in the
 * `password` / `password-confirm` auth modes.
 */
export function ChangePasswordModal({ email, onClose }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<'sent' | 'failed' | 'skipped'>();

  const isDone = delivery !== undefined;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('New passwords do not match.');
      return;
    }

    setIsLoading(true);
    try {
      const result = await changePassword(currentPassword, password, confirm);
      setDelivery(result.email_delivery);
    } catch (err) {
      setError(mapChangePasswordError(err));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          {!isDone && (
            <DialogDescription>
              Requires your current password.
            </DialogDescription>
          )}
        </DialogHeader>

        {isDone ? (
          <div className="flex flex-col items-center gap-3 py-2">
            <span className="flex size-11 items-center justify-center rounded-full bg-primary/10">
              <Check className="size-5 text-primary" />
            </span>
            <p className="text-sm font-medium">Password changed</p>
            {delivery === 'sent' && (
              <div className="w-full rounded border border-border bg-muted/40 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                  Email notification
                </p>
                <p className="text-xs text-muted-foreground">Sent to {email}</p>
              </div>
            )}
            <DialogFooter className="w-full">
              <Button type="button" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="current-password"
              >
                Current password
              </label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoFocus
                autoComplete="current-password"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="new-password"
              >
                New password
              </label>
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="confirm-new-password"
              >
                Confirm new password
              </label>
              <Input
                id="confirm-new-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading && <Loader2 className="animate-spin size-4" />}
                Change password
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function mapChangePasswordError(err: unknown): string {
  if (err instanceof ApiError) {
    // 403 (not 401) — apiFetch force-logs-out on 401, so the server answers a
    // wrong current password with 403 invalid_current_password instead.
    if (err.code === 'invalid_current_password') {
      return 'Current password is incorrect.';
    }
    if (err.code === 'weak_password') {
      return err.message || 'Password does not meet the strength requirements.';
    }
    if (err.code === 'password_mismatch') {
      return 'New passwords do not match.';
    }
    return err.message || 'Could not change the password.';
  }
  return 'Something went wrong. Please try again.';
}
