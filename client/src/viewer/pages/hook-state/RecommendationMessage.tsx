import { useState } from 'react';

/** Longest message shown in full without a toggle. */
const SHORT_MAX_CHARS = 240;

/**
 * One hook recommendation's message. Hooks can send long text (a `broken-upload-file`
 * recommendation from an older server carries the raw database error, SQL and all), so a long
 * or multi-line message is shown as its first line, cut, with a toggle for the full text.
 */
export function RecommendationMessage({ message }: { message: string }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = message.split('\n', 1)[0];
  const long = message.length > SHORT_MAX_CHARS || firstLine !== message;

  if (!long) {
    return <span className="text-sm font-medium break-words">{message}</span>;
  }

  const short =
    firstLine.length > SHORT_MAX_CHARS
      ? `${firstLine.slice(0, SHORT_MAX_CHARS - 1)}…`
      : firstLine;

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <span
        className="text-sm font-medium break-words whitespace-pre-wrap"
        data-testid="hook-recommendation-message"
      >
        {expanded ? message : short}
      </span>
      <button
        type="button"
        className="text-xs text-primary hover:underline"
        aria-expanded={expanded}
        data-testid="hook-recommendation-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? 'Show less' : 'Show full message'}
      </button>
    </div>
  );
}
