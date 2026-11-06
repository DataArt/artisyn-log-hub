/**
 * Pointer list of the OKF article drill-down (FR-1 / FR-13): every new pointer agents saw in the
 * article, dead pointers first (the server sends them sorted: dead first, then `shown` desc).
 * A followed pointer reads "✓ followed ×k", one never followed "· shown ×n, never followed";
 * a dead pointer whose path no session ever touched gets the "path not found in any session"
 * tag (a proxy: Log Hub has no repo file list). The first {@link OKF_POINTER_ROWS} rows show,
 * then "… N more · Show all".
 */
import { useState } from 'react';
import type { RepoOkfArticleResponse } from '../../../../../models/repositories';

/** Rows shown before "Show all" (impl-plan DD-0). */
export const OKF_POINTER_ROWS = 17;

type Pointer = RepoOkfArticleResponse['pointers'][number];

function PointerRow({ p }: { p: Pointer }) {
  return (
    <div
      data-testid="okf-article-pointer"
      data-dead={p.dead ? 'true' : 'false'}
      className="flex items-center gap-2 px-1 py-0.5 text-xs"
    >
      <span
        className={`w-3 shrink-0 text-center ${
          p.followed > 0 ? 'text-emerald-600' : 'text-muted-foreground'
        }`}
        aria-hidden
      >
        {p.followed > 0 ? '✓' : '·'}
      </span>
      <span className="min-w-0 truncate font-mono" title={p.pointer}>
        {p.pointer}
      </span>
      {p.dead ? (
        <span
          data-testid="okf-article-pointer-dead"
          className="shrink-0 rounded border border-amber-500/50 px-1 text-[10px] text-amber-700 dark:text-amber-400"
        >
          dead
        </span>
      ) : null}
      {p.notFound ? (
        <span
          data-testid="okf-article-pointer-not-found"
          className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground"
          title="No session touched this path or anything under it, and it is not a KB file — Log Hub has no repo file list, so this is a proxy"
        >
          path not found in any session
        </span>
      ) : null}
      <span className="ml-2 shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {p.followed > 0
          ? `followed ×${p.followed} · shown ×${p.shown}`
          : `shown ×${p.shown}, never followed`}
      </span>
    </div>
  );
}

export function OkfPointerTable({ pointers }: { pointers: Pointer[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? pointers : pointers.slice(0, OKF_POINTER_ROWS);
  const more = pointers.length - visible.length;

  return (
    <div
      data-testid="okf-article-pointers"
      className="rounded-md border border-border bg-card p-3"
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Pointers agents saw for the first time · {pointers.length}
      </div>
      {pointers.length === 0 ? (
        <div className="py-1 text-xs text-muted-foreground">
          No new pointers in reads of this article.
        </div>
      ) : (
        <>
          {visible.map((p) => (
            <PointerRow key={p.pointer} p={p} />
          ))}
          {more > 0 ? (
            <button
              type="button"
              data-testid="okf-article-pointers-show-all"
              onClick={() => setShowAll(true)}
              className="px-1 pt-1 text-xs text-muted-foreground hover:text-foreground"
            >
              … {more} more · Show all
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
