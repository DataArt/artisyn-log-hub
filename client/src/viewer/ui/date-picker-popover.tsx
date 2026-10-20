import { useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

interface DatePickerPopoverProps {
  value: Date | null;
  onChange: (date: Date | null) => void;
  children: React.ReactNode;
}

const DAY_PICKER_STYLE = {
  '--rdp-accent-color': 'hsl(var(--primary))',
  '--rdp-accent-background-color': 'hsl(var(--accent))',
  '--rdp-today-color': 'hsl(var(--primary))',
  '--rdp-day-height': '30px',
  '--rdp-day-width': '30px',
  '--rdp-day_button-height': '28px',
  '--rdp-day_button-width': '28px',
  '--rdp-font-size': '0.8rem',
  '--rdp-month-caption-padding': '0.25rem 0',
} as React.CSSProperties;

export function DatePickerPopover({
  value,
  onChange,
  children,
}: DatePickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Date | undefined>(undefined);

  function handleOpenChange(o: boolean) {
    if (o) setPending(value ?? undefined);
    setOpen(o);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="px-3 pt-3 pb-1">
          <DayPicker
            mode="single"
            selected={pending}
            onSelect={setPending}
            style={DAY_PICKER_STYLE}
          />
        </div>
        <div className="flex gap-2 px-3 pb-3 border-t border-border pt-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            No expiry
          </Button>
          <Button
            size="sm"
            className="flex-1"
            disabled={!pending}
            onClick={() => {
              if (pending) {
                onChange(pending);
                setOpen(false);
              }
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
