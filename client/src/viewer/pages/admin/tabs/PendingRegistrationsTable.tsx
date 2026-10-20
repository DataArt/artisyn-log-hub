import { useState } from 'react';
import { Loader2, Mail, Trash2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchPendingRegistrations,
  resendPendingRegistration,
  revokePendingRegistration,
  ApiError,
} from '../../../api';
import { PageState } from '../../../components/PageState';
import { DateTime } from '../../../components/DateTime';
import { useCooldown } from '../../../hooks/useCooldown';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../ui/table';

const EXPIRING_SOON_MS = 2 * 60 * 60 * 1000;

function ExpiryBadge({ tokenExpiresAt }: { tokenExpiresAt: string }) {
  const msLeft = new Date(tokenExpiresAt).getTime() - Date.now();
  if (msLeft <= 0) return <Badge variant="destructive">expired</Badge>;
  if (msLeft <= EXPIRING_SOON_MS) {
    return (
      <Badge variant="outline" className="border-orange-500 text-orange-600">
        expiring soon
      </Badge>
    );
  }
  return <Badge variant="secondary">pending</Badge>;
}

function RowActions({ id }: { id: number }) {
  const queryClient = useQueryClient();
  const { secondsLeft, start } = useCooldown();
  const [isResending, setIsResending] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  async function handleResend() {
    setIsResending(true);
    try {
      const result = await resendPendingRegistration(id);
      if (result.email_delivery === 'sent') start(60);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 429) {
        start(err.retryAfterSeconds ?? 60);
      }
      // 404/409 (row revoked/confirmed by another session) — refetch to reconcile.
      await queryClient.invalidateQueries({
        queryKey: ['admin-pending-registrations'],
      });
    } finally {
      setIsResending(false);
    }
  }

  async function handleRevoke() {
    setIsRevoking(true);
    try {
      await revokePendingRegistration(id);
    } finally {
      setIsRevoking(false);
      await queryClient.invalidateQueries({
        queryKey: ['admin-pending-registrations'],
      });
    }
  }

  return (
    <div className="flex gap-2 justify-end">
      <Button
        variant="outline"
        size="sm"
        disabled={secondsLeft > 0 || isResending}
        onClick={handleResend}
      >
        {isResending ? (
          <Loader2 className="animate-spin size-3.5" />
        ) : (
          <Mail className="size-3.5" />
        )}
        {secondsLeft > 0 ? `Resend (${secondsLeft}s)` : 'Resend'}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        disabled={isRevoking}
        onClick={handleRevoke}
      >
        {isRevoking ? (
          <Loader2 className="animate-spin size-3.5" />
        ) : (
          <Trash2 className="size-3.5" />
        )}
        Revoke
      </Button>
    </div>
  );
}

export function PendingRegistrationsTable() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-pending-registrations'],
    queryFn: fetchPendingRegistrations,
  });

  if (isLoading) return <PageState message="Loading pending registrations…" />;
  if (isError || !data)
    return (
      <PageState
        message="Failed to load pending registrations."
        variant="error"
      />
    );

  if (data.length === 0) {
    return <PageState message="No pending registrations" />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Registered</TableHead>
          <TableHead>Token Expires</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.email}</TableCell>
            <TableCell>
              <DateTime value={row.registeredAt} />
            </TableCell>
            <TableCell>
              <DateTime value={row.tokenExpiresAt} />
            </TableCell>
            <TableCell>
              <ExpiryBadge tokenExpiresAt={row.tokenExpiresAt} />
            </TableCell>
            <TableCell>
              <RowActions id={row.id} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
