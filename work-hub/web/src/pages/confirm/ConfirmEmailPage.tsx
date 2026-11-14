import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ApiError, confirmEmail } from "../../api/auth";
import { ROUTE } from "../../routes";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import { AuthPageShell } from "../AuthPageShell";
import { cn } from "../../lib/cn";
import styles from "./ConfirmEmailPage.module.css";

type Status =
  | "loading"
  | "success"
  | "invalid"
  | "expired"
  | "already-confirmed";

const MESSAGES: Record<Exclude<Status, "loading" | "success">, string> = {
  invalid: "This confirmation link is invalid.",
  expired: "This confirmation link has expired. Please request a new one.",
  "already-confirmed": "This email address has already been confirmed.",
};

/** `#/confirm-email?token=…` from the confirmation email. */
export function ConfirmEmailPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [status, setStatus] = useState<Status>(token ? "loading" : "invalid");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    confirmEmail(token)
      .then(() => {
        if (!cancelled) setStatus("success");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.statusCode === 410) {
          setStatus("expired");
        } else if (err instanceof ApiError && err.statusCode === 409) {
          setStatus("already-confirmed");
        } else {
          setStatus("invalid");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <AuthPageShell>
      <Card className={styles.card}>
        <CardHeader>
          <CardTitle>Confirm your email</CardTitle>
        </CardHeader>
        <CardContent className={styles.content}>
          {status === "loading" && (
            <div className={cn(styles.status, styles.statusMuted)}>
              <Loader2 className={styles.spinner} />
              Confirming your email…
            </div>
          )}
          {status === "success" && (
            <div className={styles.status}>
              <CheckCircle2 className={styles.successIcon} />
              Your email has been confirmed. You can now log in.
            </div>
          )}
          {status !== "loading" && status !== "success" && (
            <p className={styles.errorText}>{MESSAGES[status]}</p>
          )}
        </CardContent>
        {status !== "loading" && (
          <CardFooter className={styles.footer}>
            <Button
              className={styles.fullWidth}
              onClick={() => void navigate(ROUTE.login)}
            >
              Back to log in
            </Button>
          </CardFooter>
        )}
      </Card>
    </AuthPageShell>
  );
}
