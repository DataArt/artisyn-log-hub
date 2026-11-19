import { useState, type FormEvent } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ApiError, forgotPassword } from '../../api';
import { useAuthConfig } from '../../hooks/useAuthConfig';
import { routes } from '../../hooks/useHashRoute';
import { SMTP_NOT_CONFIGURED_HINT } from '../login/forgot-password-link';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../ui/card';

/** "12 minutes" / "40 seconds" from a 429's Retry-After (a minute if absent). */
function retryAfterText(err: ApiError): string {
  const seconds = err.retryAfterSeconds ?? 60;
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // While the config is loading or errored the form stays enabled.
  const { data: config } = useAuthConfig();
  const resetUnavailable = config?.passwordResetAvailable === false;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      await forgotPassword(email);
      setSubmitted(true);
    } catch (err) {
      // The server answers every email the same way; only a refusal that
      // has nothing to do with the email (too many requests from this
      // network, server down) ends up here — say so instead of "sent".
      setError(
        err instanceof ApiError && err.statusCode === 429
          ? `Too many requests from your network — try again in ${retryAfterText(err)}.`
          : 'Something went wrong. Please try again.',
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Forgot password?</CardTitle>
        </CardHeader>
        {submitted ? (
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              If that email is registered, a reset link has been sent.
            </p>
          </CardContent>
        ) : (
          <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Enter your email and we&apos;ll send you a link to reset your
                password.
              </p>
              {resetUnavailable && (
                <p role="note" className="text-sm text-muted-foreground">
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
              {error && <p className="text-sm text-destructive">{error}</p>}
            </CardContent>
            <CardFooter className="flex flex-col gap-3">
              <Button
                type="submit"
                className="w-full"
                disabled={isLoading || resetUnavailable}
              >
                {isLoading ? (
                  <Loader2 className="animate-spin size-4 mr-2" />
                ) : (
                  <Mail className="size-4 mr-2" />
                )}
                Send reset link
              </Button>
            </CardFooter>
          </form>
        )}
        <CardFooter className="flex flex-col gap-3 pt-0">
          <p className="text-sm text-muted-foreground">
            <button
              type="button"
              className="underline hover:text-foreground"
              onClick={() => navigate(routes.login)}
            >
              Back to log in
            </button>
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
