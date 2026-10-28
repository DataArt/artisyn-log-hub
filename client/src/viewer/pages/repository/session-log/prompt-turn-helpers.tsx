import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';
import {
  formatBytes,
  formatCompact,
  formatInt,
  stripSystemBlocks,
  BYTES_PER_TOKEN,
  resolveCharsPerToken,
} from './log-parser';
import { DetailTooltip } from '../../../components/DetailTooltip';
import { StatusBadge, StatusMark } from './tool-call-view/StatusBadge';
import { useToolView } from './tool-call-view/ToolViewContext';
import { toRepoRelative } from '@loghub/bash-view';
import type { DetailRow } from '../../../components/DetailTooltip';
import type { ModelPricingMap } from '../../../../models/pricing';
import { formatCost } from '../../../lib/format';
import type {
  FileAccess,
  ImageAccess,
  ToolCallDetail,
  SkillInvocation,
  RuleInjection,
  SkillDefinition,
} from './types';

export function cleanText(text: string): string {
  return stripSystemBlocks(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Max visible characters of an agent id before it is cut with `…`. */
export const AGENT_ID_LIMIT = 12;

export function truncateAgentId(id: string): string {
  return id.length > AGENT_ID_LIMIT ? id.slice(0, AGENT_ID_LIMIT) + '…' : id;
}

export function shortenPath(path: string): { display: string; full: string } {
  const normalized = path.replace(/\\/g, '/');
  return { display: normalized, full: normalized };
}

export const FILE_TOOL_STYLES: Record<string, string> = {
  Read: 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
  Edit: 'bg-orange-500/20 text-orange-700 dark:text-orange-300',
  Write: 'bg-green-500/20 text-green-700 dark:text-green-300',
  Glob: 'bg-purple-500/20 text-purple-700 dark:text-purple-300',
};

export function FileBadge({ tool }: { tool: FileAccess['tool'] }) {
  return (
    <span
      className={cn(
        'inline-block shrink-0 rounded px-2 py-1 font-mono text-xs font-bold leading-none',
        FILE_TOOL_STYLES[tool],
      )}
    >
      {tool}
    </span>
  );
}

export function getOtherToolStyle(name: string): string {
  if (name === 'Bash')
    return 'bg-amber-500/20 text-amber-700 dark:text-amber-300';
  if (name.startsWith('mcp__'))
    return 'bg-violet-500/20 text-violet-700 dark:text-violet-300';
  if (name === 'WebFetch' || name === 'WebSearch')
    return 'bg-sky-500/20 text-sky-700 dark:text-sky-300';
  return 'bg-muted text-foreground/70';
}

export function formatOtherToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.slice(5).split('__');
    return parts.join(':');
  }
  return name;
}

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  Bash: 'Execute shell commands',
  WebFetch: 'Fetch content from a URL',
  WebSearch: 'Search the web',
  Agent: 'Spawn a sub-agent',
  TaskCreate: 'Create a task',
  TaskUpdate: 'Update task status',
  TaskList: 'List tasks',
  TaskGet: 'Get task by ID',
  TaskStop: 'Stop a running task',
  EnterPlanMode: 'Enter plan mode',
  ExitPlanMode: 'Exit plan mode',
};

export function getToolDescription(name: string): string {
  if (TOOL_DESCRIPTIONS[name]) return TOOL_DESCRIPTIONS[name];
  if (name.startsWith('mcp__playwright__'))
    return 'Playwright browser automation';
  if (name.startsWith('mcp__postgres__')) return 'PostgreSQL database query';
  if (name.startsWith('mcp__')) return 'MCP external tool call';
  return 'Tool call';
}

export function buildFileTooltipRows(file: FileAccess): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'Tool', value: file.tool },
    { label: 'Path', value: file.path },
    { label: 'Category', value: file.category },
  ];
  if (file.bytes !== undefined)
    rows.push({ label: 'Size', value: formatBytes(file.bytes) });
  if (file.estTokens !== undefined)
    rows.push({ label: 'Est. tokens', value: `~${formatInt(file.estTokens)}` });
  if (file.accessCount > 1)
    rows.push({ label: 'Access count', value: `${file.accessCount}` });
  if (file.globMatchCount !== undefined)
    rows.push({ label: 'Glob matches', value: `${file.globMatchCount}` });
  return rows;
}

export function buildFileSummary(
  count: number,
  totalBytes: number,
  totalEstTokens: number,
): string {
  const parts: string[] = [`${count} ${count === 1 ? 'file' : 'files'}`];
  if (totalBytes > 0) parts.push(formatBytes(totalBytes));
  if (totalEstTokens > 0) parts.push(`~${formatCompact(totalEstTokens)} tok`);
  return parts.join(' · ');
}

export function buildSkillsSummary(skills: SkillInvocation[]): string {
  const totalTokens = skills.reduce((s, sk) => s + (sk.estTokens ?? 0), 0);
  const count = `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`;
  return totalTokens > 0
    ? `${count} · ~${formatCompact(totalTokens)} tok`
    : count;
}

export function buildRulesSummary(rules: RuleInjection[]): string {
  const totalTokens = rules.reduce((s, r) => s + (r.estTokens ?? 0), 0);
  const names = rules.map((r) => r.name).join(', ');
  return totalTokens > 0
    ? `${names} · ~${formatCompact(totalTokens)} tok`
    : names;
}

export function buildToolsSummary(
  tools: ToolCallDetail[],
  charsPerToken: number = BYTES_PER_TOKEN,
): string {
  const count = tools.length;
  const callLabel = `${count} ${count === 1 ? 'call' : 'calls'}`;
  const totalBytes = tools.reduce((s, t) => s + (t.result?.length ?? 0), 0);
  const totalTok = Math.round(totalBytes / charsPerToken);
  return totalTok > 0
    ? `${callLabel} · ~${formatCompact(totalTok)} tok`
    : callLabel;
}

export function SectionHeader({
  label,
  summary,
  open,
  onToggle,
  icon,
}: {
  label: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  icon?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1.5 text-left transition-colors hover:text-foreground"
    >
      <ChevronRight
        className={cn(
          'size-3 shrink-0 text-muted-foreground transition-transform',
          open && 'rotate-90',
        )}
      />
      {icon && (
        <span className="inline-flex w-4 shrink-0 justify-center text-xs leading-none text-muted-foreground/70 select-none translate-y-px">
          {icon}
        </span>
      )}
      <span className="text-sm font-semibold text-foreground">{label}</span>
      <span className="font-mono text-sm text-muted-foreground">{summary}</span>
    </button>
  );
}

/**
 * One Files-section row (DD-21): the ✗ / ⊘ mark from `file.status` (`title` = the error line),
 * the permission badges of the resolved `call`, and — when `call` is set — clickable to open it.
 */
export function FileRow({
  file,
  call,
  onOpen,
}: {
  file: FileAccess;
  /** The tool call behind this access, resolved by `file.toolUseId`. */
  call?: ToolCallDetail;
  onOpen?: (call: ToolCallDetail) => void;
}) {
  const { display, full } = shortenPath(file.path);
  const label =
    file.tool === 'Glob' && file.globMatchCount !== undefined
      ? `${display} (${file.globMatchCount})`
      : display;
  const isRepeat = file.accessCount > 1;
  const hasBytes = file.bytes !== undefined && file.bytes > 0;
  const hasTokens = file.estTokens !== undefined && file.estTokens > 0;
  const usage =
    hasBytes || hasTokens
      ? [
          hasBytes ? formatBytes(file.bytes!) : '',
          hasTokens ? `~${formatCompact(file.estTokens!)} tok` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '—';
  const fullLabel = display !== full ? full : undefined;
  const clickable = call !== undefined && onOpen !== undefined;

  return (
    <DetailTooltip rows={buildFileTooltipRows(file)}>
      <tr
        className={cn(
          'transition-colors',
          clickable
            ? 'cursor-pointer hover:bg-muted/40'
            : 'cursor-default hover:bg-muted/30',
        )}
        onClick={call && onOpen ? () => onOpen(call) : undefined}
        data-testid="file-row"
        data-tool-use-id={file.toolUseId}
      >
        <td className="w-px py-0.5 pr-2 align-middle whitespace-nowrap">
          <FileBadge tool={file.tool} />
        </td>
        <td className="w-px py-0.5 pr-4 align-middle whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
          {usage}
        </td>
        <td className="py-0.5 align-middle font-mono text-sm text-foreground break-all">
          <StatusMark status={file.status} title={file.error} />
          {(file.status === 'error' || file.status === 'rejected') && ' '}
          <span title={fullLabel} className={cn(fullLabel && 'cursor-help')}>
            {label}
          </span>
          {isRepeat && (
            <span className="ml-1.5 font-mono text-xs text-muted-foreground">
              ×{file.accessCount}
            </span>
          )}
          {call && (
            <StatusBadge
              call={{
                status: 'success',
                permissionRequested: call.permissionRequested,
                permissionDenied: call.permissionDenied,
              }}
              className="ml-1.5 align-middle"
            />
          )}
        </td>
      </tr>
    </DetailTooltip>
  );
}

export function formatImageToolLabel(toolName: string): string {
  if (toolName.startsWith('mcp__playwright__browser_')) {
    return toolName
      .slice('mcp__playwright__browser_'.length)
      .replace(/_/g, ' ');
  }
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice(5).split('__');
    return parts.join(':');
  }
  return toolName || 'image';
}

export function buildImageTooltipRows(img: ImageAccess): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'Tool', value: img.toolName || '—' },
    { label: 'Type', value: img.mediaType },
    { label: 'Size', value: formatBytes(img.bytes) },
  ];
  if (img.width !== undefined && img.height !== undefined)
    rows.push({ label: 'Dimensions', value: `${img.width}×${img.height}` });
  if (img.estInputTokens !== undefined)
    rows.push({
      label: 'Est. input tokens',
      value: `~${formatInt(img.estInputTokens)}`,
    });
  return rows;
}

export function buildImagesSummary(images: ImageAccess[]): string {
  const count = images.length;
  const totalBytes = images.reduce((s, i) => s + i.bytes, 0);
  const totalTok = images.reduce((s, i) => s + (i.estInputTokens ?? 0), 0);
  const label = `${count} ${count === 1 ? 'image' : 'images'}`;
  const parts = [label];
  if (totalBytes > 0) parts.push(formatBytes(totalBytes));
  if (totalTok > 0) parts.push(`~${formatCompact(totalTok)} tok`);
  return parts.join(' · ');
}

export function buildSkillDefinitionRows(
  def: SkillDefinition,
  charsPerToken: number = BYTES_PER_TOKEN,
): DetailRow[] {
  const sourceLabel =
    def.source === 'project'
      ? 'PROJECT'
      : def.source === 'plugin'
        ? 'PLUGIN'
        : 'USER';
  const rows: DetailRow[] = [{ label: 'Source', value: sourceLabel }];
  if (def.source === 'plugin' && def.plugin)
    rows.push({
      label: 'Plugin',
      value: `${def.plugin.id} v${def.plugin.version}`,
    });
  if (def.path) rows.push({ label: 'Path', value: def.path });
  if (def.bytes > 0) {
    rows.push({
      label: 'Size',
      value: `${formatBytes(def.bytes)} · ~${formatCompact(Math.round(def.bytes / charsPerToken))} tok`,
    });
  }
  if (def.description.trim())
    rows.push({ label: 'Desc', value: def.description });
  return rows;
}

export function ImageRow({ img }: { img: ImageAccess }) {
  const label = formatImageToolLabel(img.toolName);
  const dims =
    img.width !== undefined && img.height !== undefined
      ? `${img.width}×${img.height}`
      : undefined;
  const usage = [
    formatBytes(img.bytes),
    img.estInputTokens !== undefined
      ? `~${formatCompact(img.estInputTokens)} tok`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <DetailTooltip rows={buildImageTooltipRows(img)}>
      <tr className="cursor-default transition-colors hover:bg-muted/30">
        <td className="w-px py-0.5 pr-2 align-middle whitespace-nowrap">
          <span className="inline-block shrink-0 rounded px-2 py-1 font-mono text-xs font-bold leading-none bg-pink-500/20 text-pink-700 dark:text-pink-300">
            img
          </span>
        </td>
        <td className="w-px py-0.5 pr-4 align-middle whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
          {usage}
        </td>
        <td className="py-0.5 align-middle font-mono text-sm text-foreground">
          {dims ? (
            <span>
              {label}{' '}
              <span className="text-xs text-muted-foreground">{dims}</span>
            </span>
          ) : (
            label
          )}
        </td>
      </tr>
    </DetailTooltip>
  );
}

function buildInputPreview(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${val}`;
    })
    .join(' ');
}

export function ToolCallRow({
  call,
  onClick,
  charsPerToken = BYTES_PER_TOKEN,
}: {
  call: ToolCallDetail;
  onClick: () => void;
  charsPerToken?: number;
}) {
  const displayName = formatOtherToolName(call.name);
  const { repoRoot } = useToolView();
  // The model's own one-line `description` (Bash, PowerShell, …) reads better than the raw
  // input, so it leads and the rest of the input follows as a muted tail.
  const { description, ...rest } = call.input;
  const lead = typeof description === 'string' ? description.trim() : '';
  const inputPreview = toRepoRelative(
    buildInputPreview(lead ? rest : call.input),
    repoRoot,
  );
  const estTok = call.result
    ? Math.round(call.result.length / charsPerToken)
    : 0;

  return (
    <tr
      className="cursor-pointer transition-colors hover:bg-muted/30"
      onClick={onClick}
    >
      <td className="w-px py-0.5 pr-2 align-middle">
        <span
          className={cn(
            'inline-block max-w-[11rem] truncate rounded px-2 py-1 font-mono text-xs font-bold leading-none',
            getOtherToolStyle(call.name),
          )}
          title={displayName}
        >
          {displayName}
        </span>
      </td>
      <td className="w-px py-0.5 pr-3 align-middle whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
        {estTok > 0 ? `${formatCompact(estTok)}tok` : '—'}
      </td>
      <td
        className="max-w-0 overflow-hidden py-0.5 pr-2 align-middle text-xs truncate"
        data-testid="tool-call-row-preview"
      >
        {lead && <span className="mr-3 text-sm text-foreground">{lead}</span>}
        <span className="font-mono text-muted-foreground">{inputPreview}</span>
      </td>
      <td className="w-px py-0.5 pr-2 align-middle whitespace-nowrap">
        <StatusBadge call={call} />
      </td>
      <td className="w-px py-0.5 pl-1 align-middle text-muted-foreground">
        <ChevronRight className="size-3" />
      </td>
    </tr>
  );
}

/**
 * A compact Agents-section row for an `Agent` call with no activation and no sub-agent node
 * (DD-21): `Agent` badge, description, status; opens the call's modal.
 */
export function OrphanAgentCallRow({
  call,
  onClick,
}: {
  call: ToolCallDetail;
  onClick: () => void;
}) {
  const description =
    typeof call.input.description === 'string' ? call.input.description : '';
  return (
    <tr
      className="cursor-pointer transition-colors hover:bg-muted/40"
      onClick={onClick}
      data-testid="orphan-agent-call-row"
      data-call-id={call.id}
    >
      <td className="w-px py-0.5 pr-2 align-middle">
        <span
          className={cn(
            'inline-block rounded px-2 py-1 font-mono text-xs font-bold leading-none',
            getOtherToolStyle(call.name),
          )}
        >
          {call.name}
        </span>
      </td>
      <td className="max-w-0 overflow-hidden py-0.5 pr-2 align-middle text-xs text-foreground truncate">
        {description || (
          <span className="text-muted-foreground">no description</span>
        )}
      </td>
      <td className="w-px py-0.5 pr-2 align-middle whitespace-nowrap">
        <StatusBadge call={call} showOk />
      </td>
      <td className="w-px py-0.5 pl-1 align-middle text-muted-foreground">
        <ChevronRight className="size-3" />
      </td>
    </tr>
  );
}

export function buildToolTooltipRows(tool: ToolCallDetail): DetailRow[] {
  return [
    { label: 'Tool', value: formatOtherToolName(tool.name) },
    { label: 'Description', value: getToolDescription(tool.name) },
    { label: 'Status', value: tool.status },
  ];
}

export function buildPricingTooltipRows(
  tool: ToolCallDetail,
  pricing?: ModelPricingMap,
  sessionModel?: string,
): DetailRow[] {
  const rows = buildToolTooltipRows(tool);
  if (tool.result && pricing && sessionModel && pricing[sessionModel]) {
    const estTok = Math.round(
      tool.result.length / resolveCharsPerToken(pricing, sessionModel),
    );
    const cost = (estTok * pricing[sessionModel].priceIn) / 1_000_000;
    rows.push({
      label: 'Est. cost',
      value: `~${formatInt(estTok)} tokens × $${pricing[sessionModel].priceIn}/M = ${formatCost(cost)}`,
    });
  }
  return rows;
}
