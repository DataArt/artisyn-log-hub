/**
 * "Not read in period" list of the repo OKF tab — information only, so it is styled neutral
 * (grey, no warning colour). The first few files show; "Show all" expands the full list the
 * response already carries, inline.
 */
import { useState } from 'react';
import { formatBytes } from '@/lib/format';
import type { RepoOkfUsageResponse } from '../../../../models/repositories';
import { pathInBundle } from './okf-url-state';

const COLLAPSED_COUNT = 8;

export function OkfNotReadList({
  files,
  onNodeClick,
}: {
  files: RepoOkfUsageResponse['notRead'];
  onNodeClick: (bundle: string | null, path?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? files : files.slice(0, COLLAPSED_COUNT);

  return (
    <div
      data-testid="okf-not-read"
      className="rounded-md border border-border bg-card p-3 text-muted-foreground"
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide">
        Not read in period · {files.length.toLocaleString()} files · info only
      </div>
      {files.length === 0 ? (
        <div className="py-2 text-xs">Every KB file was read</div>
      ) : (
        <>
          {shown.map((f) => (
            <button
              key={`${f.bundle}:${f.path}`}
              type="button"
              data-testid="okf-not-read-file"
              onClick={() => onNodeClick(f.bundle, f.path)}
              title={f.path}
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60"
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {pathInBundle(f.bundle, f.path)}
              </span>
              <span className="w-16 shrink-0 whitespace-nowrap text-right font-mono tabular-nums">
                {formatBytes(f.size)}
              </span>
            </button>
          ))}
          {files.length > COLLAPSED_COUNT ? (
            <button
              type="button"
              data-testid="okf-not-read-toggle"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 px-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
            >
              {expanded
                ? 'Show less'
                : `Show all ${files.length.toLocaleString()}`}
            </button>
          ) : null}
          <div className="mt-1 px-1 text-[11px]">
            Not a problem by itself — an article about an untouched module
            should not be read.
          </div>
        </>
      )}
    </div>
  );
}
