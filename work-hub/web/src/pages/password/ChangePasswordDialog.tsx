import { Check, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import {
  ApiError,
  changePassword,
  type ChangePasswordResult,
} from "../../api/auth";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import styles from "./password.module.css";

interface Props {
  /** Shown in the success state's notification note. */
  email: string;
  onClose: () => void;
}

function mapChangePasswordError(err: unknown): string {
  if (err instanceof ApiError) {
    // 403, not 401: a wrong current password must not look like an expired session.
    if (err.code === "invalid_current_password") {
      return "Current password is incorrect.";
    }
    if (err.code === "weak_password") {
      return err.message || "Password does not meet the strength requirements.";
    }
    if (err.code === "password_mismatch") return "New passwords do not match.";
    return err.message || "Could not change the password.";
  }
  return "Something went wrong. Please try again.";
}

/** Change-password dialog, opened from the user menu in the password modes. */
export function ChangePasswordDialog({ email, onClose }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delivery, setDelivery] =
    useState<ChangePasswordResult["email_delivery"]>();

  const isDone = delivery !== undefined;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("New passwords do not match.");
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
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          {!isDone && (
            <DialogDescription>
              Requires your current password.
            </DialogDescription>
          )}
        </DialogHeader>

        {isDone ? (
          <div className={styles.done}>
            <span className={styles.doneBadge}>
              <Check className={styles.doneIcon} />
            </span>
            <p className={styles.doneTitle}>Password changed</p>
            {delivery === "sent" && (
              <div className={styles.notice}>
                <p className={styles.noticeTitle}>Email notification</p>
                <p className={styles.fieldLabel}>Sent to {email}</p>
              </div>
            )}
            <DialogFooter className={styles.fullWidth}>
              <Button type="button" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={(e) => void handleSubmit(e)}
            className={styles.dialogForm}
          >
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="current-password">
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
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="new-password">
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
            <div className={styles.field}>
              <label
                className={styles.fieldLabel}
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
            {error && <p className={styles.errorText}>{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading && <Loader2 className={styles.spinner} />}
                Change password
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
