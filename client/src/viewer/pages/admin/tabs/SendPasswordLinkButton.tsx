import { useCallback, useEffect, useState } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { AdminUser } from '../../../../models/admin';
import { ApiError, sendPasswordLink } from '../../../api';
import { Button } from '../../../ui/button';
import type { AdminUsersNoticeValue } from './AdminUsersNotice';

/** Mirrors the server's 60 s per-account cooldown between set-password links. */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Per-user state of the strict-managed "Resend link" action, kept by the Users
 * tab rather than by the button: `AdminDataTable` renders each cell through an
 * inline function that is a new component type on every tab render, so state
 * inside a cell would reset (and the countdown vanish) on any re-render.
 */
export function usePasswordLinkSender(
  onNotice: (notice: AdminUsersNoticeValue) => void,
) {
  const queryClient = useQueryClient();
  /** user id → epoch ms until which "Resend link" stays disabled. */
  const [cooldownUntil, setCooldownUntil] = useState<Record<number, number>>(
    {},
  );
  const [sendingIds, setSendingIds] = useState<ReadonlySet<number>>(new Set());

  const startCooldown = useCallback((userId: number, seconds: number) => {
    setCooldownUntil((prev) => ({
      ...prev,
      [userId]: Date.now() + seconds * 1000,
    }));
  }, []);

  const setSending = useCallback((userId: number, sending: boolean) => {
    setSendingIds((prev) => {
      const next = new Set(prev);
      if (sending) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }, []);

  async function send(user: AdminUser) {
    setSending(user.id, true);
    try {
      const result = await sendPasswordLink(user.id);
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      if (result.email_delivery === 'sent') {
        startCooldown(user.id, RESEND_COOLDOWN_SECONDS);
        onNotice({
          tone: 'success',
          text: `Set-password link sent to ${user.email}`,
        });
      } else {
        onNotice({
          tone: 'warning',
          text: `The link to ${user.email} was not sent — check the server's SMTP settings and try again`,
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 429) {
        const seconds = err.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS;
        startCooldown(user.id, seconds);
        onNotice({
          tone: 'warning',
          text: 'Too many requests — try again when the countdown on the button ends',
        });
      } else {
        // 404/409 (user deleted, or the password was set meanwhile) — refetch to reconcile.
        await queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      }
    } finally {
      setSending(user.id, false);
    }
  }

  return {
    send,
    /**
     * The later of the local cooldown (after a 429) and the server's: 60 s
     * from the last link the server issued (create or resend), so a reload
     * or a link issued just now by "+ Create user" keeps the button waiting.
     */
    cooldownUntil: (user: AdminUser) =>
      Math.max(
        cooldownUntil[user.id] ?? 0,
        user.passwordLinkSentAt === null
          ? 0
          : new Date(user.passwordLinkSentAt).getTime() +
              RESEND_COOLDOWN_SECONDS * 1000,
      ),
    isSending: (userId: number) => sendingIds.has(userId),
  };
}

function secondsUntil(epochMs: number): number {
  return Math.max(0, Math.ceil((epochMs - Date.now()) / 1000));
}

interface Props {
  /** Epoch ms until which the action is disabled (0 = no cooldown). */
  cooldownUntil: number;
  isSending: boolean;
  onClick: () => void;
}

/**
 * Strict-managed "Resend link" for a password-less account: emails a fresh
 * 24 h set-password link (the old one stops working). Shows the remaining
 * cooldown, derived from `cooldownUntil` so a remount keeps it.
 */
export function SendPasswordLinkButton({
  cooldownUntil,
  isSending,
  onClick,
}: Props) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    secondsUntil(cooldownUntil),
  );

  useEffect(() => {
    setSecondsLeft(secondsUntil(cooldownUntil));
    if (secondsUntil(cooldownUntil) === 0) return;
    const id = setInterval(() => {
      const left = secondsUntil(cooldownUntil);
      setSecondsLeft(left);
      if (left === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={secondsLeft > 0 || isSending}
      onClick={onClick}
    >
      {isSending ? (
        <Loader2 className="animate-spin size-3.5" />
      ) : (
        <Mail className="size-3.5" />
      )}
      {secondsLeft > 0 ? `Resend link (${secondsLeft}s)` : 'Resend link'}
    </Button>
  );
}
