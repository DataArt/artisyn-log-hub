import { KeyRound, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ApiError, resetPassword } from "../../api/auth";
import { ROUTE } from "../../routes";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import { Input } from "../../ui/input";
import { AuthPageShell } from "../AuthPageShell";
import { cn } from "../../lib/cn";
import styles from "./password.module.css";

const PASSWORD_MAX_LEN = 128;

/** `#/reset-password?token=…` from the reset email. */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setConfirmError(null);

    if (password.length > PASSWORD_MAX_LEN) {
      setConfirmError(
        `Password must be at most ${PASSWORD_MAX_LEN} characters.`,
      );
      return;
    }
    if (password !== confirm) {
      setConfirmError("Passwords do not match.");
      return;
    }

    setIsLoading(true);
    try {
      await resetPassword(token, password, confirm);
      void navigate(ROUTE.login);
    } catch (err) {
      if (err instanceof ApiError && err.code === "weak_password") {
        setConfirmError(
          err.message || "Password does not meet the strength requirements.",
        );
      } else if (err instanceof ApiError && err.code === "password_mismatch") {
        setConfirmError("Passwords do not match.");
      } else if (err instanceof ApiError) {
        setError(err.message || "Reset link is invalid or has expired.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <AuthPageShell>
      <Card className={styles.card}>
        <CardHeader>
          <CardTitle>Reset password</CardTitle>
        </CardHeader>
        <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
          <CardContent className={styles.content}>
            <Input
              type="password"
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
            <div className={styles.field}>
              <Input
                type="password"
                placeholder="Confirm new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
              />
              {confirmError && (
                <p className={styles.errorText}>{confirmError}</p>
              )}
            </div>
            {error && <p className={styles.errorText}>{error}</p>}
          </CardContent>
          <CardFooter className={styles.footer}>
            <Button
              type="submit"
              className={styles.fullWidth}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className={cn(styles.buttonIcon, styles.spin)} />
              ) : (
                <KeyRound className={styles.buttonIcon} />
              )}
              Reset password
            </Button>
            <button
              type="button"
              className={styles.backLink}
              onClick={() => void navigate(ROUTE.login)}
            >
              Back to log in
            </button>
          </CardFooter>
        </form>
      </Card>
    </AuthPageShell>
  );
}
