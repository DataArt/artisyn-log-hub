import { Button } from '../../ui/button';

interface SessionNotFoundStateProps {
  /** Clears the `session`/`tab` URL params (no history entry). */
  onClose: () => void;
}

/**
 * Detail-pane state for a URL `session` param that names no session the caller can see —
 * deleted, never uploaded, or outside their access scope. Shares the
 * centred empty-state styling of the "Select a session…" placeholder.
 */
export function SessionNotFoundState({ onClose }: SessionNotFoundStateProps) {
  return (
    <div
      data-testid="session-not-found"
      className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center"
    >
      <span aria-hidden="true" className="text-3xl text-muted-foreground">
        ⌀
      </span>
      <p className="text-sm font-medium text-foreground">Session not found</p>
      <p className="text-sm text-muted-foreground">
        It may have been deleted, or you do not have access to it.
      </p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
