import { cn } from '@/lib/cn';
import type { ToolUsageChannel } from '../../../../models/tool-monitoring';
import { CHANNEL_BADGE_CLASS, CHANNEL_LABELS } from './tools-tree-model';

/** `MCP` (violet) / `CLI` (slate) badge of the Tools/MCP tab. */
export function ChannelBadge({
  channel,
  className,
}: {
  channel: ToolUsageChannel;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-block shrink-0 rounded px-1 py-px font-mono text-[10px] font-bold leading-none',
        CHANNEL_BADGE_CLASS[channel],
        className,
      )}
      data-testid="tools-channel-badge"
    >
      {CHANNEL_LABELS[channel]}
    </span>
  );
}
