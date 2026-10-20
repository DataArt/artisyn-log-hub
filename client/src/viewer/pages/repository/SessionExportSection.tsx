import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { fetchTeamMembers } from '../../api';
import { useModelPricing } from '../../hooks/useModelPricing';
import { Button } from '../../ui/button';
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group';
import { cn } from '../../lib/cn';
import { DateRangePicker } from './analytics/DateRangePicker';
import { runSessionExport } from './session-export-runner';
import type { SessionExportProgress } from './session-export-runner';
import { SessionExportProgressModal } from './SessionExportProgressModal';

// ---------------------------------------------------------------------------
// SessionExportSection — "Session Statistics Export"
// ---------------------------------------------------------------------------

type ExportPeriod = 'all' | 'week' | 'month' | 'custom';

function deriveExportRange(
  period: ExportPeriod,
  customFrom: string | undefined,
  customTo: string | undefined,
): { from: string; to: string } | null {
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;

  if (period === 'all') {
    return {
      from: new Date(0).toISOString(),
      to: now.toISOString(),
    };
  }
  if (period === 'week') {
    return {
      from: new Date(now.getTime() - 7 * msPerDay).toISOString(),
      to: now.toISOString(),
    };
  }
  if (period === 'month') {
    return {
      from: new Date(now.getTime() - 30 * msPerDay).toISOString(),
      to: now.toISOString(),
    };
  }
  if (!customFrom || !customTo) return null;
  // Parse as LOCAL midnight/end-of-day, then convert to UTC for the API — same
  // convention as RepositoryAnalytics.tsx's own custom-range handling.
  return {
    from: new Date(`${customFrom}T00:00:00`).toISOString(),
    to: new Date(`${customTo}T23:59:59`).toISOString(),
  };
}

function formatExportCustomLabel(from: string, to: string): string {
  const fmt = (d: string) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(d + 'T00:00:00'));
  return `${fmt(from)} – ${fmt(to)}`;
}

interface SessionExportSectionProps {
  repoId: number;
  teamId?: number;
  isTeamView: boolean;
  readOnly: boolean;
}

export function SessionExportSection({
  repoId,
  teamId,
  isTeamView,
  readOnly,
}: SessionExportSectionProps) {
  const pricing = useModelPricing();

  const [period, setPeriod] = useState<ExportPeriod>('all');
  const [customFrom, setCustomFrom] = useState<string | undefined>();
  const [customTo, setCustomTo] = useState<string | undefined>();
  const [customPickerOpen, setCustomPickerOpen] = useState(false);
  const [userId, setUserId] = useState<number | undefined>(undefined);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<SessionExportProgress>({
    completed: 0,
    total: 0,
  });
  const [error, setError] = useState<string | null>(null);

  const teamMembersQuery = useQuery({
    queryKey: ['team-members', teamId],
    queryFn: () => fetchTeamMembers(teamId!),
    enabled: isTeamView && teamId != null,
  });

  const calendarRange: DateRange | undefined =
    period === 'custom' && customFrom && customTo
      ? { from: new Date(customFrom), to: new Date(customTo) }
      : undefined;

  const range = useMemo(
    () => deriveExportRange(period, customFrom, customTo),
    [period, customFrom, customTo],
  );

  function handlePeriodToggle(value: string) {
    if (!value) return;
    setPeriod(value as ExportPeriod);
  }

  function handleCustomApply(r: { from: Date; to: Date }) {
    const localDate = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    setPeriod('custom');
    setCustomFrom(localDate(r.from));
    setCustomTo(localDate(r.to));
  }

  async function handleExport() {
    if (!range) return;
    setError(null);
    setProgress({ completed: 0, total: 0 });
    setIsExporting(true);
    try {
      await runSessionExport(
        repoId,
        { teamId, from: range.from, to: range.to, userId },
        pricing,
        setProgress,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        Download every session&apos;s derived stats (tokens, cost, files,
        productivity…) for a date range as a zip archive.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          value={period !== 'custom' ? period : ''}
          onValueChange={handlePeriodToggle}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="week">Week</ToggleGroupItem>
          <ToggleGroupItem value="month">Month</ToggleGroupItem>
        </ToggleGroup>

        <button
          onClick={() => setCustomPickerOpen(true)}
          className={cn(
            'flex h-9 items-center rounded-md border px-3 text-sm font-medium whitespace-nowrap transition-colors',
            period === 'custom'
              ? 'border-input bg-accent text-accent-foreground'
              : 'border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
          )}
        >
          {period === 'custom' && customFrom && customTo
            ? formatExportCustomLabel(customFrom, customTo)
            : 'Custom'}
        </button>

        {isTeamView && (
          <select
            value={userId ?? ''}
            onChange={(e) =>
              setUserId(e.target.value ? Number(e.target.value) : undefined)
            }
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs"
          >
            <option value="">All users</option>
            {(teamMembersQuery.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.email}
              </option>
            ))}
          </select>
        )}

        {!readOnly && (
          <Button
            size="sm"
            disabled={!range || isExporting}
            onClick={() => void handleExport()}
          >
            {isExporting && <Loader2 className="size-3.5 animate-spin" />}
            Export
          </Button>
        )}
      </div>

      {period === 'custom' && !customFrom && (
        <p className="mt-2 text-xs text-muted-foreground">
          Pick a custom date range to enable export.
        </p>
      )}

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      <DateRangePicker
        open={customPickerOpen}
        onOpenChange={setCustomPickerOpen}
        selected={calendarRange}
        onApply={handleCustomApply}
      />

      <SessionExportProgressModal
        open={isExporting}
        completed={progress.completed}
        total={progress.total}
      />
    </div>
  );
}
