import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Select } from 'radix-ui';
import { ChevronDown } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import {
  fetchRepositoryBranches,
  fetchTeamMembers,
  getRepoSettings,
} from '../../../api';
import { CACHE_RATIO_SCOPE_COLORS } from '@/lib/cache-ratio-ui';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import {
  SESSION_ATTRIBUTION_TYPE_LABELS,
  resolveSessionAttributionDefinitions,
} from '../../../lib/session-attribution-ui';
import { DateRangePicker } from '../analytics/DateRangePicker';
import type { ReportDefinition } from './report-catalog';
import type { ReportParamsState } from './report-url';

interface Props {
  report: ReportDefinition;
  repoId: number;
  teamId?: number;
  draft: ReportParamsState;
  onDraftChange: (patch: Partial<ReportParamsState>) => void;
  onRun: () => void;
}

function formatRangeLabel(from: string, to: string): string {
  const fmt = (d: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
      new Date(d + 'T00:00:00'),
    );
  return `${fmt(from)} → ${fmt(to)}`;
}

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Non-interactive SCOPE legend for the "Cache Read Ratio" report. It
// sits among the parameter controls but is deliberately *not* a selector: both
// scopes are always reported side by side, so there is
// nothing to choose — the legend only names the two colours used downstream.
function CacheRatioScopeLegendStrip() {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Scope
      </span>
      <div
        className="flex h-9 items-center gap-3 rounded-md border border-dashed border-input px-3 text-xs text-muted-foreground"
        title="Not a selector — both values are always reported side by side"
      >
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-sm"
            style={{ backgroundColor: CACHE_RATIO_SCOPE_COLORS.root }}
          />
          Root only
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-sm"
            style={{
              backgroundColor: CACHE_RATIO_SCOPE_COLORS.withDescendants,
            }}
          />
          Root + descendants
        </span>
      </div>
    </div>
  );
}

export function ReportParameterStrip({
  report,
  repoId,
  teamId,
  draft,
  onDraftChange,
  onRun,
}: Props) {
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  const branchesQuery = useQuery({
    queryKey: ['repo-branches', repoId, teamId],
    queryFn: () => fetchRepositoryBranches(repoId, teamId),
    enabled: report.supportsBranchFilter,
  });
  const teamMembersQuery = useQuery({
    queryKey: ['team-members', teamId],
    queryFn: () => fetchTeamMembers(teamId!),
    enabled: report.supportsUserFilter && teamId != null,
  });
  // Resolved AI Session Attribution definitions,
  // feeding this strip's "Group by" dropdown ATTRIBUTES section, mirroring
  // RepositoryAnalytics.tsx's own repoSettingsQuery (same query key, so no duplicate
  // network round trip when the user has already visited the Analytics tab).
  const repoSettingsQuery = useQuery({
    queryKey: ['repoSettings', repoId, teamId ?? null],
    queryFn: () => getRepoSettings(repoId, teamId),
    enabled: report.supportsGroupBy,
  });
  const attributeDefinitions = useMemo(
    () => resolveSessionAttributionDefinitions(repoSettingsQuery.data),
    [repoSettingsQuery.data],
  );

  const branchOptions = (branchesQuery.data ?? [])
    .map((b) => b.branch)
    .filter((b): b is string => b != null)
    .sort();

  const calendarRange: DateRange | undefined =
    draft.startDate && draft.endDate
      ? {
          from: new Date(draft.startDate + 'T00:00:00'),
          to: new Date(draft.endDate + 'T00:00:00'),
        }
      : undefined;

  function handleDateApply(range: { from: Date; to: Date }) {
    onDraftChange({
      startDate: localDate(range.from),
      endDate: localDate(range.to),
    });
  }

  function toggleBranch(branch: string) {
    const next = draft.branches.includes(branch)
      ? draft.branches.filter((b) => b !== branch)
      : [...draft.branches, branch];
    onDraftChange({ branches: next });
  }

  function toggleUser(email: string) {
    const next = draft.users.includes(email)
      ? draft.users.filter((u) => u !== email)
      : [...draft.users, email];
    onDraftChange({ users: next });
  }

  const showUserFilter =
    report.supportsUserFilter &&
    teamId != null &&
    (teamMembersQuery.data?.length ?? 0) > 0;

  return (
    <div className="flex h-20 flex-shrink-0 flex-wrap items-center gap-3 border-b border-border px-4">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Date range
        </span>
        <button
          onClick={() => setDatePickerOpen(true)}
          className="flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm hover:bg-accent/50"
        >
          {formatRangeLabel(draft.startDate, draft.endDate)}
        </button>
      </div>

      {report.supportsGroupBy && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Group by
          </span>
          <Select.Root
            value={draft.groupBy}
            onValueChange={(v) =>
              onDraftChange({ groupBy: v as ReportParamsState['groupBy'] })
            }
          >
            <Select.Trigger className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
              <Select.Value />
              <Select.Icon>
                <ChevronDown className="size-4 opacity-50" />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content className="z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                <Select.Viewport>
                  <Select.Item
                    value="none"
                    className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                  >
                    <Select.ItemText>No grouping</Select.ItemText>
                  </Select.Item>
                  <Select.Item
                    value="branch"
                    className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                  >
                    <Select.ItemText>Branch</Select.ItemText>
                  </Select.Item>
                  {
                    // Always rendered (not gated on teamId): "Cost by User"
                    // defaults its groupBy to "user" (report-catalog.ts)
                    // regardless of team context. Hiding this item in personal
                    // repo view left Select.Value with no matching item to
                    // display — a completely blank "Group by" dropdown.
                  }
                  <Select.Item
                    value="user"
                    className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                  >
                    <Select.ItemText>User</Select.ItemText>
                  </Select.Item>
                  {/* Resolved AI Session Attribution
                      definitions, visually set apart with a dashed border per the wireframe.
                      Hidden entirely when the repo has no resolved definitions. */}
                  {attributeDefinitions.length > 0 && (
                    <div className="mt-1 border-t border-dashed border-input pt-1">
                      <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                        ATTRIBUTES
                      </div>
                      {attributeDefinitions.map((def) => (
                        <Select.Item
                          key={def.key}
                          value={`attr:${def.key}`}
                          className="flex cursor-default select-none flex-col rounded-sm px-2 py-1.5 outline-none hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                        >
                          <Select.ItemText>{def.label}</Select.ItemText>
                          <span className="text-xs text-muted-foreground">
                            {SESSION_ATTRIBUTION_TYPE_LABELS[def.type]}
                          </span>
                        </Select.Item>
                      ))}
                    </div>
                  )}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
      )}

      {report.supportsBranchFilter && branchOptions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Branches (optional)
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <button className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent/50">
                {draft.branches.length > 0
                  ? `${draft.branches.length} selected`
                  : 'All branches'}
                <ChevronDown className="size-4 opacity-50" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-2">
              <div className="flex flex-col gap-1">
                {branchOptions.map((branch) => (
                  <label
                    key={branch}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50"
                  >
                    <input
                      type="checkbox"
                      checked={draft.branches.includes(branch)}
                      onChange={() => toggleBranch(branch)}
                      className="size-4"
                    />
                    <span className="truncate font-mono">{branch}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}

      {showUserFilter && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Users (optional)
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <button className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent/50">
                {draft.users.length > 0
                  ? `${draft.users.length} selected`
                  : 'All users'}
                <ChevronDown className="size-4 opacity-50" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-2">
              <div className="flex flex-col gap-1">
                {(teamMembersQuery.data ?? []).map((m) => (
                  <label
                    key={m.email}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50"
                  >
                    <input
                      type="checkbox"
                      checked={draft.users.includes(m.email)}
                      onChange={() => toggleUser(m.email)}
                      className="size-4"
                    />
                    <span className="truncate">{m.email}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}

      {report.id === 'cache-read-ratio' && <CacheRatioScopeLegendStrip />}

      <div className="ml-auto">
        <button
          onClick={onRun}
          className="flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Generate
        </button>
      </div>

      <DateRangePicker
        open={datePickerOpen}
        onOpenChange={setDatePickerOpen}
        selected={calendarRange}
        onApply={handleDateApply}
      />
    </div>
  );
}
