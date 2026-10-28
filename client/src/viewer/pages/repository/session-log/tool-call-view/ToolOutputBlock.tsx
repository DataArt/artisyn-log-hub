import { useMemo, useState } from 'react';
import { useCopyToClipboard } from '../../../../hooks/useCopyToClipboard';
import { toRepoRelative } from '@loghub/bash-view';
import { formatBytes, formatCompact } from '../log-parser';
import { useToolView } from './ToolViewContext';

/** Output longer than this is cut until "show all" (DD-12). */
export const TRUNCATE_AT = 20000;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * A tool call's output (DD-12): header `N lines · X KB · ≈Yk tok`, copy of the full original,
 * the text shown repo-relative in a scrollable `<pre>`, cut at `TRUNCATE_AT` chars until
 * "show all". No result → "Output not captured".
 */
export function ToolOutputBlock({
  result,
  charsPerToken,
  label = 'Output',
}: {
  result: string | null | undefined;
  charsPerToken: number;
  label?: string;
}) {
  const { repoRoot } = useToolView();
  const [showFull, setShowFull] = useState(false);
  const { copied, copy } = useCopyToClipboard(result ?? '');

  const stats = useMemo(
    () =>
      result == null
        ? null
        : {
            lines: result === '' ? 0 : result.split('\n').length,
            bytes: utf8Bytes(result),
            tokens: Math.round(result.length / charsPerToken),
          },
    [result, charsPerToken],
  );
  const display = useMemo(
    () => (result == null ? '' : toRepoRelative(result, repoRoot)),
    [result, repoRoot],
  );

  const isTruncated = display.length > TRUNCATE_AT;
  const shown =
    isTruncated && !showFull ? display.slice(0, TRUNCATE_AT) : display;

  return (
    <div
      className="rounded border border-border bg-muted/40 p-3 text-xs font-mono"
      data-testid="tool-output-block"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {stats && (
          <span className="text-[10px] text-muted-foreground">
            {stats.lines.toLocaleString()}{' '}
            {stats.lines === 1 ? 'line' : 'lines'} · {formatBytes(stats.bytes)}{' '}
            · ≈{formatCompact(stats.tokens)} tok
          </span>
        )}
        {result != null && (
          <button
            type="button"
            onClick={copy}
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] bg-muted hover:bg-accent text-muted-foreground transition-colors"
          >
            {copied ? '✓ copied' : 'copy'}
          </button>
        )}
      </div>
      {result == null ? (
        <span className="text-muted-foreground italic">
          Output not captured
        </span>
      ) : (
        <>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-foreground/80 leading-relaxed">
            {shown}
          </pre>
          {isTruncated && (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setShowFull((f) => !f)}
                className="text-xs text-blue-600 dark:text-blue-400 underline"
              >
                {showFull
                  ? '▲ show less'
                  : `▾ show all (${display.length.toLocaleString()} chars)`}
              </button>
              {!showFull && (
                <span className="text-[10px] text-muted-foreground">
                  showing the first {TRUNCATE_AT.toLocaleString('en-US')} of{' '}
                  {display.length.toLocaleString('en-US')} chars
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
