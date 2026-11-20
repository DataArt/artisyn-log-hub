import { Loader2, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { ApiError, identify } from "../../api/auth";
import { useAuth } from "../../auth/AuthContext";
import { returnPath } from "../../routes";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import { Input } from "../../ui/input";
import { cn } from "../../lib/cn";
import styles from "./login.module.css";

/** Mode `none`: a single email field, no password (local requests only). */
export function IdentifyForm() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const profile = await identify(email);
      setUser(profile);
      void navigate(returnPath(location.state), { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.statusCode === 403 && err.message
          ? err.message
          : "Could not continue with that email. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className={styles.card}>
      <CardHeader>
        <CardTitle>Enter your email to continue</CardTitle>
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
          {error && <p className={styles.errorText}>{error}</p>}
        </CardContent>
        <CardFooter>
          <Button
            type="submit"
            className={styles.fullWidth}
            disabled={isLoading}
          >
            {isLoading ? (
              <Loader2 className={cn(styles.buttonIcon, styles.spin)} />
            ) : (
              <Mail className={styles.buttonIcon} />
            )}
            Continue
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
