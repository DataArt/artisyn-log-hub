// `/api/v1/auth/*` (D3): the same routes and shapes as Log Hub's auth controller.

import { API, ApiError, apiCall, publicJson } from "./client";

export type AuthMode = "none" | "password" | "password-confirm" | "azure-oauth";

/** `GET /auth/config`. */
export interface AuthConfig {
  mode: AuthMode;
  azure?: { authority: string; clientId: string; redirectUri: string };
  adminContactEmail?: string;
  /** Password modes only: whether the server can send reset email (SMTP configured). */
  passwordResetAvailable?: boolean;
}

export type EmailDelivery = "sent" | "failed";

/** The public profile `{id, email, role, createdAt}`; `role` is always `"user"` in Work Hub. */
export interface UserProfile {
  id: number;
  email: string;
  role: "user";
  createdAt: string;
  /** Sign-up in `password-confirm`: whether the confirmation email went out. */
  email_delivery?: EmailDelivery;
}

/** `POST /auth/change-password`: the profile plus the notification outcome. */
export interface ChangePasswordResult extends Omit<
  UserProfile,
  "email_delivery"
> {
  email_delivery: EmailDelivery | "skipped";
}

const AUTH = `${API}/auth`;

/** Where the Azure sign-in starts (a full page navigation). */
export const AZURE_START_URL = `${AUTH}/azure`;

export async function fetchAuthConfig(): Promise<AuthConfig> {
  return publicJson<AuthConfig>(`${AUTH}/config`, {
    signal: AbortSignal.timeout(5000),
  });
}

/** `GET /auth/me`; 401 when not signed in (mode `none` auto-identifies local requests). */
export async function fetchMe(): Promise<UserProfile> {
  return publicJson<UserProfile>(`${AUTH}/me`);
}

export async function identify(email: string): Promise<UserProfile> {
  return publicJson<UserProfile>(`${AUTH}/identify`, {
    method: "POST",
    json: { email },
  });
}

export async function login(
  email: string,
  password: string,
): Promise<UserProfile> {
  return publicJson<UserProfile>(`${AUTH}/login`, {
    method: "POST",
    json: { email, password },
  });
}

export async function signup(
  email: string,
  password: string,
  passwordConfirm: string,
): Promise<UserProfile> {
  return publicJson<UserProfile>(`${AUTH}/signup`, {
    method: "POST",
    json: { email, password, passwordConfirm },
  });
}

export async function logout(): Promise<void> {
  await fetch(`${AUTH}/logout`, { method: "POST", credentials: "include" });
}

export async function confirmEmail(token: string): Promise<UserProfile> {
  return publicJson<UserProfile>(`${AUTH}/confirm-email`, {
    method: "POST",
    json: { token },
  });
}

export async function resendConfirmation(
  email: string,
): Promise<{ email_delivery: EmailDelivery }> {
  return publicJson<{ email_delivery: EmailDelivery }>(
    `${AUTH}/resend-confirmation`,
    { method: "POST", json: { email } },
  );
}

export async function forgotPassword(
  email: string,
): Promise<{ email_delivery: EmailDelivery }> {
  return publicJson<{ email_delivery: EmailDelivery }>(
    `${AUTH}/forgot-password`,
    { method: "POST", json: { email } },
  );
}

export async function resetPassword(
  token: string,
  password: string,
  passwordConfirm: string,
): Promise<UserProfile> {
  return publicJson<UserProfile>(`${AUTH}/reset-password`, {
    method: "POST",
    json: { token, password, passwordConfirm },
  });
}

/**
 * Bare fetch (no 401 redirect): it is made from a dialog by a signed-in user, and the server
 * answers a wrong current password with 403 `invalid_current_password`.
 */
export async function changePassword(
  currentPassword: string,
  password: string,
  passwordConfirm: string,
): Promise<ChangePasswordResult> {
  return publicJson<ChangePasswordResult>(`${AUTH}/change-password`, {
    method: "POST",
    json: { currentPassword, password, passwordConfirm },
  });
}

/** Deletes the account and all of its workspaces; 204. */
export async function deleteAccount(): Promise<void> {
  await apiCall(`${AUTH}/delete-account`, {
    method: "POST",
    json: { confirm: "delete" },
  });
}

/** `true` when the error means "not signed in" (as opposed to a server problem). */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.statusCode === 401;
}

// Re-exported so pages import auth calls and the error type from one module.
export { ApiError };
