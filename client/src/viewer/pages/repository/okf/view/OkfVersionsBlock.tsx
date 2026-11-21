/**
 * "Versions" block of the OKF view: the OKF format version each KB folder declares. One line
 * while collapsed; it starts collapsed when every folder is on the current format and expanded
 * when at least one is behind. `OkfOldHookLine` replaces this block and "Wrong format" for a
 * snapshot whose hook sent no metadata.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { OkfUsageVersionRow } from '../../../../../models/repositories';
import { OkfTip } from './OkfTip';
import {
  OKF_NOT_IN_GIT_LABEL,
  OKF_OLD_HOOK_TEXT,
  OKF_ROOT_BUNDLE_LABEL,
  OKF_TIP_FORMAT,
  okfFilesText,
  okfVersionsSummaryText,
} from './okf-view-text';

export function OkfOldHookLine() {
  return (
    <div
      data-testid="okf-old-hook-line"
      className="rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground"
    >
      {OKF_OLD_HOOK_TEXT}
    </div>
  );
}

export function OkfNotInGitChip({ testId }: { testId: string }) {
  return (
    <span
      data-testid={testId}
      className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
    >
      {OKF_NOT_IN_GIT_LABEL}
    </span>
  );
}

export function OkfVersionsBlock({
  versions,
  currentFormat,
}: {
  versions: OkfUsageVersionRow[];
  currentFormat: string;
}) {
  const olderCount = versions.filter((v) => v.older).length;
  const [open, setOpen] = useState(olderCount > 0);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <section
      data-testid="okf-versions"
      data-collapsed={open ? 'false' : 'true'}
      className="rounded-md border border-border bg-card px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          data-testid="okf-versions-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1.5 text-left hover:text-foreground"
        >
          <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-semibold text-foreground">Versions</span>
          <span
            className={
              olderCount > 0
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-muted-foreground'
            }
          >
            {okfVersionsSummaryText(versions.length, olderCount, currentFormat)}
          </span>
        </button>
        {open ? (
          <span className="inline-flex items-baseline gap-1 text-xs text-muted-foreground">
            current format: {currentFormat}
            <OkfTip testId="okf-tip-format" label="About the format version">
              {OKF_TIP_FORMAT}
            </OkfTip>
          </span>
        ) : null}
      </div>
      {open ? (
        <ul className="mt-1.5 space-y-0.5">
          {versions.map((v) => (
            <li
              key={v.root}
              data-testid="okf-version-row"
              data-root={v.root}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs"
            >
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate font-mono" title={v.root}>
                  {v.root === '' || v.root === '.'
                    ? OKF_ROOT_BUNDLE_LABEL
                    : v.root}
                </span>
                {v.ignored ? (
                  <OkfNotInGitChip testId="okf-version-ignored" />
                ) : null}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {okfFilesText(v.files)}
              </span>
              <span
                className={
                  v.okfVersion === null
                    ? 'text-muted-foreground'
                    : 'font-mono tabular-nums'
                }
              >
                {v.okfVersion ?? 'not declared'}
              </span>
              {v.older ? (
                <span
                  data-testid="okf-version-older"
                  className="text-amber-700 dark:text-amber-400"
                >
                  older than the current format {currentFormat}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
