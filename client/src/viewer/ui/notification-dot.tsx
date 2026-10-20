/**
 * Small plain red notification dot, meant to be placed inside a
 * `relative`-positioned wrapper around the element it decorates (e.g. the
 * session-list refresh button). Purely presentational — carries its own
 * `aria-label` since it conveys information without any text.
 */
export function NotificationDot() {
  return (
    <span
      data-testid="new-session-badge"
      role="img"
      aria-label="New sessions available"
      className="pointer-events-none absolute -top-1.5 -right-1.5 flex size-[22px] items-center justify-center"
    >
      <span
        aria-hidden="true"
        className="size-[13px] rounded-full border-2 border-white bg-red-600"
      />
    </span>
  );
}
