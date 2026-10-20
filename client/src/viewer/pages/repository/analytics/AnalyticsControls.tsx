import { Select } from 'radix-ui';
import { BarChart2, BarChartHorizontal, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import type { SessionAttributionAttributeDef } from '../../../../models/repositories';
import type { AnalyticsState } from './analytics-state';
import { VIEW_OPTIONS } from './analytics-state';
import { isUsageAnalyticsView } from './UsageAnalyticsPanel';
import { SESSION_ATTRIBUTION_TYPE_LABELS } from '../../../lib/session-attribution-ui';
import {
  type FilesMetricKey,
  type VisionMetricKey,
  type ProductivityMetricKey,
  VISION_METRICS,
  PRODUCTIVITY_METRICS,
} from './metrics';
import {
  CHANGE_SURFACE_METRICS,
  type ChangeSurfaceMetricKey,
} from './change-surface-metrics';
import { MetricSelect } from './MetricSelect';

// Header toolbar for RepositoryAnalytics — date range, groupBy, branch/user filters,
// layout toggle, view selector and per-view sub-metric selectors. Split out of
// RepositoryAnalytics.tsx (component-size split); purely presentational, all
// state and derived values are owned by the parent.

interface FilesMetricOption {
  key: FilesMetricKey;
  label: string;
  description: string;
}

interface Props {
  state: AnalyticsState;
  teamId?: number;
  branchList: string[];
  showBranchFilter: boolean;
  showUserFilter: boolean;
  teamMemberEmails: string[];
  filesMetric: FilesMetricKey;
  filesMetrics: FilesMetricOption[];
  visionMetric: VisionMetricKey;
  productivityMetric: ProductivityMetricKey;
  /** The Change Surface view's sub-metric (concentration or one of the three
   * volume counts). */
  changeSurfaceMetric: ChangeSurfaceMetricKey;
  /** Resolved AI Session Attribution definitions for this repo, feeding
   * the "Group by" dropdown's ATTRIBUTES section; empty when the feature isn't configured,
   * in which case that section renders nothing. */
  attributeDefinitions: SessionAttributionAttributeDef[];
  onRangeToggle: (value: string) => void;
  onCustomButtonClick: () => void;
  formatCustomLabel: (from: string, to: string) => string;
  onGroupByChange: (value: string) => void;
  onToggleBranch: (branch: string) => void;
  onToggleUser: (user: string) => void;
  onLayoutToggle: (layout: 'vertical' | 'horizontal') => void;
  onViewToggle: (value: string) => void;
  onFilesMetricChange: (value: FilesMetricKey) => void;
  onVisionMetricChange: (value: VisionMetricKey) => void;
  onProductivityMetricChange: (value: ProductivityMetricKey) => void;
  onChangeSurfaceMetricChange: (value: ChangeSurfaceMetricKey) => void;
}

export function AnalyticsControls({
  state,
  teamId,
  branchList,
  showBranchFilter,
  showUserFilter,
  teamMemberEmails,
  filesMetric,
  filesMetrics,
  visionMetric,
  productivityMetric,
  changeSurfaceMetric,
  attributeDefinitions,
  onRangeToggle,
  onCustomButtonClick,
  formatCustomLabel,
  onGroupByChange,
  onToggleBranch,
  onToggleUser,
  onLayoutToggle,
  onViewToggle,
  onFilesMetricChange,
  onVisionMetricChange,
  onProductivityMetricChange,
  onChangeSurfaceMetricChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Date range selector */}
      <ToggleGroup
        type="single"
        variant="outline"
        value={state.range !== 'custom' ? state.range : ''}
        onValueChange={onRangeToggle}
      >
        {(['1d', '2d', '3d', '1w', '2w', '1m'] as const).map((r) => (
          <ToggleGroupItem key={r} value={r}>
            {r}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {/* Custom date range button */}
      <button
        onClick={onCustomButtonClick}
        className={[
          'flex h-9 items-center rounded-md border px-3 text-sm font-medium whitespace-nowrap transition-colors',
          state.range === 'custom'
            ? 'border-input bg-accent text-accent-foreground'
            : 'border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
        ].join(' ')}
      >
        {state.range === 'custom' && state.customFrom && state.customTo
          ? formatCustomLabel(state.customFrom, state.customTo)
          : 'Custom'}
      </button>

      {/* Group by — not applicable to the usage table views, which aggregate over the whole
          filtered set and carry their own in-view grouping/selector controls where relevant. */}
      {!isUsageAnalyticsView(state.view) && (
        <Select.Root value={state.groupBy} onValueChange={onGroupByChange}>
          <Select.Trigger className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring">
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
                  <Select.ItemText>Group by branch</Select.ItemText>
                </Select.Item>
                {teamId != null && (
                  <Select.Item
                    value="user"
                    className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                  >
                    <Select.ItemText>Group by user</Select.ItemText>
                  </Select.Item>
                )}
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
                        <Select.ItemText>Group by {def.label}</Select.ItemText>
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
      )}

      {/* Branch filter */}
      {showBranchFilter && (
        <Popover>
          <PopoverTrigger asChild>
            <button className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/50">
              Branches
              {state.branches.length > 0 && (
                <span className="ml-1 rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                  {state.branches.length}
                </span>
              )}
              <ChevronDown className="size-4 opacity-50" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-2">
            <div className="flex flex-col gap-1">
              {branchList.map((branch) => (
                <label
                  key={branch}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    checked={state.branches.includes(branch)}
                    onChange={() => onToggleBranch(branch)}
                    className="size-4"
                  />
                  <span className="truncate font-mono">{branch}</span>
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* User filter */}
      {showUserFilter && state.groupBy !== 'user' && (
        <Popover>
          <PopoverTrigger asChild>
            <button className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm shadow-xs hover:bg-accent/50">
              Users
              {state.users.length > 0 && (
                <span className="ml-1 rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                  {state.users.length}
                </span>
              )}
              <ChevronDown className="size-4 opacity-50" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-2">
            <div className="flex flex-col gap-1">
              {teamMemberEmails.map((email) => (
                <label
                  key={email}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    checked={state.users.includes(email)}
                    onChange={() => onToggleUser(email)}
                    className="size-4"
                  />
                  <span className="truncate">{email}</span>
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* Layout toggle — vertical/horizontal applies to the D3 bar charts only; the usage
          views are tables, so they have no second layout. */}
      {!isUsageAnalyticsView(state.view) && (
        <TooltipProvider>
          <div className="flex items-center border border-input rounded-md">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="layout-toggle-vertical"
                  onClick={() => onLayoutToggle('vertical')}
                  className={cn(
                    'p-2 rounded-l-md',
                    state.layout === 'vertical' && 'bg-accent',
                  )}
                >
                  <BarChart2 className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Vertical (timeline)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="layout-toggle-horizontal"
                  onClick={() => onLayoutToggle('horizontal')}
                  className={cn(
                    'p-2 rounded-r-md',
                    state.layout === 'horizontal' && 'bg-accent',
                  )}
                >
                  <BarChartHorizontal className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Horizontal (ranking)</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      )}

      {/* View selector */}
      <Select.Root value={state.view} onValueChange={onViewToggle}>
        <Select.Trigger className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring">
          <Select.Value />
          <Select.Icon>
            <ChevronDown className="size-4 opacity-50" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            <Select.Viewport>
              {VIEW_OPTIONS.map((opt) => (
                <Select.Item
                  key={opt.value}
                  value={opt.value}
                  className="flex cursor-default select-none flex-col rounded-sm px-2 py-1.5 outline-none hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                >
                  <Select.ItemText>{opt.label}</Select.ItemText>
                  <span className="text-xs text-muted-foreground">
                    {opt.description}
                  </span>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>

      {/* Sub-metric selector — only for views that have multiple metrics */}
      {state.view === 'files' && (
        <MetricSelect
          value={filesMetric}
          options={filesMetrics}
          onChange={onFilesMetricChange}
          scrollable
        />
      )}

      {state.view === 'vision' && (
        <MetricSelect
          value={visionMetric}
          options={VISION_METRICS}
          onChange={onVisionMetricChange}
        />
      )}

      {state.view === 'productivity' && (
        <MetricSelect
          value={productivityMetric}
          options={PRODUCTIVITY_METRICS}
          onChange={onProductivityMetricChange}
        />
      )}

      {/* The Change Surface view's sub-metric selector. */}
      {state.view === 'change-surface' && (
        <MetricSelect
          value={changeSurfaceMetric}
          options={CHANGE_SURFACE_METRICS}
          onChange={onChangeSurfaceMetricChange}
        />
      )}
    </div>
  );
}
