import { Select } from 'radix-ui';
import { ChevronDown } from 'lucide-react';

// Generic sub-metric selector for the analytics toolbar. Extracted from
// AnalyticsControls.tsx (component-size split): the files /
// vision / productivity / change-surface views each rendered an identical Radix
// <Select> differing only in options and value type. Purely presentational.

export interface MetricSelectOption<K extends string> {
  key: K;
  label: string;
  description: string;
}

interface Props<K extends string> {
  value: K;
  options: ReadonlyArray<MetricSelectOption<K>>;
  onChange: (value: K) => void;
  /**
   * The files view has a long option list: render with popper positioning, a
   * max-height viewport and scroll buttons. The short fixed lists keep the plain
   * item-aligned dropdown.
   */
  scrollable?: boolean;
}

const ITEM_CLASS =
  'flex cursor-default select-none flex-col rounded-sm px-2 py-1.5 outline-none hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground';

export function MetricSelect<K extends string>({
  value,
  options,
  onChange,
  scrollable = false,
}: Props<K>) {
  const items = options.map((opt) => (
    <Select.Item key={opt.key} value={opt.key} className={ITEM_CLASS}>
      <Select.ItemText>{opt.label}</Select.ItemText>
      <span className="text-xs text-muted-foreground">{opt.description}</span>
    </Select.Item>
  ));

  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as K)}>
      <Select.Trigger className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring">
        <Select.Value />
        <Select.Icon>
          <ChevronDown className="size-4 opacity-50" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        {scrollable ? (
          <Select.Content
            className="z-50 rounded-md border bg-popover text-popover-foreground shadow-md"
            position="popper"
            sideOffset={4}
          >
            <Select.ScrollUpButton className="flex items-center justify-center py-1 text-muted-foreground">
              <ChevronDown className="size-3 rotate-180" />
            </Select.ScrollUpButton>
            <Select.Viewport className="p-1 max-h-72 overflow-y-auto">
              {items}
            </Select.Viewport>
            <Select.ScrollDownButton className="flex items-center justify-center py-1 text-muted-foreground">
              <ChevronDown className="size-3" />
            </Select.ScrollDownButton>
          </Select.Content>
        ) : (
          <Select.Content className="z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            <Select.Viewport>{items}</Select.Viewport>
          </Select.Content>
        )}
      </Select.Portal>
    </Select.Root>
  );
}
