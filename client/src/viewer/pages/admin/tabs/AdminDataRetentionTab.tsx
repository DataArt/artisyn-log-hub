import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchDataRetention } from '../../../api';
import { PageState } from '../../../components/PageState';
import { DateTime } from '../../../components/DateTime';
import { DataRetentionChart } from './DataRetentionChart';

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

function SecondaryTile({
  label,
  value,
  caption,
}: {
  label: string;
  value: ReactNode;
  caption: string;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-bold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground">{caption}</div>
    </div>
  );
}

export function AdminDataRetentionTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-retention'],
    queryFn: fetchDataRetention,
  });

  if (isLoading) return <PageState message="Loading…" />;
  if (isError || !data)
    return (
      <PageState
        message="Failed to load data retention stats."
        variant="error"
      />
    );

  if (data.totalSessionCount === 0) {
    return <PageState message="No sessions have been logged yet." />;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card label="Retention Policy">
          <div className="mt-2 text-2xl font-bold text-foreground">
            {data.retentionDays} day{data.retentionDays === 1 ? '' : 's'}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            Sessions older than this are purged
          </div>
        </Card>

        <Card label="Total Sessions">
          <div className="mt-2 text-2xl font-bold text-foreground">
            {data.totalSessionCount.toLocaleString()}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            Non-deleted sessions currently stored
          </div>
        </Card>

        <Card label="OTEL-only Sessions">
          <div
            className="mt-2 text-2xl font-bold text-foreground"
            data-testid="retention-otel-only-sessions"
          >
            {data.otelOnlySessions.toLocaleString()}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            Sessions with OTEL data but no uploaded logs yet; purged by the same
            window
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
        <SecondaryTile
          label="Oldest Session"
          value={<DateTime value={data.oldestSessionAt} />}
          caption="earliest non-deleted session"
        />
        <SecondaryTile
          label="Youngest Session"
          value={<DateTime value={data.youngestSessionAt} />}
          caption="most recent session"
        />
      </div>

      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
          Daily Session Count &amp; Size
        </div>
        <DataRetentionChart data={data.dailySeries} />
      </div>
    </div>
  );
}
