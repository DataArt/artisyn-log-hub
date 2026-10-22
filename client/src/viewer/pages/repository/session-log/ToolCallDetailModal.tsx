import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { BYTES_PER_TOKEN } from './log-parser';
import { formatOtherToolName } from './prompt-turn-helpers';
import type { FileAccess, SubAgentNode, ToolCallDetail } from './types';
import { ToolCallView } from './tool-call-view/ToolCallView';

interface Props {
  call: ToolCallDetail;
  onClose: () => void;
  charsPerToken?: number;
  /** The turn's files, for the Size of a file call. */
  turnFiles?: FileAccess[];
  /** Sub-agent nodes, for "Open sub-agent →" on an Agent call. */
  subAgents?: SubAgentNode[];
}

/** One tool call in a modal: a `Dialog` shell around the shared `ToolCallView` (DD-11). */
export function ToolCallDetailModal({
  call,
  onClose,
  charsPerToken = BYTES_PER_TOKEN,
  turnFiles,
  subAgents,
}: Props) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl xl:max-w-5xl 2xl:max-w-7xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="sr-only">
            Tool call: {formatOtherToolName(call.name)}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto pr-1">
          <ToolCallView
            call={call}
            charsPerToken={charsPerToken}
            turnFiles={turnFiles}
            subAgents={subAgents}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
