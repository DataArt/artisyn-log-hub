import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { confirmEmail, ApiError } from '../../api';
import { routes } from '../../hooks/useHashRoute';
import { Button } from '../../ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../ui/card';

type Status =
  | 'loading'
  | 'success'
  | 'invalid'
  | 'expired'
  | 'already-confirmed';

export function ConfirmEmailPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      return;
    }
    confirmEmail(token)
      .then(() => setStatus('success'))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.statusCode === 410) {
          setStatus('expired');
        } else if (err instanceof ApiError && err.statusCode === 409) {
          setStatus('already-confirmed');
        } else {
          setStatus('invalid');
        }
      });
    // Runs once on mount for the token present at load time.
  }, [token]);

  const messages: Record<Exclude<Status, 'loading' | 'success'>, string> = {
    invalid: 'This confirmation link is invalid.',
    expired: 'This confirmation link has expired. Please request a new one.',
    'already-confirmed': 'This email address has already been confirmed.',
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Confirm your email</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin size-4" />
              Confirming your email…
            </div>
          )}
          {status === 'success' && (
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4 text-green-600" />
              Your email has been confirmed. You can now log in.
            </div>
          )}
          {status !== 'loading' && status !== 'success' && (
            <p className="text-sm text-destructive">{messages[status]}</p>
          )}
        </CardContent>
        {status !== 'loading' && (
          <CardFooter className="flex flex-col gap-3">
            <Button className="w-full" onClick={() => navigate(routes.login)}>
              Back to log in
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}
