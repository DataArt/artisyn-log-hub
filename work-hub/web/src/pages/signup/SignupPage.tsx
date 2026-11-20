import { Loader2, Mail, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { ApiError, resendConfirmation, signup } from "../../api/auth";
import { useAuth } from "../../auth/AuthContext";
import { useAuthConfig } from "../../auth/useAuthConfig";
import { useCooldown } from "../../auth/useCooldown";
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
import styles from "./SignupPage.module.css";

/** Log Hub's maximum password length (characters). */
const PASSWORD_MAX_LEN = 128;

type Pending = "none" | "check-email" | "delivery-failed";

/** Sign-up (password modes); in `password-confirm` it ends on "check your email". */
export function SignupPage() {
  const { user, setUser } = useAuth();
  const { data: config } = useAuthConfig();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>("none");
  const [resendError, setResendError] = useState<string | null>(null);
  const { secondsLeft, start } = useCooldown();

  if (user != null && pending === "none") {
    return <Navigate to={ROUTE.workspaces} replace />;
  }

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
      const profile = await signup(email, password, confirm);
      if (profile.email_delivery === "sent") {
        setPending("check-email");
      } else if (profile.email_delivery === "failed") {
        setPending("delivery-failed");
      } else {
        setUser(profile);
        void navigate(ROUTE.workspaces);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "weak_password") {
        setConfirmError(
          err.message || "Password does not meet the strength requirements.",
        );
      } else if (
        err instanceof ApiError &&
        err.code === "email_domain_not_allowed"
      ) {
        setError(
          err.message || "Sign-up is not allowed for this email domain.",
        );
      } else if (err instanceof ApiError && err.statusCode === 409) {
        setError(err.message || "An account with this email already exists.");
      } else if (err instanceof ApiError) {
        setError(err.message || "Something went wrong. Please try again.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleResend() {
    setResendError(null);
    try {
      const result = await resendConfirmation(email);
      if (result.email_delivery === "failed") {
        setPending("delivery-failed");
      } else {
        start(60);
      }
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 429) {
        start(err.retryAfterSeconds ?? 60);
      } else {
        setResendError(
          "Could not resend the confirmation email. Please try again.",
        );
      }
    }
  }

  if (pending !== "none") {
    return (
      <AuthPageShell>
        <Card className={styles.card}>
          <CardHeader>
            <CardTitle>Create account</CardTitle>
          </CardHeader>
          <CardContent className={styles.content}>
            {pending === "check-email" ? (
              <p className={styles.mutedText}>
                Check your email to confirm your account.
              </p>
            ) : (
              <p className={styles.errorText}>
                There&apos;s a temporary issue sending email
                {config?.adminContactEmail ? (
                  <>
                    {" "}
                    — please contact your administrator at{" "}
                    {config.adminContactEmail}.
                  </>
                ) : (
                  <>. Please try again shortly.</>
                )}
              </p>
            )}
            {resendError && <p className={styles.errorText}>{resendError}</p>}
          </CardContent>
          <CardFooter className={styles.footer}>
            <Button
              type="button"
              variant="outline"
              className={styles.fullWidth}
              disabled={secondsLeft > 0}
              onClick={() => void handleResend()}
            >
              <Mail className={styles.buttonIcon} />
              {secondsLeft > 0
                ? `Resend confirmation email (${secondsLeft}s)`
                : "Resend confirmation email"}
            </Button>
            <button
              type="button"
              className={styles.backLink}
              onClick={() => void navigate(ROUTE.login)}
            >
              Back to log in
            </button>
          </CardFooter>
        </Card>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <Card className={styles.card}>
        <CardHeader>
          <CardTitle>Create account</CardTitle>
        </CardHeader>
        <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
          <CardContent className={styles.content}>
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
            <div className={styles.field}>
              <Input
                type="password"
                placeholder="Confirm password"
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
                <UserPlus className={styles.buttonIcon} />
              )}
              Sign up
            </Button>
            <p className={styles.mutedText}>
              Already have an account?{" "}
              <button
                type="button"
                className={styles.inlineLink}
                onClick={() => void navigate(ROUTE.login)}
              >
                Log in
              </button>
            </p>
          </CardFooter>
        </form>
      </Card>
    </AuthPageShell>
  );
}
