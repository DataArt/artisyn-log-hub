/**
 * One row of the OKF explorer: a bundle root, a folder, a file, the folder's search row or the
 * "Not in this snapshot" root. Under "All" / "Opened" it shows "X of Y" opened files (folders),
 * the sessions / agents and ≈ tokens; a never-opened file is greyed with dashes. Under
 * "Never opened" the only number is a folder's count of never-opened files.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatApproxTokens } from '@/lib/okf/okf-format';
import { OkfTip } from './OkfTip';
import { OkfNotInGitChip } from './OkfVersionsBlock';
import type { OkfExplorerFilter, OkfExplorerRow } from './okf-explorer-tree';
import {
  OKF_MISSING_ROOT_LABEL,
  OKF_SEARCH_ROW_LABEL,
  OKF_TIP_MISSING,
  OKF_TIP_SEARCH,
  okfFilesText,
} from './okf-view-text';

/** Column widths shared by the header and the rows. */
export const OKF_EXPLORER_COL = {
  files: 'w-24 shrink-0 text-right',
  units: 'w-16 shrink-0 text-right',
  tokens: 'w-16 shrink-0 text-right',
} as const;

const DASH = '—';

function filesCell(row: OkfExplorerRow): string {
  if (row.kind === 'missing-root') return okfFilesText(row.fileCount ?? 0);
  if (row.kind === 'bundle' || row.kind === 'folder') {
    return `${row.filesOpened ?? 0} of ${row.filesTotal ?? 0}`;
  }
  return '';
}

function RowLabel({ row }: { row: OkfExplorerRow }) {
  if (row.kind === 'search') {
    return (
      <span className="inline-flex min-w-0 items-baseline gap-1 italic text-muted-foreground">
        <span className="truncate">{OKF_SEARCH_ROW_LABEL}</span>
        <OkfTip testId="okf-tip-search" label="About folder searches">
          {OKF_TIP_SEARCH}
        </OkfTip>
      </span>
    );
  }
  if (row.kind === 'missing-root') {
    return (
      <span className="inline-flex min-w-0 items-baseline gap-1">
        <span className="truncate">{OKF_MISSING_ROOT_LABEL}</span>
        <OkfTip
          testId="okf-tip-missing"
          label="About files not in the snapshot"
        >
          {OKF_TIP_MISSING}
        </OkfTip>
      </span>
    );
  }
  return (
    <span className="truncate font-mono" title={row.path}>
      {row.label}
    </span>
  );
}

export function OkfExplorerRowView({
  row,
  filter,
  ignored,
  onToggle,
}: {
  row: OkfExplorerRow;
  filter: OkfExplorerFilter;
  /** The bundle is gitignored ("not in git" chip on its root). */
  ignored: boolean;
  onToggle: (key: string) => void;
}) {
  const greyed = row.kind === 'file' && !row.opened;
  const Chevron = row.expanded ? ChevronDown : ChevronRight;
  const isFolder = row.kind === 'bundle' || row.kind === 'folder';

  const name = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {row.expandable ? (
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <RowLabel row={row} />
      {row.kind === 'bundle' && ignored ? (
        <OkfNotInGitChip testId="okf-version-ignored" />
      ) : null}
    </span>
  );

  return (
    <div
      data-testid="okf-tree-row"
      data-path={row.path}
      data-kind={row.kind}
      data-opened={row.opened ? 'true' : 'false'}
      style={{ paddingLeft: 4 + row.depth * 16 }}
      className={`flex items-center gap-2 rounded py-0.5 pr-1 text-xs ${
        greyed ? 'text-muted-foreground' : 'text-foreground'
      } ${row.expandable ? 'hover:bg-accent/50' : ''}`}
    >
      {row.expandable && row.kind !== 'missing-root' ? (
        <button
          type="button"
          aria-expanded={row.expanded}
          onClick={() => onToggle(row.key)}
          className="flex min-w-0 flex-1 items-center text-left"
        >
          {name}
        </button>
      ) : row.expandable ? (
        // The label holds a tooltip button, so the toggle is the row itself, not a button.
        <div
          role="button"
          tabIndex={0}
          aria-expanded={row.expanded}
          onClick={() => onToggle(row.key)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggle(row.key);
            }
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center"
        >
          {name}
        </div>
      ) : (
        name
      )}
      {filter === 'never' ? (
        <span className={`${OKF_EXPLORER_COL.files} font-mono tabular-nums`}>
          {isFolder ? (row.filesTotal ?? 0) - (row.filesOpened ?? 0) : ''}
        </span>
      ) : (
        <>
          <span className={`${OKF_EXPLORER_COL.files} font-mono tabular-nums`}>
            {filesCell(row)}
          </span>
          <span className={`${OKF_EXPLORER_COL.units} font-mono tabular-nums`}>
            {row.units === null ? DASH : row.units}
          </span>
          <span className={`${OKF_EXPLORER_COL.tokens} font-mono tabular-nums`}>
            {row.tokens === null ? DASH : formatApproxTokens(row.tokens)}
          </span>
        </>
      )}
    </div>
  );
}
