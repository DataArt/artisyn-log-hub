/**
 * Filter strip of the repo OKF tab: date range, branches, users (team view), attribute filter,
 * bundle and the Bytes/Calls read-heat toggle. Unlike the Reports strip there is no Generate
 * button — every change is applied at once (the tab mirrors it to the `okf*` URL params).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Select } from 'radix-ui';
import { ChevronDown } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import {
  fetchRepositoryBranches,
  fetchTeamMembers,
  getRepoSettings,
} from '../../../api';
import { resolveSessionAttributionDefinitions } from '../../../lib/session-attribution-ui';
import { DateRangePicker } from '../analytics/DateRangePicker';
import { AttributeFilterPopover } from '../session-list/AttributeFilterPopover';
import type { OkfHeatMetric } from '../session-log/okf/okf-tree';
import {
  attrParamsToSelection,
  attrSelectionToParams,
  type RepoOkfFilters,
} from './okf-url-state';

const ALL_BUNDLES = '__all__';

const TRIGGER_CLASS =
  'flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent/50';

const ITEM_CLASS =
  'flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground';

export interface OkfFilterStripProps {
  repoId: number;
  teamId?: number;
  filters: RepoOkfFilters;
  onChange: (patch: Partial<RepoOkfFilters>) => void;
  /** Bundle roots to offer in the bundle select. */
  bundleRoots: readonly string[];
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
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

function toggled(list: readonly string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function CheckList({
  label,
  allLabel,
  options,
  selected,
  onToggle,
  mono,
  testId,
}: {
  label: string;
  allLabel: string;
  options: readonly string[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  mono?: boolean;
  testId: string;
}) {
  return (
    <Field label={label}>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={TRIGGER_CLASS} data-testid={testId}>
            {selected.length > 0 ? `${selected.length} selected` : allLabel}
            <ChevronDown className="size-4 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="max-h-80 w-64 overflow-y-auto p-2"
        >
          <div className="flex flex-col gap-1">
            {options.map((o) => (
              <label
                key={o}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(o)}
                  onChange={() => onToggle(o)}
                  className="size-4"
                />
                <span className={`truncate ${mono ? 'font-mono' : ''}`}>
                  {o}
                </span>
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

export function OkfFilterStrip({
  repoId,
  teamId,
  filters,
  onChange,
  bundleRoots,
}: OkfFilterStripProps) {
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  const branchesQuery = useQuery({
    queryKey: ['repo-branches', repoId, teamId],
    queryFn: () => fetchRepositoryBranches(repoId, teamId),
  });
  const teamMembersQuery = useQuery({
    queryKey: ['team-members', teamId],
    queryFn: () => fetchTeamMembers(teamId!),
    enabled: teamId != null,
  });
  // Same query key as the Analytics/Reports tabs, so no extra round trip after visiting them.
  const repoSettingsQuery = useQuery({
    queryKey: ['repoSettings', repoId, teamId ?? null],
    queryFn: () => getRepoSettings(repoId, teamId),
  });
  const attributeDefinitions = useMemo(
    () => resolveSessionAttributionDefinitions(repoSettingsQuery.data),
    [repoSettingsQuery.data],
  );

  const branchOptions = (branchesQuery.data ?? [])
    .map((b) => b.branch)
    .filter((b): b is string => b != null)
    .sort();
  const userOptions = (teamMembersQuery.data ?? []).map((m) => m.email);

  const calendarRange: DateRange = {
    from: new Date(filters.startDate + 'T00:00:00'),
    to: new Date(filters.endDate + 'T00:00:00'),
  };

  // The selected bundle stays selectable even when the current list does not carry it.
  const bundleOptions =
    filters.bundle && !bundleRoots.includes(filters.bundle)
      ? [...bundleRoots, filters.bundle]
      : bundleRoots;

  return (
    <div
      data-testid="okf-filter-strip"
      className="flex flex-shrink-0 flex-wrap items-end gap-3 border-b border-border px-4 py-3"
    >
      <Field label="Date range">
        <button
          type="button"
          data-testid="okf-date-range"
          onClick={() => setDatePickerOpen(true)}
          className={TRIGGER_CLASS}
        >
          {formatRangeLabel(filters.startDate, filters.endDate)}
        </button>
      </Field>

      {branchOptions.length > 0 ? (
        <CheckList
          label="Branches (optional)"
          allLabel="All branches"
          options={branchOptions}
          selected={filters.branches}
          onToggle={(b) => onChange({ branches: toggled(filters.branches, b) })}
          mono
          testId="okf-branches"
        />
      ) : null}

      {teamId != null && userOptions.length > 0 ? (
        <CheckList
          label="Users (team view)"
          allLabel="All users"
          options={userOptions}
          selected={filters.users}
          onToggle={(u) => onChange({ users: toggled(filters.users, u) })}
          testId="okf-users"
        />
      ) : null}

      {attributeDefinitions.length > 0 ? (
        <Field label="Attributes">
          <div className="flex h-9 items-center">
            <AttributeFilterPopover
              repoId={repoId}
              teamId={teamId}
              definitions={attributeDefinitions}
              value={attrParamsToSelection(filters.attr)}
              onChange={(sel) =>
                onChange({
                  attr: attrSelectionToParams(sel, attributeDefinitions),
                })
              }
            />
          </div>
        </Field>
      ) : null}

      <Field label={`Bundle (${bundleRoots.length} in this repo)`}>
        <Select.Root
          value={filters.bundle ?? ALL_BUNDLES}
          onValueChange={(v) =>
            onChange({ bundle: v === ALL_BUNDLES ? null : v })
          }
        >
          <Select.Trigger
            data-testid="okf-bundle-select"
            className="flex h-9 max-w-72 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <span className="truncate">
              <Select.Value />
            </span>
            <Select.Icon>
              <ChevronDown className="size-4 opacity-50" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              className="z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              <Select.Viewport>
                <Select.Item value={ALL_BUNDLES} className={ITEM_CLASS}>
                  <Select.ItemText>All bundles</Select.ItemText>
                </Select.Item>
                {bundleOptions.map((root) => (
                  <Select.Item
                    key={root}
                    value={root}
                    className={`${ITEM_CLASS} font-mono`}
                  >
                    <Select.ItemText>{root}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </Field>

      <Field label="Read heat">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={filters.heat}
          onValueChange={(v) => v && onChange({ heat: v as OkfHeatMetric })}
          data-testid="okf-metric-toggle"
          className="h-9"
        >
          <ToggleGroupItem value="bytes" className="px-2 text-[11px]">
            Bytes
          </ToggleGroupItem>
          <ToggleGroupItem value="calls" className="px-2 text-[11px]">
            Calls
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <DateRangePicker
        open={datePickerOpen}
        onOpenChange={setDatePickerOpen}
        selected={calendarRange}
        onApply={(range) =>
          onChange({
            startDate: localDate(range.from),
            endDate: localDate(range.to),
          })
        }
      />
    </div>
  );
}
