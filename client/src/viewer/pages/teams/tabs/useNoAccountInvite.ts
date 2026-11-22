import { useAuth } from '../../../context/AuthContext';
import { useAuthConfig } from '../../../hooks/useAuthConfig';

/**
 * Inviting an email that has no account. In strict-managed only an
 * administrator creates accounts, so the "add them anyway" offer is not shown
 * (the server refuses it too); `refusal` is the message shown instead,
 * worded for whoever is looking. `null` = the offer applies.
 */
export function useNoAccountInvite(): { refusal: string | null } {
  const { data: authConfig } = useAuthConfig();
  const { user } = useAuth();
  if (authConfig?.mode !== 'strict-managed') return { refusal: null };
  return {
    refusal:
      user?.role === 'admin'
        ? 'This user has no account yet — create it in Admin Panel → Users first, then add them here.'
        : 'This user has no account yet — ask an administrator to create it first.',
  };
}
