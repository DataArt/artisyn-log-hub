import { Loader2, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { forgotPassword } from "../../api/auth";
import { useAuthConfig } from "../../auth/useAuthConfig";
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
import { SMTP_NOT_CONFIGURED_HINT } from "../login/forgot-password-link";
import { cn } from "../../lib/cn";
import styles from "./password.module.css";

/** Asks for a reset link; the answer never says whether the email is registered. */
export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // While the config loads or fails the form stays enabled.
  const { data: config } = useAuthConfig();
  const resetUnavailable = config?.passwordResetAvailable === false;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    try {
      await forgotPassword(email);
    } catch {
      // Same answer either way, as in Log Hub.
    } finally {
      setIsLoading(false);
      setSubmitted(true);
    }
  }

  return (
    <AuthPageShell>
      <Card className={styles.card}>
        <CardHeader>
          <CardTitle>Forgot password?</CardTitle>
        </CardHeader>
        {submitted ? (
          <CardContent className={styles.content}>
            <p className={styles.mutedText}>
              If that email is registered, a reset link has been sent.
            </p>
          </CardContent>
        ) : (
          <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
            <CardContent className={styles.content}>
              <p className={styles.mutedText}>
                Enter your email and we&apos;ll send you a link to reset your
                password.
              </p>
              {resetUnavailable && (
                <p role="note" className={styles.mutedText}>
                  {SMTP_NOT_CONFIGURED_HINT}
                </p>
              )}
              <Input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                disabled={resetUnavailable}
              />
            </CardContent>
            <CardFooter className={styles.footer}>
              <Button
                type="submit"
                className={styles.fullWidth}
                disabled={isLoading || resetUnavailable}
              >
                {isLoading ? (
                  <Loader2 className={cn(styles.buttonIcon, styles.spin)} />
                ) : (
                  <Mail className={styles.buttonIcon} />
                )}
                Send reset link
              </Button>
            </CardFooter>
          </form>
        )}
        <CardFooter className={styles.footer}>
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
