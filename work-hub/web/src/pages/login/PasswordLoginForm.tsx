import { Loader2, LogIn } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { ApiError, login } from "../../api/auth";
import { useAuth } from "../../auth/AuthContext";
import { ROUTE, returnPath } from "../../routes";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import { Input } from "../../ui/input";
import {
  SMTP_NOT_CONFIGURED_HINT,
  type ForgotPasswordLinkState,
} from "./forgot-password-link";
import { cn } from "../../lib/cn";
import styles from "./login.module.css";

/** Seconds to wait after a 429 (`Retry-After`); at least 1 so the button re-enables on its own. */
function retryDelaySeconds(err: ApiError): number {
  const raw = err.retryAfterSeconds;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 1;
  return Math.ceil(raw);
}

/** Modes `password` and `password-confirm`. */
export function PasswordLoginForm({
  forgotPassword,
}: {
  forgotPassword: ForgotPasswordLinkState;
}) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seconds left on the server's brute-force delay (429): the button stays disabled meanwhile.
  const [delaySeconds, setDelaySeconds] = useState(0);

  useEffect(() => {
    if (delaySeconds <= 0) return;
    const timer = setTimeout(
      () => setDelaySeconds((left) => Math.max(0, left - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [delaySeconds]);

  if (user != null) return <Navigate to={ROUTE.workspaces} replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const profile = await login(email, password);
      setUser(profile);
      void navigate(returnPath(location.state), { replace: true });
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.statusCode === 403 &&
        err.code === "email_not_confirmed"
      ) {
        setError(
          "Please confirm your email address first — check your inbox for the confirmation link.",
        );
      } else if (err instanceof ApiError && err.statusCode === 429) {
        // The server did not check the credentials this time: only the wait is shown.
        setDelaySeconds(retryDelaySeconds(err));
      } else if (err instanceof ApiError && err.statusCode === 401) {
        setError("Invalid email or password.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className={styles.card}>
      <CardHeader>
        <CardTitle>Log in</CardTitle>
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
            autoComplete="current-password"
          />
          {forgotPassword === "active" && (
            <button
              type="button"
              className={styles.forgotLink}
              onClick={() => void navigate(ROUTE.forgotPassword)}
            >
              Forgot password?
            </button>
          )}
          {forgotPassword === "disabled" && (
            <div className={styles.forgotDisabledGroup}>
              <button
                type="button"
                disabled
                aria-describedby="forgot-password-hint"
                className={styles.forgotLinkDisabled}
              >
                Forgot password?
              </button>
              <p id="forgot-password-hint" className={styles.forgotHint}>
                {SMTP_NOT_CONFIGURED_HINT}
              </p>
            </div>
          )}
          {error && <p className={styles.errorText}>{error}</p>}
          {delaySeconds > 0 && (
            <div role="alert" className={styles.delayAlert}>
              <p className={styles.delayTitle}>Too many attempts</p>
              <p className={styles.delayText}>
                Please wait {delaySeconds}s before trying again.
              </p>
            </div>
          )}
        </CardContent>
        <CardFooter className={styles.footer}>
          <Button
            type="submit"
            className={styles.fullWidth}
            disabled={isLoading || delaySeconds > 0}
          >
            {isLoading ? (
              <Loader2 className={cn(styles.buttonIcon, styles.spin)} />
            ) : (
              <LogIn className={styles.buttonIcon} />
            )}
            Log in
          </Button>
          <p className={styles.mutedText}>
            Don&apos;t have an account?{" "}
            <button
              type="button"
              className={styles.inlineLink}
              onClick={() => void navigate(ROUTE.signup)}
            >
              Sign up
            </button>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
