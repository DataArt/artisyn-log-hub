import { Switch as SwitchPrimitive } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * Shared on/off switch. Wraps the unified `radix-ui` package's `Switch`, which already
 * re-exports `@radix-ui/react-switch` — no extra dependency, same import style as `ui/toggle.tsx`.
 *
 * Renders a real `role="switch"` with `data-state`, so both keyboard users and the e2e specs can
 * address it without a bespoke ARIA shim.
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary dark:bg-muted',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3 translate-x-0.5 rounded-full bg-background shadow transition-transform data-[state=checked]:translate-x-[13px]"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
