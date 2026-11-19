import { useState, type FormEvent } from 'react';
import { Loader2, KeyRound } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { resetPassword, ApiError } from '../../api';
import { useAuthConfig } from '../../hooks/useAuthConfig';
import { routes } from '../../hooks/useHashRoute';
import {
  passwordRequirementSentence,
  weakPasswordMessage,
} from '../../lib/password-requirement';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../ui/card';

const INVALID_LINK_MESSAGE =
  'This link is invalid or has expired. Request a new one with "Forgot password?" on the login page.';

/**
 * The token itself was refused: 400 "Invalid or unknown token", 409 already
 * used, 410 expired. Other 400s (password policy, mismatch) are handled before.
 */
function isInvalidLinkError(err: ApiError): boolean {
  if (err.statusCode === 409 || err.statusCode === 410) return true;
  return err.statusCode === 400 && /token/i.test(err.message);
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  // Admin-issued links (bootstrap, create user, resend) carry `purpose=set`:
  // the account has no password yet, so the page says "Set" not "Reset".
  const isSetPurpose = searchParams.get('purpose') === 'set';
  // Keyed by the token: opening another link starts from a clean form.
  return (
    <ResetPasswordForm key={token} token={token} isSetPurpose={isSetPurpose} />
  );
}

function ResetPasswordForm({
  token,
  isSetPurpose,
}: {
  token: string;
  isSetPurpose: boolean;
}) {
  const navigate = useNavigate();
  // A link without a token can never succeed: say so up front.
  const missingToken = token === '';
  const title = isSetPurpose ? 'Set your password' : 'Reset password';
  const submitLabel = isSetPurpose ? 'Set password' : 'Reset password';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    missingToken ? INVALID_LINK_MESSAGE : null,
  );
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { data: authConfig } = useAuthConfig();
  const requirement = passwordRequirementSentence(
    authConfig?.passwordRequirement,
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setConfirmError(null);
    setPolicyError(null);

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
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'weak_password') {
        setPolicyError(weakPasswordMessage(err.message));
      } else if (err instanceof ApiError && err.code === 'password_mismatch') {
        setConfirmError('Passwords do not match.');
      } else if (err instanceof ApiError && isInvalidLinkError(err)) {
        setError(INVALID_LINK_MESSAGE);
      } else if (err instanceof ApiError) {
        setError(err.message || INVALID_LINK_MESSAGE);
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
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        {done ? (
          <>
            <CardContent>
              <p role="status" className="text-sm text-muted-foreground">
                {isSetPurpose
                  ? 'Your password is set.'
                  : 'Your password was changed.'}{' '}
                Log in with your email and the new password.
              </p>
            </CardContent>
            <CardFooter>
              <Button className="w-full" onClick={() => navigate(routes.login)}>
                Go to log in
              </Button>
            </CardFooter>
          </>
        ) : (
          <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <Input
                  type="password"
                  placeholder="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
                {/* The rule up front; after a refusal the same spot says why. */}
                {policyError ? (
                  <p className="text-sm text-destructive">{policyError}</p>
                ) : (
                  requirement && (
                    <p className="text-xs text-muted-foreground">
                      {requirement}
                    </p>
                  )
                )}
              </div>
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
              <Button
                type="submit"
                className="w-full"
                disabled={isLoading || missingToken}
              >
                {isLoading ? (
                  <Loader2 className="animate-spin size-4 mr-2" />
                ) : (
                  <KeyRound className="size-4 mr-2" />
                )}
                {submitLabel}
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
        )}
      </Card>
    </div>
  );
}
