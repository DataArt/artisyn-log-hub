import { Button } from '../../ui/button';

/** Mode 4 — the OAuth exchange is entirely server-side, so this is a full page navigation, not a router link. */
export function AzureSignInButton() {
  return (
    <Button
      type="button"
      className="w-full"
      onClick={() => {
        window.location.href = '/api/v1/auth/azure';
      }}
    >
      Sign in with Microsoft
    </Button>
  );
}
