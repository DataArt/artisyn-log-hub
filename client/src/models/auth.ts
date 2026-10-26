export interface UserProfile {
  id: number;
  email: string;
  role: 'admin' | 'user';
  created_at: string;
  env_name: string;
  email_delivery?: 'sent' | 'failed';
}

/**
 * Response of POST /api/v1/auth/change-password: the public profile plus the
 * outcome of the best-effort "your password was changed" notification.
 * `skipped` means SMTP is not configured on the server — not a failure.
 */
export interface ChangePasswordResult extends Omit<
  UserProfile,
  'email_delivery'
> {
  email_delivery: 'sent' | 'failed' | 'skipped';
}

export type AuthMode = 'none' | 'password' | 'password-confirm' | 'azure-oauth';

export interface AuthConfig {
  mode: AuthMode;
  azure?: { authority: string; clientId: string; redirectUri: string };
  adminContactEmail?: string;
  /**
   * Present only in `password` / `password-confirm`: whether the server can
   * send password-reset email (SMTP configured). Absent from older servers.
   */
  passwordResetAvailable?: boolean;
}
