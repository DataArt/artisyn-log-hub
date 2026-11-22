/**
 * "Wrong format" block of the OKF view: the articles of the snapshot whose front matter breaks
 * an OKF rule, grouped by problem. One line when every article is well-formed. Groups start
 * collapsed; an open group lists its first `OKF_FORMAT_FILES_TOP` files with a "show all" link.
 * Index files (`index.md` / `log.md`) are not checked.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type {
  OkfFormatProblem,
  OkfUsageFormat,
  OkfUsageFormatFile,
} from '../../../../../models/repositories';
import {
  OKF_FORMAT_FILES_TOP,
  OKF_FORMAT_GROUP_TITLE,
  okfFilesText,
} from './okf-view-text';

function indexFilesText(n: number): string {
  return n === 1
    ? '1 index file is not checked'
    : `${n} index files are not checked`;
}

function FormatGroup({
  problem,
  files,
}: {
  problem: OkfFormatProblem;
  files: OkfUsageFormatFile[];
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const shown = showAll ? files : files.slice(0, OKF_FORMAT_FILES_TOP);

  return (
    <li data-testid="okf-format-group" data-problem={problem}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded py-0.5 text-left text-xs hover:bg-accent/50"
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {OKF_FORMAT_GROUP_TITLE[problem]}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-amber-700 dark:text-amber-400">
          {files.length}
        </span>
      </button>
      {open ? (
        <ul className="mb-1 ml-5 space-y-0.5">
          {shown.map((f) => (
            <li
              key={f.path}
              data-testid="okf-format-file"
              title={f.path}
              className="break-all font-mono text-[11px] text-muted-foreground"
            >
              {f.path}
              {f.supersededBy ? ` → replaced by ${f.supersededBy}` : ''}
            </li>
          ))}
          {files.length > OKF_FORMAT_FILES_TOP && !showAll ? (
            <li>
              <button
                type="button"
                data-testid="okf-format-show-all"
                onClick={() => setShowAll(true)}
                className="text-[11px] font-medium text-primary underline underline-offset-2"
              >
                show all {okfFilesText(files.length)}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function OkfWrongFormatBlock({ format }: { format: OkfUsageFormat }) {
  const clean = format.withProblems === 0;
  return (
    <section
      data-testid="okf-format"
      className="rounded-md border border-border bg-card px-3 py-2 text-sm"
    >
      {clean ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-semibold text-foreground">Wrong format</span>
          <span data-testid="okf-format-ok" className="text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-400">✓</span>{' '}
            All {format.articles} articles are well-formed ·{' '}
            {indexFilesText(format.indexFiles)}
          </span>
        </div>
      ) : (
        <>
          <div className="font-semibold text-foreground">
            Wrong format — {format.withProblems} of {format.articles} articles
          </div>
          <ul className="mt-1">
            {format.groups.map((g) => (
              <FormatGroup
                key={g.problem}
                problem={g.problem}
                files={g.files}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
