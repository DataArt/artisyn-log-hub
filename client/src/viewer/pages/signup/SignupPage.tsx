import { useState, type FormEvent } from 'react';
import { Loader2, UserPlus, Mail } from 'lucide-react';
import { signup, resendConfirmation, ApiError } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useAuthConfig } from '../../hooks/useAuthConfig';
import { useCooldown } from '../../hooks/useCooldown';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../ui/card';

export function SignupPage() {
  const { setUser } = useAuth();
  const { data: config } = useAuthConfig();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pending, setPending] = useState<
    'none' | 'check-email' | 'delivery-failed'
  >('none');
  const [resendError, setResendError] = useState<string | null>(null);
  const { secondsLeft, start } = useCooldown();

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
      const profile = await signup(email, password, confirm);
      if (profile.email_delivery === 'sent') {
        setPending('check-email');
      } else if (profile.email_delivery === 'failed') {
        setPending('delivery-failed');
      } else {
        setUser(profile);
        navigate('/main');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'weak_password') {
        setConfirmError(
          err.message || 'Password does not meet the strength requirements.',
        );
      } else if (
        err instanceof ApiError &&
        err.code === 'email_domain_not_allowed'
      ) {
        setError(
          err.message || 'Sign-up is not allowed for this email domain.',
        );
      } else if (err instanceof ApiError && err.statusCode === 409) {
        setError(err.message || 'An account with this email already exists.');
      } else if (err instanceof ApiError) {
        setError(err.message || 'Something went wrong. Please try again.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleResend() {
    setResendError(null);
    try {
      const result = await resendConfirmation(email);
      if (result.email_delivery === 'failed') {
        setPending('delivery-failed');
      } else {
        start(60);
      }
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 429) {
        start(err.retryAfterSeconds ?? 60);
      } else {
        setResendError(
          'Could not resend the confirmation email. Please try again.',
        );
      }
    }
  }

  if (pending === 'check-email' || pending === 'delivery-failed') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Create account</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {pending === 'check-email' ? (
              <p className="text-sm text-muted-foreground">
                Check your email to confirm your account.
              </p>
            ) : (
              <p className="text-sm text-destructive">
                There&apos;s a temporary issue sending email
                {config?.adminContactEmail ? (
                  <>
                    {' '}
                    — please contact your administrator at{' '}
                    {config.adminContactEmail}.
                  </>
                ) : (
                  <>. Please try again shortly.</>
                )}
              </p>
            )}
            {resendError && (
              <p className="text-sm text-destructive">{resendError}</p>
            )}
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={secondsLeft > 0}
              onClick={handleResend}
            >
              <Mail className="size-4 mr-2" />
              {secondsLeft > 0
                ? `Resend confirmation email (${secondsLeft}s)`
                : 'Resend confirmation email'}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create account</CardTitle>
        </CardHeader>
        <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
          <CardContent className="flex flex-col gap-4">
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
            <div className="flex flex-col gap-1">
              <Input
                type="password"
                placeholder="Confirm password"
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
                <UserPlus className="size-4 mr-2" />
              )}
              Sign up
            </Button>
            <p className="text-sm text-muted-foreground">
              Already have an account?{' '}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => navigate('/login')}
              >
                Log in
              </button>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
