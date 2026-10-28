import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../../../lib/cn';
import { useCopyToClipboard } from '../../../../hooks/useCopyToClipboard';
import {
  type FoldedHeredoc,
  type HighlightSegment,
  toRepoRelative,
} from '@loghub/bash-view';
import type { ToolCallDetail } from '../types';
import { BashFileSummary } from './BashFileSummary';
import { HighlightedScript } from './HighlightedScript';
import { ToolOutputBlock } from './ToolOutputBlock';
import { useToolView } from './ToolViewContext';
import { commandOf, useBashView } from './useBashView';

const SECTION_LABEL =
  'text-[10px] font-bold uppercase tracking-wide text-muted-foreground';

/**
 * The formatted script with the expanded folded heredoc bodies put back right after their
 * `# ▼ block n` marker line; each expanded body is one `string` segment and the segments after it
 * are shifted by its length.
 */
function expandFolds(
  script: string,
  segments: HighlightSegment[],
  folded: FoldedHeredoc[],
  expanded: ReadonlySet<number>,
): { text: string; segments: HighlightSegment[] } {
  const inserts = folded
    .filter((f) => expanded.has(f.n))
    .flatMap((f) => {
      const marker = script.indexOf(`# ▼ block ${f.n}:`);
      const eol = marker < 0 ? -1 : script.indexOf('\n', marker);
      return eol < 0 ? [] : [{ at: eol + 1, body: f.body }];
    })
    .sort((a, b) => b.at - a.at);
  let text = script;
  let segs = segments;
  for (const { at, body } of inserts) {
    const add = body.length + 1;
    text = `${text.slice(0, at)}${body}\n${text.slice(at)}`;
    segs = [
      ...segs.map((s) =>
        s.start >= at ? { ...s, start: s.start + add, end: s.end + add } : s,
      ),
      { start: at, end: at + body.length, kind: 'string' as const },
    ];
  }
  return { text, segments: [...segs].sort((a, b) => a.start - b.start) };
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * The Bash body of a tool call (DD-13): caption and chips, WORKING DIR (lifted `cd`), FILES,
 * COMMAND (Formatted | Raw, line counts, "Copy original", highlighted script with heredoc fold
 * toggles) and the output. While the parser loads the raw text shows; in fallback (unparseable,
 * PowerShell, load failure) the raw text wraps, with no toggle, FILES or highlighting.
 */
export function BashCommandView({
  call,
  charsPerToken,
  forceFallback = false,
}: {
  call: ToolCallDetail;
  charsPerToken: number;
  forceFallback?: boolean;
}) {
  const { repoRoot } = useToolView();
  const command = commandOf(call.input);
  const bash = useBashView(command, forceFallback);
  const [mode, setMode] = useState<'formatted' | 'raw'>('formatted');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const { copied, copy } = useCopyToClipboard(command, 2000);

  const description =
    typeof call.input.description === 'string' ? call.input.description : '';
  const timeout =
    typeof call.input.timeout === 'number' ? call.input.timeout : undefined;
  const background = call.input.run_in_background === true;
  const rawDisplay = useMemo(
    () => toRepoRelative(command, repoRoot),
    [command, repoRoot],
  );

  const shown = useMemo(() => {
    if (bash.state !== 'ready') return null;
    const { view, highlight } = bash;
    if (mode === 'raw')
      return { text: view.rawDisplay, segments: highlight(view.rawDisplay) };
    return expandFolds(
      view.script,
      highlight(view.script),
      view.folded,
      expanded,
    );
  }, [bash, mode, expanded]);

  const toggleFold = (n: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <div
      className="flex flex-col gap-3 text-xs font-mono"
      data-testid="bash-command-view"
    >
      {(description || timeout !== undefined || background) && (
        <div className="flex flex-wrap items-center gap-2 font-sans">
          {description && (
            <span
              className="text-sm text-foreground"
              data-testid="bash-caption"
            >
              {description}
            </span>
          )}
          {timeout !== undefined && <Chip>timeout {timeout} ms</Chip>}
          {background && <Chip>background</Chip>}
        </div>
      )}

      {bash.state === 'ready' && bash.view.workDir !== null && (
        <div data-testid="bash-workdir">
          <div className={SECTION_LABEL}>Working dir</div>
          <div className="break-all">{bash.view.workDir}</div>
        </div>
      )}

      {bash.state === 'ready' && <BashFileSummary files={bash.view.files} />}

      <div data-testid="bash-command">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className={SECTION_LABEL}>Command</span>
          {bash.state === 'ready' && (
            <>
              <div className="inline-flex overflow-hidden rounded border border-border text-[10px]">
                {(['formatted', 'raw'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className={cn(
                      'px-1.5 py-0.5 capitalize',
                      mode === m
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground">
                {bash.view.lineCount}{' '}
                {bash.view.lineCount === 1 ? 'line' : 'lines'}
                {bash.view.lineCount !== bash.view.rawLineCount &&
                  ` (was ${bash.view.rawLineCount})`}
              </span>
            </>
          )}
          <button
            type="button"
            onClick={copy}
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] bg-muted hover:bg-accent text-muted-foreground transition-colors"
          >
            {copied ? '✓ copied original' : '⧉ Copy original'}
          </button>
        </div>

        {shown && bash.state === 'ready' ? (
          <>
            {mode === 'formatted' && bash.view.folded.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-2">
                {bash.view.folded.map((f) => (
                  <button
                    key={f.n}
                    type="button"
                    aria-expanded={expanded.has(f.n)}
                    onClick={() => toggleFold(f.n)}
                    title={f.head}
                    className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                  >
                    {expanded.has(f.n) ? '▾' : '▸'} block {f.n}: {f.lines} lines
                  </button>
                ))}
              </div>
            )}
            <HighlightedScript
              text={shown.text}
              segments={shown.segments}
              lineNumbers
            />
          </>
        ) : (
          <pre
            className={cn(
              'overflow-x-auto rounded border border-border bg-background px-2 py-2 text-foreground/90 leading-relaxed',
              bash.state === 'fallback'
                ? 'whitespace-pre-wrap break-all'
                : 'whitespace-pre',
            )}
            data-testid="bash-raw-command"
          >
            {rawDisplay}
          </pre>
        )}
      </div>

      <ToolOutputBlock result={call.result} charsPerToken={charsPerToken} />
    </div>
  );
}
