import { Pin as PinIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import type { Pin } from '../lib/home-pins';
import { useHomePins } from '../lib/useHomePins';

interface PinToggleProps {
  /** What this toggle pins to Home: a repository, an Analytics view or a report (DD-17). */
  pin: Pin;
  className?: string;
}

/**
 * Pins / unpins a repository, an Analytics view or a report to Home (FR-F3). The state lives in
 * the `home.pins` user setting; the click updates at once (optimistic) and rolls back when the
 * save fails. Hidden in print, so a printed report carries no app control.
 */
export function PinToggle({ pin, className }: PinToggleProps) {
  const { isPinned, toggle } = useHomePins();
  const pinned = isPinned(pin);
  const label = pinned ? 'Unpin' : 'Pin to Home';
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="pin-toggle"
            aria-pressed={pinned}
            aria-label={label}
            onClick={() => toggle(pin)}
            className={cn(
              'inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground print:hidden',
              pinned && 'text-primary',
              className,
            )}
          >
            <PinIcon className={cn('size-4', pinned && 'fill-current')} />
          </button>
        </TooltipTrigger>
        <TooltipContent variant="light" side="bottom">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
