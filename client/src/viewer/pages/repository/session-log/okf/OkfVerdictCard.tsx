/**
 * Verdict card of the OKF tabs: level badge, qualifiers, clickable "Why" lines (worst first),
 * and — on the session variant — the Read top 5 and the "How agents reached the KB" chips.
 * The repo variant shows the KB session count instead; its anomaly lines are the same Why
 * lines. Every line click is forwarded to `onNodeClick` so the tab can scroll the tree to it.
 */
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/ui/badge';
import { formatBytes } from '@/lib/format';
import {
  entryLabel,
  formatOkfFinding,
  levelLabel,
  qualifierLabel,
} from '@/lib/okf/okf-verdict-text';
import type {
  OkfAgent,
  OkfReadTopItem,
  OkfVerdict,
  OkfVerdictLevel,
} from '../../../../../models/repositories';
import { okfAgentLabel } from './okf-tree';

type BadgeVariant = 'success' | 'warning' | 'destructive' | 'secondary';

const LEVEL_VARIANT: Record<OkfVerdictLevel, BadgeVariant> = {
  ok: 'success',
  fix: 'warning',
  mess: 'destructive',
  kb_not_used: 'secondary',
  not_enough_data: 'secondary',
};

export interface OkfVerdictCardProps {
  verdict: OkfVerdict;
  variant: 'session' | 'repo';
  onNodeClick: (bundle: string | null, path?: string) => void;
  /** Session variant. */
  readTop?: readonly OkfReadTopItem[];
  agents?: readonly OkfAgent[];
  rootSessionId?: string;
  /** Repo variant. */
  kbSessions?: number;
  totalSessions?: number;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function LineButton({
  onClick,
  children,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60"
    >
      {children}
    </button>
  );
}

export function OkfVerdictCard({
  verdict,
  variant,
  onNodeClick,
  readTop = [],
  agents = [],
  rootSessionId = '',
  kbSessions,
  totalSessions,
}: OkfVerdictCardProps) {
  const top5 = readTop.slice(0, 5);
  const entryAgents = agents.filter((a) => a.entry !== null);

  return (
    <div
      data-testid="okf-verdict-card"
      className="space-y-3 rounded-md border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Verdict
        </span>
        <Badge
          variant={LEVEL_VARIANT[verdict.level] ?? 'secondary'}
          data-testid="okf-verdict-level"
        >
          {levelLabel(verdict.level)}
        </Badge>
        {verdict.qualifiers.map((q) => (
          <Badge key={q} variant="outline" className="text-muted-foreground">
            {qualifierLabel(q, verdict)}
          </Badge>
        ))}
        {variant === 'repo' && kbSessions !== undefined ? (
          <span className="text-xs text-muted-foreground">
            {kbSessions.toLocaleString()} KB sessions
            {totalSessions !== undefined
              ? ` of ${totalSessions.toLocaleString()}`
              : ''}
          </span>
        ) : null}
      </div>

      {verdict.findings.length > 0 ? (
        <div>
          <SectionTitle>
            {variant === 'repo' ? 'Anomalies' : 'Why'}
          </SectionTitle>
          {verdict.findings.map((f, i) => (
            <LineButton
              key={`${f.rule}:${i}`}
              testId="okf-why-line"
              onClick={() => onNodeClick(f.node.bundle, f.node.path)}
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  f.severity === 'mess' ? 'bg-red-500' : 'bg-amber-500'
                }`}
              />
              <span className="min-w-0 flex-1">{formatOkfFinding(f)}</span>
            </LineButton>
          ))}
          {variant === 'session' ? (
            <div className="px-1 text-[11px] text-muted-foreground">
              Per agent — the same article read by several agents is not a
              finding.
            </div>
          ) : null}
        </div>
      ) : null}

      {variant === 'session' && top5.length > 0 ? (
        <div>
          <SectionTitle>Read · top 5 by bytes</SectionTitle>
          {top5.map((r) => (
            <LineButton
              key={`${r.bundle ?? ''}:${r.path}`}
              testId="okf-read-top"
              onClick={() => onNodeClick(r.bundle, r.path)}
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {r.path}
              </span>
              {r.ownEdit ? (
                <RefreshCw
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label="read after own edit"
                />
              ) : null}
              <span className="w-16 shrink-0 text-right font-mono tabular-nums">
                {formatBytes(r.readBytes)}
              </span>
            </LineButton>
          ))}
        </div>
      ) : null}

      {variant === 'session' && entryAgents.length > 0 ? (
        <div>
          <SectionTitle>
            How agents reached the KB · {entryAgents.length} agents
          </SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {entryAgents.map((a) => (
              <span
                key={a.id}
                data-testid="okf-entry-chip"
                className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px]"
                title={a.taskHead}
              >
                <span className="font-mono">
                  {okfAgentLabel(a.id, rootSessionId)}
                </span>
                <span className="text-muted-foreground">
                  → {a.files.length}{' '}
                  {a.files.length === 1 ? 'article' : 'articles'}
                </span>
                <span className="font-medium">
                  {a.entry ? entryLabel(a.entry) : ''}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
