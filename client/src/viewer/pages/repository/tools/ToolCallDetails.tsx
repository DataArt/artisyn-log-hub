/**
 * Right pane of the Tools/MCP tab: one call's header (channel, tool · operation, status,
 * hints), its meta line (time · duration · owner · agent kind · shell · real path, DD-25) and
 * the "Open in session" deep link (DD-19), then the Parameters, Input (stdin), Output, stderr
 * and Signals sections. Every text block collapses beyond `COLLAPSE_HEIGHT_PX` and has a copy
 * button.
 */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Skeleton } from '@/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import { ApiError, fetchToolCallDetail } from '../../../api';
import { routes } from '../../../hooks/useHashRoute';
import { formatDuration, formatLocalTimestamp } from '../../../lib/format';
import type {
  ToolCallDetailResponse,
  ToolCallOutput,
} from '../../../../models/tool-monitoring';
import { CopyButton } from '../session-log/raw-logs/primitives';
import {
  AGENT_KIND_LABELS,
  HINT_LABELS,
  HINT_TITLES,
  SIGNAL_LABELS,
  SIGNAL_TITLES,
  STATUS_BADGE,
  STATUS_BADGE_BASE,
} from './call-labels';
import { ChannelBadge } from './ChannelBadge';
import { CollapsibleBlock } from './CollapsibleBlock';
import { ToolOutputView } from './ToolOutputView';
import type { ToolsCallRef } from './tools-url-state';

export interface ToolCallDetailsProps {
  repoId: number;
  teamId?: number;
  callRef: ToolsCallRef;
}

/** UTF-8 text of a base64 string; invalid bytes become U+FFFD. */
function decodeBase64(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return b64;
  }
}

/** stdin / stdout / stderr as text (`input` and `agentSaw` are always UTF-8). */
function decodeOutput(o: ToolCallOutput): ToolCallOutput {
  if (o.encoding !== 'base64') return o;
  return {
    ...o,
    stdin: o.stdin === undefined ? undefined : decodeBase64(o.stdin),
    stdout: o.stdout === undefined ? undefined : decodeBase64(o.stdout),
    stderr: o.stderr === undefined ? undefined : decodeBase64(o.stderr),
    encoding: 'utf8',
  };
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Section({
  title,
  copyText,
  testId,
  children,
}: {
  title: string;
  copyText?: string;
  testId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-border px-4 py-2" data-testid={testId}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          {title}
        </button>
        {copyText !== undefined && open ? (
          <span className="ml-auto">
            <CopyButton text={copyText} />
          </span>
        ) : null}
      </div>
      {open ? <div className="mt-1.5">{children}</div> : null}
    </section>
  );
}

function TextBlock({ text, className }: { text: string; className?: string }) {
  return (
    <CollapsibleBlock>
      <pre
        className={cn(
          'bg-white p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all',
          className,
        )}
      >
        {text === '' ? '(empty)' : text}
      </pre>
    </CollapsibleBlock>
  );
}

function sessionHref(
  repoId: number,
  teamId: number | undefined,
  link: ToolCallDetailResponse['link'],
): string {
  const q = new URLSearchParams();
  q.set('session', link.sessionId);
  q.set('tab', 'logs');
  if (link.toolUseId) q.set('tu', link.toolUseId);
  const base =
    teamId !== undefined
      ? routes.teamRepo(teamId, repoId)
      : routes.repo(repoId);
  return `${base}?${q.toString()}`;
}

function Parameters({
  call,
  output,
}: {
  call: ToolCallDetailResponse['call'];
  output: ToolCallOutput;
}) {
  if (call.channel === 'mcp') {
    const text = output.input ?? call.inputPreview;
    return (
      <Section
        title="Parameters"
        copyText={prettyJson(text)}
        testId="tools-details-params"
      >
        {text ? (
          <TextBlock text={prettyJson(text)} />
        ) : (
          <div className="text-xs text-muted-foreground">No parameters.</div>
        )}
      </Section>
    );
  }
  const command = output.input ?? call.inputPreview;
  return (
    <Section
      title="Parameters"
      copyText={command}
      testId="tools-details-params"
    >
      <div className="flex flex-col gap-2">
        {command ? (
          <div>
            <div className="mb-0.5 text-[11px] text-muted-foreground">
              Command line
            </div>
            <TextBlock text={command} />
          </div>
        ) : null}
        {call.args && call.args.length > 0 ? (
          <div>
            <div className="mb-0.5 text-[11px] text-muted-foreground">
              Arguments
            </div>
            <ol
              className="rounded border border-border bg-white py-1 font-mono text-xs"
              data-testid="tools-details-args"
            >
              {call.args.map((arg, i) => (
                <li key={i} className="flex gap-2 px-2">
                  <span className="w-6 shrink-0 text-right text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="break-all whitespace-pre-wrap">{arg}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {call.cwd ? (
          <div className="text-xs">
            <span className="text-muted-foreground">cwd </span>
            <span className="font-mono break-all">{call.cwd}</span>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function Signals({ call }: { call: ToolCallDetailResponse['call'] }) {
  return (
    <Section title="Signals" testId="tools-details-signals">
      {call.signals.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No signals for this call.
        </div>
      ) : (
        <TooltipProvider>
          <div className="flex flex-wrap gap-1.5">
            {call.signals.map((s) => (
              <Tooltip key={s}>
                <TooltipTrigger asChild>
                  <span
                    className="cursor-help rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800"
                    data-testid="tools-signal-chip"
                  >
                    {SIGNAL_LABELS[s]}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  {SIGNAL_TITLES[s]}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </TooltipProvider>
      )}
      <div className="mt-1 text-[11px] text-muted-foreground">
        Signals are heuristics over the agent&apos;s next tool calls.
      </div>
    </Section>
  );
}

function Details({
  data,
  repoId,
  teamId,
}: {
  data: ToolCallDetailResponse;
  repoId: number;
  teamId?: number;
}) {
  const { call, link } = data;
  const output = decodeOutput(data.output);
  const status = STATUS_BADGE[call.status];
  const meta = [
    formatLocalTimestamp(call.ts),
    formatDuration(call.durationMs),
    call.sessionOwner.email ?? 'unknown owner',
    AGENT_KIND_LABELS[call.agentKind],
    call.shell,
    call.real,
  ].filter((v): v is string => typeof v === 'string' && v !== '');
  const full = output.stdout ?? output.agentSaw;

  return (
    <div className="flex flex-col" data-testid="tools-call-details">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <ChannelBadge channel={call.channel} />
          <span className="font-mono text-sm font-semibold break-all">
            {call.tool}
            <span className="font-normal text-muted-foreground"> · </span>
            {call.operation}
          </span>
          <span className={cn(STATUS_BADGE_BASE, status.cls)}>
            {status.label}
          </span>
          {call.exitCode !== null ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              exit {call.exitCode}
            </span>
          ) : null}
          {call.hints.map((h) => (
            <span
              key={h}
              className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
              title={HINT_TITLES[h]}
            >
              {HINT_LABELS[h]}
            </span>
          ))}
          <Link
            to={sessionHref(repoId, teamId, link)}
            className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline"
            data-testid="tools-open-in-session"
            title={
              link.toolUseId
                ? 'Open the session log at this call'
                : 'Open the session (this call has no transcript entry)'
            }
          >
            Open in session
            <ExternalLink className="size-3" />
          </Link>
        </div>
        <div
          className="mt-1 text-xs break-all text-muted-foreground"
          data-testid="tools-details-meta"
        >
          {meta.join(' · ')}
        </div>
      </header>

      <Parameters call={call} output={output} />

      {output.stdin !== undefined ? (
        <Section
          title="Input (stdin)"
          copyText={output.stdin}
          testId="tools-details-stdin"
        >
          <TextBlock text={output.stdin} />
        </Section>
      ) : null}

      <Section title="Output" testId="tools-details-output">
        {full !== undefined ? (
          <ToolOutputView full={full} agentSaw={output.agentSaw} />
        ) : (
          <div className="text-xs text-muted-foreground">
            No output text was captured for this call.
          </div>
        )}
      </Section>

      {output.stderr !== undefined && output.stderr !== '' ? (
        <Section
          title="stderr"
          copyText={output.stderr}
          testId="tools-details-stderr"
        >
          <TextBlock text={output.stderr} className="bg-red-50 text-red-900" />
        </Section>
      ) : null}

      <Signals call={call} />
    </div>
  );
}

export function ToolCallDetails({
  repoId,
  teamId,
  callRef,
}: ToolCallDetailsProps) {
  const query = useQuery({
    queryKey: [
      'tool-call-detail',
      repoId,
      teamId ?? null,
      callRef.usageId,
      callRef.callId,
    ],
    queryFn: () =>
      fetchToolCallDetail(repoId, callRef.usageId, callRef.callId, teamId),
  });

  if (query.isLoading) {
    return (
      <div
        className="flex flex-col gap-2 p-4"
        data-testid="tools-details-loading"
      >
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.error) {
    const notFound =
      query.error instanceof ApiError &&
      (query.error.statusCode === 404 || query.error.statusCode === 403);
    return (
      <div
        className="p-6 text-center text-sm text-muted-foreground"
        data-testid="tools-details-error"
      >
        {notFound
          ? 'No access — this call is not available.'
          : 'Error — the call could not be loaded.'}
      </div>
    );
  }
  if (!query.data) return null;
  return <Details data={query.data} repoId={repoId} teamId={teamId} />;
}
