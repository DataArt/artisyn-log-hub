import type { ReactNode } from 'react';
import type { ExportImportScope } from '../../../../models/export-import';
import type { RepositorySession } from '../../../../models/repositories';
import { ToggleGroup, ToggleGroupItem } from '../../../ui/toggle-group';
import { cn } from '../../../lib/cn';
import { formatTime } from '../../../lib/format';

function formatDateRangeLabel(from: string, to: string): string {
  const fmt = (d: string) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(`${d}T00:00:00`));
  return `${fmt(from)} – ${fmt(to)}`;
}

function sessionLabel(session: RepositorySession): string {
  return session.firstPrompt || session.sessionId;
}

interface ExportScopePickerProps {
  scope: ExportImportScope;
  onScopeChange: (scope: ExportImportScope) => void;
  customFrom?: string;
  customTo?: string;
  onOpenCustomPicker: () => void;
  sessions?: RepositorySession[];
  sessionsLoading: boolean;
  sessionsError: boolean;
  selectedSessionIds: Set<string>;
  onToggleSession: (sessionId: string) => void;
  onToggleSelectAll: (all: RepositorySession[], checked: boolean) => void;
  children: ReactNode;
}

export function ExportScopePicker({
  scope,
  onScopeChange,
  customFrom,
  customTo,
  onOpenCustomPicker,
  sessions,
  sessionsLoading,
  sessionsError,
  selectedSessionIds,
  onToggleSession,
  onToggleSelectAll,
  children,
}: ExportScopePickerProps) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          value={scope}
          onValueChange={(v) => v && onScopeChange(v as ExportImportScope)}
        >
          <ToggleGroupItem value="all">All sessions</ToggleGroupItem>
          <ToggleGroupItem value="dateRange">Date range</ToggleGroupItem>
          <ToggleGroupItem value="sessionIds">Select sessions</ToggleGroupItem>
        </ToggleGroup>

        {scope === 'dateRange' && (
          <button
            onClick={onOpenCustomPicker}
            className={cn(
              'flex h-9 items-center rounded-md border px-3 text-sm font-medium whitespace-nowrap transition-colors',
              customFrom && customTo
                ? 'border-input bg-accent text-accent-foreground'
                : 'border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {customFrom && customTo
              ? formatDateRangeLabel(customFrom, customTo)
              : 'Pick date range'}
          </button>
        )}

        {children}
      </div>

      {scope === 'dateRange' && !(customFrom && customTo) && (
        <p className="mt-2 text-xs text-muted-foreground">
          Pick a date range to enable export.
        </p>
      )}

      {scope === 'sessionIds' && (
        <div className="mt-3 max-w-md">
          {sessionsLoading && (
            <p className="text-xs text-muted-foreground">Loading sessions…</p>
          )}
          {sessionsError && (
            <p className="text-xs text-destructive">Failed to load sessions.</p>
          )}
          {sessions && (
            <>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium select-none">
                  <input
                    type="checkbox"
                    checked={
                      sessions.length > 0 &&
                      selectedSessionIds.size === sessions.length
                    }
                    onChange={(e) =>
                      onToggleSelectAll(sessions, e.target.checked)
                    }
                    className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                  />
                  Select all ({sessions.length})
                </label>
                <span className="text-xs text-muted-foreground">
                  {selectedSessionIds.size} selected
                </span>
              </div>
              <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {sessions.map((session) => (
                  <label
                    key={session.sessionId}
                    className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs select-none hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSessionIds.has(session.sessionId)}
                      onChange={() => onToggleSession(session.sessionId)}
                      className="h-3.5 w-3.5 shrink-0 rounded border-border accent-primary cursor-pointer"
                    />
                    <span className="flex-1 truncate">
                      {sessionLabel(session)}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatTime(session.startTime)}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
