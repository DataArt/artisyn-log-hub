import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import { computeStartupTotal } from './sysctx-anatomy/sysctx-anatomy';
import { fmtInt } from './sysctx-anatomy/AnatomyCells';

interface Props {
  /** The raw main transcript lines; nothing renders when absent or empty. */
  main: Record<string, unknown>[] | undefined;
  /** Opens the System context anatomy tab. The link is hidden when not given. */
  onOpenAnatomy?: () => void;
}

/**
 * One-line startup-context summary at the top of the Logs tab (DD 16): the exact startup token
 * total and a link to the System context anatomy tab, which holds the full breakdown.
 */
export function StartupContextLine({ main, onOpenAnatomy }: Props) {
  const total = useMemo(
    () => (main && main.length > 0 ? computeStartupTotal(main) : null),
    [main],
  );

  if (!main || main.length === 0) return null;

  return (
    <div
      data-testid="startup-context-line"
      className="flex items-center gap-2 border-b border-border bg-violet-500/5 px-4 py-2"
    >
      <FileText className="size-3.5 shrink-0 text-violet-500" />
      <span className="text-sm font-semibold text-foreground">
        Startup context
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        · {total === null ? 'total unknown' : `${fmtInt(total)} tokens`}
      </span>
      {onOpenAnatomy && (
        <button
          type="button"
          onClick={onOpenAnatomy}
          className="ml-2 text-xs font-medium text-primary hover:underline"
        >
          View anatomy →
        </button>
      )}
    </div>
  );
}
