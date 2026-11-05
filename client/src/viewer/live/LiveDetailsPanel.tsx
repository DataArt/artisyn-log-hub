/**
 * Right-hand details panel of the Live modal (2026-11-04 otel-live-view, FR-9 / DD-10), per
 * `wireframes/details-panel-variants.svg`: one layout for parent nodes (home / team / No team /
 * repo), one for a session and one for an agent. Figures come from the node's totals and the
 * poll's `details`; masked fields (DD-11) read "prompt hidden" / "masked". Session panels carry
 * "Open session ↗", repo / team panels "Open OTEL tab ↗" (DD-16); agent panels carry no link.
 */
import { X } from 'lucide-react';
import type { OtelLiveDetails, OtelLiveNode } from '../../models/otel-live';
import {
  formatCount,
  formatMicrosUsd,
} from '../pages/repository/otel/otel-format';
import { formatLiveClock, formatLiveDuration } from './live-format';
import {
  liveOtelTabTarget,
  liveSessionTarget,
  useOpenLiveTarget,
  type LiveLinkTarget,
} from './live-links';
import { OTEL_LIVE_ENDED_MS } from './live.constants';
import {
  costAndTokens,
  DetailRow,
  DetailSection,
  LatestCalls,
  LatestEvents,
  RankedList,
  TopTools,
} from './LiveDetailsParts';
import { liveNodeLabel } from './LiveTree';

export interface LiveDetailsPanelProps {
  /** The panel node (tree, breakdown or a session's agents); null until the server has sent it. */
  node: OtelLiveNode | null;
  /** `details` of an answer for this panel key; null while loading. */
  details: OtelLiveDetails | null;
  /** `generatedAt` of the answer, epoch ms. */
  now: number;
  onClose: () => void;
  onOpenPanel: (key: string) => void;
}

const TYPE_TITLES: Record<OtelLiveNode['type'], string> = {
  home: 'Home',
  team: 'Team',
  noteam: 'No team',
  repo: 'Repository',
  session: 'Session',
  agent: 'Agent',
};

function LinkButton({
  target,
  children,
  testId,
}: {
  target: LiveLinkTarget;
  children: string;
  testId: string;
}) {
  const open = useOpenLiveTarget();
  return (
    <button
      type="button"
      className="text-sm text-primary hover:underline"
      onClick={() => open(target)}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function ParentDetails({
  node,
  d,
}: {
  node: OtelLiveNode;
  d: OtelLiveDetails;
}) {
  const target = liveOtelTabTarget(node);
  return (
    <>
      <dl>
        <DetailRow label="Live sessions" testId="live-details-live-sessions">
          {formatCount(node.totals.liveSessions)}
        </DetailRow>
        <DetailRow label="Live users">{formatCount(d.liveUsers)}</DetailRow>
        <DetailRow label="Cost (since start)">
          {formatMicrosUsd(node.totals.costUsdMicros)}
        </DetailRow>
        <DetailRow label="Longest running">
          {formatLiveDuration(d.longestRunningMs ?? node.totals.runningMs)}
        </DetailRow>
      </dl>
      <DetailSection title="Top users" testId="live-details-users">
        <RankedList
          items={(d.topUsers ?? []).map((u) => ({
            key: u.email,
            label: `${u.email} (${u.liveSessions})`,
            value: formatMicrosUsd(u.costUsdMicros),
          }))}
        />
      </DetailSection>
      {node.type === 'team' && (
        <DetailSection title="Top repos" testId="live-details-repos">
          <RankedList
            items={(d.topRepos ?? []).map((r) => ({
              key: String(r.repoId),
              label: r.label,
              value: formatMicrosUsd(r.costUsdMicros),
            }))}
          />
        </DetailSection>
      )}
      <DetailSection
        title="Top models"
        hint="last 2 h"
        testId="live-details-models"
      >
        <RankedList
          items={(d.topModels ?? []).map((m) => ({
            key: m.model,
            label: `${m.model || 'unknown'} (${formatCount(m.calls)})`,
            value: formatMicrosUsd(m.costUsdMicros),
          }))}
        />
      </DetailSection>
      {target !== null && (
        <LinkButton target={target} testId="live-details-open-otel">
          {node.type === 'team'
            ? 'Open team OTEL tab ↗'
            : 'Open repository OTEL tab ↗'}
        </LinkButton>
      )}
    </>
  );
}

function SessionDetails({
  node,
  d,
  now,
  onOpenPanel,
}: {
  node: OtelLiveNode;
  d: OtelLiveDetails;
  now: number;
  onOpenPanel: (key: string) => void;
}) {
  const t = node.totals;
  return (
    <>
      <dl>
        <DetailRow label="User">
          {d.userEmail ?? node.userEmail ?? '—'}
        </DetailRow>
        <DetailRow label="Started">
          {formatLiveClock(d.startedAt ?? t.firstEventAt, now)} (
          {formatLiveDuration(t.runningMs)})
        </DetailRow>
        <DetailRow label="Last activity">
          {formatLiveClock(t.lastActivityAt, now)}
        </DetailRow>
        <DetailRow label="Cost / tokens">{costAndTokens(t)}</DetailRow>
        <DetailRow label="Claude Code">{d.claudeVersion ?? '—'}</DetailRow>
      </dl>
      <DetailSection title="First prompt" testId="live-details-prompt">
        <p
          className="line-clamp-4 text-xs break-words"
          title={d.firstPrompt ?? undefined}
        >
          {d.firstPrompt ?? (
            <span className="text-muted-foreground">prompt hidden</span>
          )}
        </p>
      </DetailSection>
      <DetailSection title="Agents" testId="live-details-agents">
        <RankedList
          items={(d.agents ?? []).map((a) => ({
            key: a.key,
            label: `${a.live ? '●' : '○'} ${liveNodeLabel(a)}`,
            value: formatMicrosUsd(a.totals.costUsdMicros),
            onClick: () => onOpenPanel(a.key),
          }))}
        />
      </DetailSection>
      <TopTools tools={d.topTools} masked={d.attributesMasked} />
      <LatestEvents events={d.events} masked={d.attributesMasked} now={now} />
      {d.attributesMasked && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="live-details-masked"
        >
          This team hides prompts and span attributes of other members.
        </p>
      )}
    </>
  );
}

function AgentDetails({
  node,
  d,
  now,
}: {
  node: OtelLiveNode;
  d: OtelLiveDetails;
  now: number;
}) {
  const t = node.totals;
  const structure = d.calls?.[0]?.structure ?? null;
  const kind =
    structure === 'subagent' || (structure === null && node.agentKey !== 'main')
      ? 'sub-agent'
      : 'main';
  return (
    <>
      <dl>
        <DetailRow label="agent_id">{node.agentKey ?? '—'}</DetailRow>
        <DetailRow label="Type">{kind}</DetailRow>
        <DetailRow label="Model">{d.model ?? '—'}</DetailRow>
        <DetailRow label="Calls">{formatCount(t.calls)}</DetailRow>
        <DetailRow label="Cost / tokens">{costAndTokens(t)}</DetailRow>
        <DetailRow label="Running">{formatLiveDuration(t.runningMs)}</DetailRow>
      </dl>
      <TopTools tools={d.topTools} masked={d.attributesMasked} />
      <LatestEvents events={d.events} masked={d.attributesMasked} now={now} />
      <LatestCalls calls={d.calls} now={now} />
    </>
  );
}

export function LiveDetailsPanel({
  node,
  details,
  now,
  onClose,
  onOpenPanel,
}: LiveDetailsPanelProps) {
  const type = node?.type ?? details?.type ?? null;
  const live = node?.live ?? details?.live ?? true;
  const sessionTarget = node !== null ? liveSessionTarget(node) : null;
  return (
    <div className="space-y-3" data-testid="live-details" data-key={node?.key}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{type !== null ? TYPE_TITLES[type] : 'Details'}</span>
            {!live && (
              <span className="rounded bg-muted px-1 text-[10px]">ended</span>
            )}
          </div>
          {node !== null && (
            <p className="truncate font-medium" title={liveNodeLabel(node)}>
              {liveNodeLabel(node)}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Close details"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          data-testid="live-details-close"
        >
          <X className="size-4" />
        </button>
      </div>
      {type === 'session' && !live && (
        <p
          className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
          data-testid="live-details-ended-note"
        >
          No OTEL data for {OTEL_LIVE_ENDED_MS / 60_000} min — figures are
          final.
        </p>
      )}
      {sessionTarget !== null && (
        <LinkButton target={sessionTarget} testId="live-details-open-session">
          Open session ↗
        </LinkButton>
      )}
      {node === null || details === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : node.type === 'session' ? (
        <SessionDetails
          node={node}
          d={details}
          now={now}
          onOpenPanel={onOpenPanel}
        />
      ) : node.type === 'agent' ? (
        <AgentDetails node={node} d={details} now={now} />
      ) : (
        <ParentDetails node={node} d={details} />
      )}
    </div>
  );
}
