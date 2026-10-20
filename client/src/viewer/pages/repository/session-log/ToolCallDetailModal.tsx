import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { cn } from '../../../lib/cn';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import type { ToolCallDetail } from './types';
import { formatOtherToolName, getOtherToolStyle } from './prompt-turn-helpers';

interface Props {
  call: ToolCallDetail;
  onClose: () => void;
}

const TRUNCATE_AT = 2000;

export function ToolCallDetailModal({ call, onClose }: Props) {
  const [showFull, setShowFull] = useState(false);
  const { copied, copy } = useCopyToClipboard(call.result ?? '');

  const displayName = formatOtherToolName(call.name);
  const result = call.result ?? null;
  const isTruncated = result !== null && result.length > TRUNCATE_AT;
  const displayResult =
    isTruncated && !showFull ? result.slice(0, TRUNCATE_AT) : result;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 font-mono text-base">
            <span
              className={cn(
                'rounded px-2 py-1 text-xs font-bold leading-none',
                getOtherToolStyle(call.name),
              )}
            >
              {displayName}
            </span>
            {call.permissionDenied ? (
              <span className="rounded px-1.5 py-0.5 text-xs font-mono bg-yellow-500/20 text-yellow-700 dark:text-yellow-300">
                ⚠ denied
              </span>
            ) : call.permissionRequested ? (
              <span className="rounded px-1.5 py-0.5 text-xs font-mono bg-yellow-500/20 text-yellow-700 dark:text-yellow-300">
                ⚠ requested
              </span>
            ) : call.status === 'error' ? (
              <span className="rounded px-1.5 py-0.5 text-xs font-mono bg-red-500/20 text-red-700 dark:text-red-300">
                ✗ error
              </span>
            ) : (
              <span className="rounded px-1.5 py-0.5 text-xs font-mono bg-green-500/20 text-green-700 dark:text-green-300">
                ✓ ok
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-3 flex flex-col gap-3 overflow-y-auto min-h-0">
          {/* INPUT */}
          <div className="rounded border border-border bg-muted/40 p-3 text-xs font-mono">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Input
            </div>
            <pre className="whitespace-pre-wrap break-all text-foreground/80 leading-relaxed">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          </div>

          {/* RESULT */}
          <div className="rounded border border-border bg-muted/40 p-3 text-xs font-mono">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Result
              </span>
              {result !== null && (
                <button
                  type="button"
                  onClick={copy}
                  className="rounded px-1.5 py-0.5 text-[10px] bg-muted hover:bg-accent text-muted-foreground transition-colors"
                >
                  {copied ? '✓ copied' : 'copy'}
                </button>
              )}
            </div>
            {result === null ? (
              <span className="text-muted-foreground italic">
                — no result —
              </span>
            ) : (
              <>
                <pre className="whitespace-pre-wrap break-all text-foreground/80 leading-relaxed">
                  {displayResult}
                </pre>
                {isTruncated && (
                  <button
                    type="button"
                    onClick={() => setShowFull((f) => !f)}
                    className="mt-2 text-xs text-blue-600 dark:text-blue-400 underline"
                  >
                    {showFull
                      ? '▲ show less'
                      : `▾ show all (${result.length.toLocaleString()} chars)`}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
