import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, LogIn, Mail } from 'lucide-react';
import {
  useNavigate,
  useLocation,
  useSearchParams,
  Navigate,
} from 'react-router-dom';
import { login, identify, ApiError } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useAuthConfig } from '../../hooks/useAuthConfig';
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
import { AzureSignInButton } from './AzureSignInButton';

function TemporaryIssueMessage({
  adminContactEmail,
}: {
  adminContactEmail?: string;
}) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Log in</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-destructive">
          There&apos;s a temporary issue signing in
          {adminContactEmail ? (
            <> — please contact your administrator at {adminContactEmail}.</>
          ) : (
            <>. Please try again shortly.</>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function IdentifyForm() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from =
    (location.state as { from?: Location } | null)?.from?.pathname ?? '/main';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const profile = await identify(email);
      setUser(profile);
      navigate(from, { replace: true });
    } catch {
      setError('Could not continue with that email. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Enter your email to continue</CardTitle>
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
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? (
              <Loader2 className="animate-spin size-4 mr-2" />
            ) : (
              <Mail className="size-4 mr-2" />
            )}
            Continue
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Seconds to wait after a 429, read from the `Retry-After` header that
 * `readApiError` parsed. Falls back to 1s so the banner is never blank and the
 * button always re-enables on its own.
 */
function retryDelaySeconds(err: ApiError): number {
  const raw = err.retryAfterSeconds;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 1;
  return Math.ceil(raw);
}

function PasswordLoginForm({
  showForgotPassword,
}: {
  showForgotPassword: boolean;
}) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seconds left on the server-side brute-force delay (429). While > 0 the
  // submit button stays disabled and the amber banner names the wait.
  const [delaySeconds, setDelaySeconds] = useState(0);

  const from =
    (location.state as { from?: Location } | null)?.from?.pathname ?? '/main';

  useEffect(() => {
    if (delaySeconds <= 0) return;
    const timer = setTimeout(
      () => setDelaySeconds((left) => Math.max(0, left - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [delaySeconds]);

  if (user != null) return <Navigate to="/main" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const profile = await login(email, password);
      setUser(profile);
      navigate(from, { replace: true });
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.statusCode === 403 &&
        err.code === 'email_not_confirmed'
      ) {
        setError(
          'Please confirm your email address first — check your inbox for the confirmation link.',
        );
      } else if (err instanceof ApiError && err.statusCode === 429) {
        // The server refused to even check the credentials this time, so no
        // credential error is shown — only how long to wait.
        setDelaySeconds(retryDelaySeconds(err));
      } else if (err instanceof ApiError && err.statusCode === 401) {
        setError('Invalid email or password.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Log in</CardTitle>
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
            autoComplete="current-password"
          />
          {showForgotPassword && (
            <button
              type="button"
              className="self-end text-sm underline hover:text-foreground text-muted-foreground"
              onClick={() => navigate(routes.forgotPassword)}
            >
              Forgot password?
            </button>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {delaySeconds > 0 && (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2"
            >
              <p className="text-sm font-medium text-amber-900">
                Too many attempts
              </p>
              <p className="text-sm text-amber-800">
                Please wait {delaySeconds}s before trying again.
              </p>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading || delaySeconds > 0}
          >
            {isLoading ? (
              <Loader2 className="animate-spin size-4 mr-2" />
            ) : (
              <LogIn className="size-4 mr-2" />
            )}
            Log in
          </Button>
          <p className="text-sm text-muted-foreground">
            Don&apos;t have an account?{' '}
            <button
              type="button"
              className="underline hover:text-foreground"
              onClick={() => navigate('/signup')}
            >
              Sign up
            </button>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}

export function LoginPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const oauthError = searchParams.get('oauthError');
  const { data: config, isLoading, isError } = useAuthConfig();

  if (user != null) return <Navigate to="/main" replace />;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
      {oauthError === 'tenant' && (
        <div
          className="text-sm text-destructive max-w-sm w-full text-center"
          role="alert"
        >
          <p className="font-semibold">
            Your organization is not allowed on this server
          </p>
          <p>
            This Microsoft account belongs to a different organization than this
            server. Contact your administrator.
          </p>
        </div>
      )}
      {oauthError != null && oauthError !== 'tenant' && (
        <p
          className="text-sm text-destructive max-w-sm w-full text-center"
          role="alert"
        >
          Sign in with Microsoft failed. Please try again.
        </p>
      )}
      {isLoading && <Loader2 className="animate-spin size-6" />}
      {isError && <TemporaryIssueMessage />}
      {!isLoading && !isError && config?.mode === 'none' && <IdentifyForm />}
      {!isLoading && !isError && config?.mode === 'password' && (
        <PasswordLoginForm showForgotPassword={false} />
      )}
      {!isLoading && !isError && config?.mode === 'password-confirm' && (
        <PasswordLoginForm showForgotPassword={true} />
      )}
      {!isLoading && !isError && config?.mode === 'azure-oauth' && (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Log in</CardTitle>
          </CardHeader>
          <CardContent>
            <AzureSignInButton />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
