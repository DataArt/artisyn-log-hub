import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "../lib/cn";
import styles from "./tooltip.module.css";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 0,
  variant = "light",
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  variant?: "dark" | "light";
}) {
  const isDark = variant === "dark";
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          styles.content,
          isDark ? styles.dark : styles.light,
          className,
        )}
        {...props}
      >
        {children}
        {isDark && <TooltipPrimitive.Arrow className={styles.arrow} />}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
