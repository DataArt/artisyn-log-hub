import { Loader2 } from "lucide-react";
import { Navigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../../auth/AuthContext";
import { useAuthConfig } from "../../auth/useAuthConfig";
import { ROUTE } from "../../routes";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { AuthPageShell } from "../AuthPageShell";
import { AzureSignInButton } from "./AzureSignInButton";
import { forgotPasswordLinkState } from "./forgot-password-link";
import { IdentifyForm } from "./IdentifyForm";
import { PasswordLoginForm } from "./PasswordLoginForm";
import styles from "./login.module.css";

function TemporaryIssueMessage() {
  return (
    <Card className={styles.card}>
      <CardHeader>
        <CardTitle>Log in</CardTitle>
      </CardHeader>
      <CardContent>
        <p className={styles.errorText}>
          There&apos;s a temporary issue signing in. Please try again shortly.
        </p>
      </CardContent>
    </Card>
  );
}

/** `/api/auth/callback` sends a failed Azure sign-in back here with `?oauthError=tenant|1`. */
function OAuthErrorBanner({ oauthError }: { oauthError: string }) {
  if (oauthError === "tenant") {
    return (
      <div className={styles.oauthError} role="alert">
        <p className={styles.oauthErrorTitle}>
          Your organization is not allowed on this server
        </p>
        <p>
          This Microsoft account belongs to a different organization than this
          server. Contact your administrator.
        </p>
      </div>
    );
  }
  return (
    <p className={styles.oauthError} role="alert">
      Sign in with Microsoft failed. Please try again.
    </p>
  );
}

/** The login page: the form of the server's auth mode (`GET /auth/config`). */
export function LoginPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const oauthError = searchParams.get("oauthError");
  const { data: config, isLoading, isError } = useAuthConfig();

  if (user != null) return <Navigate to={ROUTE.workspaces} replace />;

  const ready = !isLoading && !isError && config != null;

  return (
    <AuthPageShell>
      {oauthError != null && <OAuthErrorBanner oauthError={oauthError} />}
      {isLoading && <Loader2 className={styles.pageSpinner} />}
      {isError && <TemporaryIssueMessage />}
      {ready && config.mode === "none" && <IdentifyForm />}
      {ready &&
        (config.mode === "password" || config.mode === "password-confirm") && (
          <PasswordLoginForm forgotPassword={forgotPasswordLinkState(config)} />
        )}
      {ready && config.mode === "azure-oauth" && (
        <Card className={styles.card}>
          <CardHeader>
            <CardTitle>Log in</CardTitle>
          </CardHeader>
          <CardContent>
            <AzureSignInButton />
          </CardContent>
        </Card>
      )}
    </AuthPageShell>
  );
}
