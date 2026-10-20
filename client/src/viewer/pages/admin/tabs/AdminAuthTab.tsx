import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { fetchAdminAuthConfig } from '../../../api';
import { PageState } from '../../../components/PageState';
import { PendingRegistrationsTable } from './PendingRegistrationsTable';

const MODE_LABELS: Record<string, string> = {
  none: 'No auth (Mode 1)',
  password: 'Email + password (Mode 2)',
  'password-confirm': 'Email + password with confirmation (Mode 3)',
  'azure-oauth': 'Azure Entra ID / OAuth (Mode 4)',
};

// Field *names* only, for the inactive-modes reference list — secrets are
// never fetched or shown for any mode, active or not.
const MODE_FIELD_NAMES: Record<string, string[]> = {
  none: [],
  password: [],
  'password-confirm': ['SMTP host', 'SMTP port', 'SMTP from address'],
  'azure-oauth': ['Tenant ID', 'Client ID', 'Redirect URI', 'Authority'],
};

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background p-4">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

export function AdminAuthTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-auth-config'],
    queryFn: fetchAdminAuthConfig,
  });

  if (isLoading) return <PageState message="Loading…" />;
  if (isError || !data)
    return (
      <PageState message="Failed to load auth configuration." variant="error" />
    );

  const inactiveModes = Object.keys(MODE_LABELS).filter((m) => m !== data.mode);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card label="Active Mode">
          <div className="mt-2 text-lg font-bold text-foreground">
            {MODE_LABELS[data.mode] ?? data.mode}
          </div>
        </Card>

        {data.smtp && (
          <Card label="SMTP">
            <dl className="mt-2 text-sm flex flex-col gap-1">
              <div>
                <span className="text-muted-foreground">Host: </span>
                {data.smtp.host}
              </div>
              <div>
                <span className="text-muted-foreground">Port: </span>
                {data.smtp.port}
              </div>
              <div>
                <span className="text-muted-foreground">From: </span>
                {data.smtp.from}
              </div>
            </dl>
          </Card>
        )}

        {data.azure && (
          <Card label="Azure Entra ID">
            <dl className="mt-2 text-sm flex flex-col gap-1">
              <div>
                <span className="text-muted-foreground">Tenant ID: </span>
                {data.azure.tenantId}
              </div>
              <div>
                <span className="text-muted-foreground">Client ID: </span>
                {data.azure.clientId}
              </div>
              <div>
                <span className="text-muted-foreground">Redirect URI: </span>
                {data.azure.redirectUri}
              </div>
              <div>
                <span className="text-muted-foreground">Authority: </span>
                {data.azure.authority}
              </div>
            </dl>
          </Card>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
        <ShieldAlert className="size-4 mt-0.5 shrink-0" />
        Secrets (passwords, client secrets, SMTP credentials) are never shown
        here.
      </div>

      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
          Other modes
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {inactiveModes.map((mode) => (
            <Card key={mode} label={MODE_LABELS[mode]}>
              <div className="mt-2 text-xs text-muted-foreground">
                {MODE_FIELD_NAMES[mode].length > 0
                  ? MODE_FIELD_NAMES[mode].join(', ')
                  : 'No configuration fields'}
              </div>
            </Card>
          ))}
        </div>
      </div>

      {data.mode === 'password-confirm' && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
            Pending Registrations
          </div>
          <PendingRegistrationsTable />
        </div>
      )}
    </div>
  );
}
