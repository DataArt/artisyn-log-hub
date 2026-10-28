/**
 * The Output block of the Tools/MCP details pane, in three views:
 *
 * - **Terminal** — the full captured output with its ANSI colours on a light surface; an amber
 *   left bar marks the lines the agent received when it got less than the tool wrote. A table
 *   whose columns the terminal width broke can be re-aligned into a grid. JSON output is shown
 *   as a collapsible tree instead.
 * - **As the agent saw it** — the text of the agent's `tool_result`.
 * - **Raw** — the captured text unchanged, escape sequences included.
 *
 * The copy button copies the text of the active view.
 */
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { CopyButton } from '../session-log/raw-logs/primitives';
import { AnsiText } from './ansi-render';
import { CollapsibleBlock } from './CollapsibleBlock';
import { JsonTree } from './JsonTree';
import {
  detectOutputFormat,
  markAgentSeenLines,
  realignTable,
  splitOutputLines,
  stripAnsi,
  type OutputFormat,
} from './output-format';

type OutputTab = 'terminal' | 'agent' | 'raw';

const TABS: { id: OutputTab; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'agent', label: 'As the agent saw it' },
  { id: 'raw', label: 'Raw' },
];

const TABLE_FORMATS: readonly OutputFormat[] = [
  'pipe-table',
  'fixed-width-table',
  'tsv',
];

export interface ToolOutputViewProps {
  /** The full output the tool wrote (CLI stdout), or the result text for MCP. */
  full: string;
  /** What the agent's `tool_result` held; absent when no transcript side exists. */
  agentSaw?: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripAnsi(text).trim());
  } catch {
    return undefined;
  }
}

function TerminalLines({
  lines,
  seen,
}: {
  lines: string[];
  seen: Set<number> | null;
}) {
  return (
    <pre className="bg-white py-1 font-mono text-xs leading-5 text-foreground">
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            'border-l-[3px] pr-2 pl-2 whitespace-pre-wrap break-all',
            seen?.has(i)
              ? 'border-l-amber-400 bg-amber-50/60'
              : 'border-l-transparent',
          )}
          data-agent-seen={seen?.has(i) ? 'true' : undefined}
        >
          {line === '' ? ' ' : <AnsiText text={line} />}
        </div>
      ))}
    </pre>
  );
}

function RealignedTable({
  text,
  format,
}: {
  text: string;
  format: OutputFormat;
}) {
  const table = useMemo(() => realignTable(text, format), [text, format]);
  return (
    <table
      className="w-full bg-white font-mono text-xs"
      data-testid="tools-output-table"
    >
      {table.headers.length > 0 ? (
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {table.headers.map((h, i) => (
              <th
                key={i}
                className="px-2 py-1 text-left font-semibold whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
      ) : null}
      <tbody>
        {table.rows.map((row, r) => (
          <tr key={r} className="border-b border-border/60 last:border-b-0">
            {row.map((cell, c) => (
              <td key={c} className="px-2 py-0.5 align-top whitespace-pre-wrap">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ToolOutputView({ full, agentSaw }: ToolOutputViewProps) {
  const [tab, setTab] = useState<OutputTab>('terminal');
  const [realign, setRealign] = useState(true);

  const format = useMemo(() => detectOutputFormat(full), [full]);
  const json = useMemo(
    () => (format === 'json' ? parseJson(full) : undefined),
    [format, full],
  );
  const lines = useMemo(() => splitOutputLines(full), [full]);
  // The bar only means something when the agent got less than the tool wrote.
  const seen = useMemo(() => {
    if (agentSaw === undefined || agentSaw === full) return null;
    return new Set(markAgentSeenLines(full, agentSaw));
  }, [full, agentSaw]);
  const isTable = TABLE_FORMATS.includes(format);

  let copyText: string;
  let body;
  if (tab === 'terminal') {
    if (json !== undefined) {
      copyText = JSON.stringify(json, null, 2);
      body = (
        <div className="bg-white p-2">
          <JsonTree value={json} />
        </div>
      );
    } else if (isTable && realign) {
      copyText = stripAnsi(full);
      body = <RealignedTable text={full} format={format} />;
    } else {
      copyText = stripAnsi(full);
      body = <TerminalLines lines={lines} seen={seen} />;
    }
  } else if (tab === 'agent') {
    copyText = agentSaw ?? '';
    body =
      agentSaw === undefined ? (
        <div className="bg-white p-3 text-xs text-muted-foreground">
          The transcript holds no result for this call.
        </div>
      ) : (
        <pre className="bg-white p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
          {agentSaw === '' ? '(empty)' : stripAnsi(agentSaw)}
        </pre>
      );
  } else {
    copyText = full;
    body = (
      <pre className="bg-white p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
        {full === '' ? '(empty)' : full}
      </pre>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="tools-output-view">
      <div className="flex items-center gap-2">
        <div
          role="tablist"
          aria-label="Output view"
          className="flex rounded-md border border-border p-0.5"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px]',
                tab === t.id
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              data-testid={`tools-output-tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'terminal' && isTable && json === undefined ? (
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={realign}
              onChange={(e) => setRealign(e.target.checked)}
              className="size-3"
            />
            Realign columns
          </label>
        ) : null}
        <span className="ml-auto">
          <CopyButton text={copyText} />
        </span>
      </div>
      {tab === 'terminal' &&
      seen !== null &&
      seen.size > 0 &&
      !(isTable && realign) &&
      json === undefined ? (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="inline-block h-3 w-[3px] bg-amber-400" />
          Lines the agent received
        </div>
      ) : null}
      <CollapsibleBlock key={tab}>{body}</CollapsibleBlock>
    </div>
  );
}
