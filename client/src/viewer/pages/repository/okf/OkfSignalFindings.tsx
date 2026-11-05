/**
 * Section B of the repo OKF tab: the value-signal findings (routing miss, searched after
 * reading, dead pointers, catalog) the server merged into the verdict, as the same clickable
 * finding lines as the verdict card. Empty → a muted "nothing to check" line.
 */
import type { OkfFinding } from '../../../../models/repositories';
import { OkfFindingLine } from '../session-log/okf/OkfFindingLine';

export function OkfSignalFindings({
  findings,
  onNodeClick,
}: {
  findings: readonly OkfFinding[];
  onNodeClick: (bundle: string | null, path?: string) => void;
}) {
  return (
    <div
      data-testid="okf-signal-findings"
      className="max-w-4xl rounded-md border border-border bg-card p-3"
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Value signals to check by hand
      </div>
      {findings.length === 0 ? (
        <div className="px-1 text-xs text-muted-foreground">
          No value signal fired in this period.
        </div>
      ) : (
        findings.map((f, i) => (
          <OkfFindingLine
            key={`${f.rule}:${i}`}
            finding={f}
            onClick={() => onNodeClick(f.node.bundle, f.node.path)}
          />
        ))
      )}
    </div>
  );
}
