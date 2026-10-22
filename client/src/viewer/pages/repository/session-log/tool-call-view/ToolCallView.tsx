import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../../../lib/cn';
import { formatDuration } from '../../../../lib/format';
import { formatCompact } from '../log-parser';
import { formatOtherToolName, getOtherToolStyle } from '../prompt-turn-helpers';
import type { FileAccess, SubAgentNode, ToolCallDetail } from '../types';
import { BashCommandView } from './BashCommandView';
import { StatusBadge } from './StatusBadge';
import { AgentToolBody, FileToolBody, GenericToolBody } from './tool-bodies';

export interface ToolCallViewProps {
  call: ToolCallDetail;
  charsPerToken: number;
  /** The turn's files, for the Size of a file call (matched by `toolUseId`). */
  turnFiles?: FileAccess[];
  /** Sub-agent nodes, for "Open sub-agent →" on an Agent call (matched by `toolUseID`). */
  subAgents?: SubAgentNode[];
  /** Set → the view is a collapsible block (header toggles the body), open when true. */
  defaultOpen?: boolean;
}

function ToolCallBody({
  call,
  charsPerToken,
  turnFiles,
  subAgents,
}: Omit<ToolCallViewProps, 'defaultOpen'>) {
  if (call.name === 'Bash')
    return <BashCommandView call={call} charsPerToken={charsPerToken} />;
  if (call.name === 'PowerShell')
    return (
      <BashCommandView
        call={call}
        charsPerToken={charsPerToken}
        forceFallback
      />
    );
  if (call.section === 'file')
    return (
      <FileToolBody
        call={call}
        charsPerToken={charsPerToken}
        turnFiles={turnFiles}
      />
    );
  if (call.section === 'agent')
    return (
      <AgentToolBody
        call={call}
        charsPerToken={charsPerToken}
        subAgents={subAgents}
      />
    );
  return <GenericToolBody call={call} charsPerToken={charsPerToken} />;
}

/**
 * One tool call, shared by the Logs modal, the Context Growth step modal, `SubAgentDetail` and the
 * Bash tab (DD-11): a header (tool badge, status and permission badges, `≈N tok`, `⏱` duration for
 * Bash) and a body chosen by tool name and section, always ending in the output block.
 */
export function ToolCallView({
  call,
  charsPerToken,
  turnFiles,
  subAgents,
  defaultOpen,
}: ToolCallViewProps) {
  const collapsible = defaultOpen !== undefined;
  const [open, setOpen] = useState(defaultOpen ?? true);
  const tokens =
    call.result !== undefined
      ? Math.round(call.result.length / charsPerToken)
      : undefined;
  const isShell = call.name === 'Bash' || call.name === 'PowerShell';

  const header = (
    <>
      {collapsible &&
        (open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        ))}
      <span
        className={cn(
          'rounded px-2 py-1 font-mono text-xs font-bold leading-none',
          getOtherToolStyle(call.name),
        )}
      >
        {formatOtherToolName(call.name)}
      </span>
      <StatusBadge call={call} showOk />
      {tokens !== undefined && (
        <span className="font-mono text-xs text-muted-foreground">
          ≈{formatCompact(tokens)} tok
        </span>
      )}
      {isShell && call.durationMs !== undefined && (
        <span
          className="font-mono text-xs text-muted-foreground"
          title="duration"
        >
          ⏱ {formatDuration(call.durationMs)}
        </span>
      )}
    </>
  );

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid="tool-call-view"
      data-call-id={call.id}
    >
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex flex-wrap items-center gap-2 text-left"
        >
          {header}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">{header}</div>
      )}
      {open && (
        <ToolCallBody
          call={call}
          charsPerToken={charsPerToken}
          turnFiles={turnFiles}
          subAgents={subAgents}
        />
      )}
    </div>
  );
}
