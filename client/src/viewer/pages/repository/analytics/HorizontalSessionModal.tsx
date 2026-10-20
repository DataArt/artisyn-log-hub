/**
 * Session-list modal opened by clicking a row in the horizontal (ranking) analytics
 * layout. Extracted from `HorizontalBarChart.tsx` to keep that file under the
 * component-size split threshold.
 */
import { cn } from '@/lib/cn';
import type { TimelineSession } from '../../../../models/repositories';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import { PROMPT_HIDDEN_LABEL } from '../../../lib/access-mode-copy';

export interface ModalState {
  label: string;
  sessions: TimelineSession[];
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (totalSec >= 3600) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function SessionRow({
  session,
  className,
  onSessionClick,
}: {
  session: TimelineSession;
  className?: string;
  onSessionClick?: (sessionId: string) => void;
}) {
  const start = new Date(session.startTime);
  const end = new Date(session.endTime);
  const startStr = start.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const endStr = end.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const prompt = session.firstPrompt ?? PROMPT_HIDDEN_LABEL;
  const preview = prompt.length > 50 ? prompt.slice(0, 50) + '…' : prompt;
  return (
    <div
      className={cn(
        className,
        onSessionClick &&
          'cursor-pointer rounded hover:bg-accent/50 transition-colors',
      )}
      onClick={
        onSessionClick ? () => onSessionClick(session.sessionId) : undefined
      }
    >
      <div className="text-xs text-muted-foreground">
        {startStr}–{endStr}
      </div>
      {preview && (
        <div className="text-xs font-medium break-words mt-0.5">{preview}</div>
      )}
      <div className="flex flex-wrap gap-x-3 text-xs mt-0.5 font-mono">
        <span>{formatDuration(session.workTimeMs)}</span>
        {session.totalCost != null && (
          <span>{formatCost(session.totalCost)}</span>
        )}
        <span className="text-muted-foreground">
          {session.gitBranch ?? '—'}
        </span>
      </div>
    </div>
  );
}

export function HorizontalSessionModal({
  state,
  onClose,
  onSessionClick,
}: {
  state: ModalState;
  onClose: () => void;
  onSessionClick: (sessionId: string) => void;
}) {
  function handleSessionClick(sessionId: string) {
    onClose();
    onSessionClick(sessionId);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{state.label}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto max-h-[60vh]">
          {state.sessions.map((session, i) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              className={i > 0 ? 'border-t border-border pt-2 mt-2' : undefined}
              onSessionClick={
                session.sessionId ? handleSessionClick : undefined
              }
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
