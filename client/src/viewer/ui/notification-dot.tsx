interface NotificationDotProps {
  /** `data-testid` of the dot; defaults to the session-list badge id. */
  testId?: string;
  /** Accessible label of the dot; defaults to the session-list badge text. */
  label?: string;
}

/**
 * Small plain red notification dot, meant to be placed inside a
 * `relative`-positioned wrapper around the element it decorates (e.g. the
 * session-list refresh button). Purely presentational — carries its own
 * `aria-label` since it conveys information without any text.
 */
export function NotificationDot({
  testId = 'new-session-badge',
  label = 'New sessions available',
}: NotificationDotProps = {}) {
  return (
    <span
      data-testid={testId}
      role="img"
      aria-label={label}
      className="pointer-events-none absolute -top-1.5 -right-1.5 flex size-[22px] items-center justify-center"
    >
      <span
        aria-hidden="true"
        className="size-[13px] rounded-full border-2 border-white bg-red-600"
      />
    </span>
  );
}
