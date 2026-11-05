/**
 * A vertical drag handle between two panes of the Live modal: a 1 px border line with a wider
 * hover / grab target. Dragging is done by `useDraggableWidth`, whose `onMouseDown` it receives.
 */
export function LiveSplitter({
  label,
  testId,
  onMouseDown,
}: {
  label: string;
  testId: string;
  onMouseDown: React.MouseEventHandler;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-testid={testId}
      onMouseDown={onMouseDown}
      className="group relative z-10 w-px shrink-0 cursor-col-resize bg-border"
    >
      <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-accent/70" />
    </div>
  );
}
