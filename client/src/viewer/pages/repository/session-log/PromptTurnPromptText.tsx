import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../../ui/collapsible';
import { cn } from '../../../lib/cn';

interface Props {
  rawText: string;
  displayText: string;
  isEmpty: boolean;
}

export function PromptTurnPromptText({ rawText, displayText, isEmpty }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 text-left text-base transition-colors hover:text-foreground',
          isEmpty ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate leading-snug',
            isEmpty && 'italic',
          )}
        >
          {isEmpty ? '(system message)' : displayText}
        </span>
      </CollapsibleTrigger>

      {rawText && (
        <CollapsibleContent>
          <div className="ml-5 mt-2 rounded-md bg-muted/40 p-3">
            <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-foreground">
              {rawText}
            </p>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
