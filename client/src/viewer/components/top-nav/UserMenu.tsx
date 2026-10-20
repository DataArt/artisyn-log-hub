import { useEffect, useState } from 'react';
import { ChevronDown, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { clearLogoutGuard, deleteMyAccount, logout } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useAuthConfig } from '../../hooks/useAuthConfig';
import { routes } from '../../hooks/useHashRoute';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { ChangePasswordModal } from './ChangePasswordModal';

const DELETE_ACCOUNT_MESSAGE =
  'This permanently deletes your profile, credentials, and any personal ' +
  'repositories you own (with all their sessions) — gone for everyone, same ' +
  'as deleting a repo. This cannot be undone: the account’s repositories, ' +
  'sessions and logs are permanently removed.';

/**
 * Top-right account menu. Replaces the plain "Log out" button in
 * every auth mode except `none`, which keeps its "Edit email" button because any
 * email self-provisions an account there.
 *
 * The open/close mechanics deliberately mirror NotificationBell.tsx: a plain
 * absolutely-positioned panel plus a full-screen click-catcher — there is no
 * dropdown-menu primitive in `ui/`, and none is added for this.
 */
export function UserMenu() {
  const { user, setUser } = useAuth();
  const { data: authConfig } = useAuthConfig();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Only the local-password modes have a password to change; mode `none` never
  // renders this menu, and `azure-oauth` credentials live in the IdP.
  const canChangePassword =
    authConfig?.mode === 'password' || authConfig?.mode === 'password-confirm';

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setOpen(false);
      setUser(null);
      navigate(routes.login);
    }
  }

  async function handleDeleteAccount() {
    setDeleteError(null);
    try {
      await deleteMyAccount();
    } catch {
      setDeleteError('Could not delete the account. Please try again.');
      return;
    }
    setDeleteOpen(false);
    setUser(null);
    // The account is gone, so the next request would 401 and arm api.ts's
    // one-shot logout guard; clear it exactly as the logout flow does before
    // navigating away.
    clearLogoutGuard();
    navigate(routes.login);
  }

  return (
    <div className="relative">
      <button
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm text-muted-foreground hover:bg-accent transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="max-w-56 truncate">{user?.email}</span>
        <ChevronDown className="size-3.5" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-9 z-40 w-56 rounded-md border border-border bg-card shadow-lg"
            role="menu"
          >
            <div className="px-3 py-2 border-b border-border">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Signed in as
              </p>
              <p className="text-sm truncate">{user?.email}</p>
            </div>
            <div className="p-1">
              {canChangePassword && (
                <button
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent transition-colors"
                  onClick={() => {
                    setOpen(false);
                    setChangePasswordOpen(true);
                  }}
                >
                  <KeyRound className="size-3.5 text-primary" />
                  Change password
                </button>
              )}
              <button
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive hover:bg-accent transition-colors"
                onClick={() => {
                  setOpen(false);
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="size-3.5" />
                Delete account
              </button>
            </div>
            <div className="p-1 border-t border-border">
              <button
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent transition-colors disabled:opacity-50"
                onClick={handleLogout}
                disabled={isLoggingOut}
              >
                {isLoggingOut && <Loader2 className="animate-spin size-3.5" />}
                Log out
              </button>
            </div>
          </div>
        </>
      )}

      {changePasswordOpen && (
        <ChangePasswordModal
          email={user?.email ?? ''}
          onClose={() => setChangePasswordOpen(false)}
        />
      )}

      {/* Reuses ConfirmDialog's requiresTyping mechanic — the self-service
          variant demands the literal, case-sensitive word "delete" (the admin
          variant in AdminUsersTab instead demands the target's email). */}
      <ConfirmDialog
        open={deleteOpen}
        header="Delete your account?"
        message={
          deleteError
            ? `${DELETE_ACCOUNT_MESSAGE} ${deleteError}`
            : DELETE_ACCOUNT_MESSAGE
        }
        confirmLabel="Delete"
        destructive
        requiresTyping="delete"
        onConfirm={() => void handleDeleteAccount()}
        onCancel={() => {
          setDeleteError(null);
          setDeleteOpen(false);
        }}
      />
    </div>
  );
}
