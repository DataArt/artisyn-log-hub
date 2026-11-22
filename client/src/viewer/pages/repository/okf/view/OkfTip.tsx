/**
 * The "ⓘ" next to a label of the OKF view: a light tooltip (`ui/tooltip.tsx`) with a fixed
 * explanation. The trigger is a button, so it is reachable from the keyboard.
 */
import type { ReactNode } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';

export function OkfTip({
  testId,
  label,
  children,
}: {
  testId: string;
  /** Accessible name of the trigger, e.g. "About Reads". */
  label: string;
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid={testId}
            aria-label={label}
            className="cursor-help font-normal normal-case text-muted-foreground hover:text-foreground"
          >
            ⓘ
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-left font-normal normal-case tracking-normal">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
