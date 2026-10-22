import { useMemo, type ReactNode } from 'react';
import { cn } from '../../../../lib/cn';
import {
  HIGHLIGHT_CLASS,
  type HighlightKind,
  type HighlightSegment,
} from '../../../../lib/bash-view/bash-highlight';

const LEGEND: { kind: HighlightKind; label: string }[] = [
  { kind: 'keyword', label: 'keyword / operator' },
  { kind: 'redirect', label: 'redirect' },
  { kind: 'string', label: 'string' },
  { kind: 'variable', label: 'variable' },
];

/** `text` cut into plain strings and one coloured span per segment. */
function paint(text: string, segments: HighlightSegment[]): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  for (const seg of segments) {
    if (seg.start < pos || seg.end > text.length) continue;
    if (seg.start > pos) out.push(text.slice(pos, seg.start));
    out.push(
      <span key={seg.start} className={HIGHLIGHT_CLASS[seg.kind]}>
        {text.slice(seg.start, seg.end)}
      </span>,
    );
    pos = seg.end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/**
 * A highlighted script (DD-15a): a `<pre>` with an optional line-number gutter, one span per
 * highlight segment, and the colour legend below when anything is coloured.
 */
export function HighlightedScript({
  text,
  segments,
  lineNumbers,
}: {
  text: string;
  segments: HighlightSegment[];
  lineNumbers: boolean;
}) {
  const painted = useMemo(() => paint(text, segments), [text, segments]);
  const lineCount = text.split('\n').length;

  return (
    <div data-testid="bash-highlighted-script">
      <div className="flex overflow-x-auto rounded border border-border bg-background">
        {lineNumbers && (
          <pre
            aria-hidden
            className="shrink-0 select-none border-r border-border px-2 py-2 text-right text-muted-foreground/60 leading-relaxed"
          >
            {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
          </pre>
        )}
        <pre className="min-w-0 flex-1 whitespace-pre px-2 py-2 text-foreground/90 leading-relaxed">
          {painted}
        </pre>
      </div>
      {segments.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-3 text-[10px]">
          {LEGEND.map(({ kind, label }) => (
            <span key={kind} className={cn(HIGHLIGHT_CLASS[kind])}>
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
