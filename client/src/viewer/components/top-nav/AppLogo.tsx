export function AppLogo() {
  return (
    <svg viewBox="0 0 32 32" className="size-4" aria-hidden="true">
      <rect width="32" height="32" rx="16" fill="hsl(var(--primary))" />
      <rect
        x="8"
        y="11"
        width="16"
        height="2.4"
        rx="1.2"
        fill="hsl(var(--primary-foreground))"
      />
      <rect
        x="8"
        y="15"
        width="11"
        height="2.4"
        rx="1.2"
        fill="hsl(var(--primary-foreground))"
        opacity="0.7"
      />
      <rect
        x="8"
        y="19"
        width="14"
        height="2.4"
        rx="1.2"
        fill="hsl(var(--primary-foreground))"
      />
    </svg>
  );
}
