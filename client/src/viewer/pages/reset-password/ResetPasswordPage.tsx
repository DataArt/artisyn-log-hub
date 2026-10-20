import { useState, type FormEvent } from 'react';
import { Loader2, KeyRound } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { resetPassword, ApiError } from '../../api';
import { routes } from '../../hooks/useHashRoute';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../ui/card';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setConfirmError(null);

    if (password.length > 128) {
      setConfirmError('Password must be at most 128 characters.');
      return;
    }
    if (password !== confirm) {
      setConfirmError('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    try {
      await resetPassword(token, password, confirm);
      navigate(routes.login);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'weak_password') {
        setConfirmError(
          err.message || 'Password does not meet the strength requirements.',
        );
      } else if (err instanceof ApiError && err.code === 'password_mismatch') {
        setConfirmError('Passwords do not match.');
      } else if (err instanceof ApiError) {
        setError(err.message || 'Reset link is invalid or has expired.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Reset password</CardTitle>
        </CardHeader>
        <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
          <CardContent className="flex flex-col gap-4">
            <Input
              type="password"
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
            <div className="flex flex-col gap-1">
              <Input
                type="password"
                placeholder="Confirm new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
              />
              {confirmError && (
                <p className="text-sm text-destructive">{confirmError}</p>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <Loader2 className="animate-spin size-4 mr-2" />
              ) : (
                <KeyRound className="size-4 mr-2" />
              )}
              Reset password
            </Button>
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
        </form>
      </Card>
    </div>
  );
}
