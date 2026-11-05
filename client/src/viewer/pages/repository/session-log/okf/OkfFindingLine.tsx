/**
 * One finding line of the OKF verdict card: severity dot, the finding text, the `stale` /
 * `removed` chips and — on a second muted line — the "→ action" of DD-26 (`okfActionText`).
 * `info` findings are grey: they are listed but never change the verdict level.
 */
import { formatBytes } from '@/lib/format';
import { okfActionText } from '@/lib/okf/okf-action-text';
import { formatOkfFinding, isInfoFinding } from '@/lib/okf/okf-verdict-text';
import type { OkfFinding } from '../../../../../models/repositories';

function dotColour(finding: OkfFinding): string {
  if (isInfoFinding(finding)) return 'bg-slate-400';
  return finding.severity === 'mess' ? 'bg-red-500' : 'bg-amber-500';
}

function Chip({ children, testId }: { children: string; testId: string }) {
  return (
    <span
      data-testid={testId}
      className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground"
    >
      {children}
    </span>
  );
}

function staleText(stale: NonNullable<OkfFinding['stale']>): string {
  const old =
    stale.oldSize !== null ? ` · was ${formatBytes(stale.oldSize)}` : '';
  return `stale · ${stale.sessions} of ${stale.total} sessions on the current version${old}`;
}

export function OkfFindingLine({
  finding,
  onClick,
}: {
  finding: OkfFinding;
  onClick: () => void;
}) {
  const info = isInfoFinding(finding);
  const action = okfActionText(finding);
  return (
    <button
      type="button"
      data-testid="okf-why-line"
      data-severity={finding.severity}
      onClick={onClick}
      className={`flex w-full flex-col rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60 ${
        info ? 'text-muted-foreground' : ''
      }`}
    >
      <span className="flex w-full items-center gap-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${dotColour(finding)}`}
        />
        <span className="min-w-0 flex-1">{formatOkfFinding(finding)}</span>
        {finding.stale ? (
          <Chip testId="okf-finding-stale">{staleText(finding.stale)}</Chip>
        ) : null}
        {finding.removed ? (
          <Chip testId="okf-finding-removed">removed from KB</Chip>
        ) : null}
      </span>
      {action ? (
        <span
          data-testid="okf-finding-action"
          className="pl-3.5 text-[11px] text-muted-foreground"
        >
          → {action}
        </span>
      ) : null}
    </button>
  );
}
