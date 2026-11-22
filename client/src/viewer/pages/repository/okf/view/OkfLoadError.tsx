/**
 * The error state of both OKF tabs: "No access" for a 403, one fixed line for anything else.
 */
import { ApiError } from '../../../../api';

export function OkfLoadError({ error }: { error: Error }) {
  const text =
    error instanceof ApiError && error.statusCode === 403
      ? 'No access'
      : 'Error — KB usage could not be loaded.';
  return (
    <div
      data-testid="okf-error"
      className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground"
    >
      {text}
    </div>
  );
}
