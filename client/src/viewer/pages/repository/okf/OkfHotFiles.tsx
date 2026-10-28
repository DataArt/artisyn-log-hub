/**
 * "Hot files" list of the repo OKF tab: the server's top files by KB read bytes (top 10 only,
 * so there is no "Show all"). A click scrolls the tree to the file.
 */
import { formatBytes } from '@/lib/format';
import type { RepoOkfUsageResponse } from '../../../../models/repositories';
import { pathInBundle } from './okf-url-state';

export function OkfHotFiles({
  files,
  onNodeClick,
}: {
  files: RepoOkfUsageResponse['hotFiles'];
  onNodeClick: (bundle: string | null, path?: string) => void;
}) {
  return (
    <div
      data-testid="okf-hot-files"
      className="rounded-md border border-border bg-card p-3"
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Hot files · top by read bytes
      </div>
      {files.length > 0 ? (
        <div className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
          <span className="min-w-0 flex-1 pl-6">File</span>
          <span className="w-8 shrink-0 text-right">Sess.</span>
          <span className="w-16 shrink-0 text-right">Read</span>
        </div>
      ) : null}
      {files.length === 0 ? (
        <div className="py-2 text-xs text-muted-foreground">No KB reads</div>
      ) : (
        files.map((f, i) => (
          <button
            key={`${f.bundle ?? ''}:${f.path}`}
            type="button"
            data-testid="okf-hot-file"
            onClick={() => onNodeClick(f.bundle, f.path)}
            title={`${f.path} · ${f.sessions} sessions`}
            className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60"
          >
            <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono">
              {pathInBundle(f.bundle, f.path)}
            </span>
            <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
              {f.sessions}
            </span>
            <span className="w-16 shrink-0 text-right font-mono tabular-nums">
              {formatBytes(f.readBytes)}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
