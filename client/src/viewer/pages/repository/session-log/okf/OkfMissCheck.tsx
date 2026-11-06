/**
 * Manual check of a routing miss: the searched patterns as inline code and a link to the
 * session's Bash tab. The Bash tab has no text filter and the server sends no per-search call
 * ids, so the user opens the tab and looks for the listed patterns there.
 */
import { Link } from 'react-router-dom';

export function OkfMissCheck({
  patterns,
  to,
}: {
  patterns: readonly string[];
  /** Router path (with search) of the session's Bash tab. */
  to: string;
}) {
  return (
    <div
      data-testid="okf-miss-check"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground"
    >
      <span>search these in the Bash tab:</span>
      {patterns.length > 0 ? (
        patterns.map((p) => (
          <code
            key={p}
            data-testid="okf-miss-pattern"
            className="rounded bg-muted px-1 font-mono text-foreground"
          >
            {p}
          </code>
        ))
      ) : (
        <span>(no patterns recorded)</span>
      )}
      <Link
        to={to}
        data-testid="okf-miss-bash-link"
        className="text-primary underline-offset-2 hover:underline"
      >
        Open session Bash tab
      </Link>
    </div>
  );
}
