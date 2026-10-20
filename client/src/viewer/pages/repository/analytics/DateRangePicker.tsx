import { useState, useEffect } from 'react';
import { DayPicker } from 'react-day-picker';
import type { DateRange } from 'react-day-picker';
import 'react-day-picker/style.css';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Button } from '@/ui/button';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: DateRange | undefined;
  onApply: (range: { from: Date; to: Date }) => void;
}

export function DateRangePicker({
  open,
  onOpenChange,
  selected,
  onApply,
}: Props) {
  const [pending, setPending] = useState<DateRange | undefined>(selected);

  useEffect(() => {
    if (open) setPending(selected);
    // intentionally only reset when dialog opens, not on every `selected` change
  }, [open]);

  const canApply = pending?.from != null && pending?.to != null;

  // react-day-picker v9 dropped v8's fromDate/toDate, which bounded both the month
  // navigation and the selectable days. startMonth/endMonth cover the former,
  // `disabled` the latter.
  const earliest = new Date('2026-01-01');
  const latest = new Date();

  function handleApply() {
    if (canApply) {
      onApply({ from: pending.from!, to: pending.to! });
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl w-auto">
        <DialogHeader>
          <DialogTitle>Select date range</DialogTitle>
        </DialogHeader>
        <div className="flex justify-center">
          <DayPicker
            mode="range"
            selected={pending}
            onSelect={setPending}
            numberOfMonths={2}
            startMonth={earliest}
            endMonth={latest}
            disabled={{ before: earliest, after: latest }}
            showOutsideDays={false}
            style={
              {
                '--rdp-accent-color': 'hsl(var(--primary))',
                '--rdp-accent-background-color': 'hsl(var(--accent))',
                '--rdp-range_middle-background-color': 'hsl(var(--accent))',
                '--rdp-range_middle-color': 'hsl(var(--accent-foreground))',
                '--rdp-range_start-color': 'hsl(var(--primary-foreground))',
                '--rdp-range_end-color': 'hsl(var(--primary-foreground))',
                '--rdp-range_start-date-background-color':
                  'hsl(var(--primary))',
                '--rdp-range_end-date-background-color': 'hsl(var(--primary))',
                '--rdp-today-color': 'hsl(var(--primary))',
                '--rdp-day-height': '36px',
                '--rdp-day-width': '36px',
                '--rdp-day_button-height': '34px',
                '--rdp-day_button-width': '34px',
              } as React.CSSProperties
            }
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={!canApply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
