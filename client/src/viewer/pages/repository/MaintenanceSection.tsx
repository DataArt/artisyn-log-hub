import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { recomputeAllSessions } from '../../api';
import { Button } from '../../ui/button';
import { cn } from '../../lib/cn';

// ---------------------------------------------------------------------------
// MaintenanceSection — "Recompute all sessions"
// ---------------------------------------------------------------------------

interface MaintenanceSectionProps {
  repoId: number;
  teamId?: number;
  readOnly: boolean;
}

export function MaintenanceSection({
  repoId,
  teamId,
  readOnly,
}: MaintenanceSectionProps) {
  const [isRecomputing, setIsRecomputing] = useState(false);
  const [message, setMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  async function handleRecompute() {
    setMessage(null);
    setIsRecomputing(true);
    try {
      const result = await recomputeAllSessions(repoId, teamId);
      setMessage({
        kind: 'success',
        text: `Recomputed stats for ${result.recomputed} session${result.recomputed === 1 ? '' : 's'}.`,
      });
    } catch (e) {
      setMessage({
        kind: 'error',
        text: e instanceof Error ? e.message : 'Recompute failed',
      });
    } finally {
      setIsRecomputing(false);
    }
  }

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        Recompute file and session statistics for every session in this
        repository from the stored logs. Use this if stats look stale after a
        server-side calculation fix.
      </p>

      {!readOnly && (
        <Button
          size="sm"
          variant="outline"
          disabled={isRecomputing}
          onClick={() => void handleRecompute()}
        >
          {isRecomputing && <Loader2 className="size-3.5 animate-spin" />}
          Recompute all sessions
        </Button>
      )}

      {message && (
        <p
          className={cn(
            'mt-2 text-sm',
            message.kind === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
