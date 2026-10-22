import type { PromptTurn } from '../../types';
import { buildTurnSlices } from './context-data';
import { ContextUsageTable } from './ContextUsageTable';
import { ContextPieChart } from './ContextPieChart';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';

interface Props {
  turn: PromptTurn | null;
  onClose: () => void;
  charsPerToken: number;
}

/** Click-to-inspect dialog of a Context Growth turn row: the turn's context breakdown. */
export function TurnBreakdownDialog({ turn, onClose, charsPerToken }: Props) {
  return (
    <Dialog
      open={turn !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Turn #{turn ? turn.index + 1 : ''} &mdash; Context Breakdown
          </DialogTitle>
          <DialogDescription>
            LLM call context at this point in the session
          </DialogDescription>
        </DialogHeader>
        {turn &&
          (() => {
            const slices = buildTurnSlices(turn, 0, charsPerToken);
            return (
              <div className="grid grid-cols-2 gap-6">
                <ContextUsageTable slices={slices} />
                <div className="flex justify-center">
                  <ContextPieChart slices={slices} size={220} />
                </div>
              </div>
            );
          })()}
        <p className="text-xs text-muted-foreground mt-2">
          Raw text is not stored &mdash; breakdown is estimated from token
          counts
        </p>
      </DialogContent>
    </Dialog>
  );
}
