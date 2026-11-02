import { useMemo } from 'react';
import { SESSION_GROUPS, type SessionTab } from '../../tab-ids';
import { OverflowRow, type OverflowItem } from '../../ui/overflow-row';
import { lensRow, type LensId } from './session-lenses';
import type { VisibleSessionRow } from './session-tab-groups';
import {
  SessionTabTrigger,
  type SessionTabDecorations,
} from './SessionTabTrigger';

interface Props {
  /** The effective lens; `all` puts every visible tab in the row. */
  lens: LensId;
  sessionTab: SessionTab;
  onSessionTabChange: (tab: SessionTab) => void;
  /** The visible session rows, in registry order. */
  rows: readonly VisibleSessionRow[];
  decorations: SessionTabDecorations;
}

/**
 * The single tab row of a lens (DD-7): the lens's promoted tabs that are visible, then — when the
 * active tab is not one of them — a `border-l` divider and that tab (wireframe c4). Every other
 * visible tab sits in "More ▾" (`session-tabs-more`) under its session group header; promoted tabs
 * that do not fit the width join them. Triggers are `SessionTabTrigger`s, so a tab has the same
 * test id, decoration and tooltip in the row and in More (DD-4).
 */
export function SessionLensRow({
  lens,
  sessionTab,
  onSessionTabChange,
  rows,
  decorations,
}: Props) {
  const visible = useMemo(() => rows.map((r) => r.tab), [rows]);
  const { row, extra, more } = useMemo(
    () => lensRow(lens, sessionTab, visible),
    [lens, sessionTab, visible],
  );

  const toItem = (tab: SessionTab, section?: string): OverflowItem[] => {
    const r = rows.find((x) => x.tab === tab);
    if (r === undefined) return [];
    return [
      {
        id: tab,
        section,
        render: (placement) => (
          <SessionTabTrigger
            row={r.row}
            active={tab === sessionTab}
            placement={placement}
            decorations={decorations}
            onSelect={() => onSessionTabChange(tab)}
          />
        ),
      },
    ];
  };

  const rowItems = row.flatMap((t) => toItem(t));
  const menuItems = more.flatMap((g) =>
    g.tabs.flatMap((t) => toItem(t, g.group)),
  );
  const extraRow =
    extra === null ? undefined : rows.find((r) => r.tab === extra);

  const decorationKey = `${decorations.bashCount ?? ''}|${decorations.toolsFailure === true ? 1 : 0}`;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <OverflowRow
        items={rowItems}
        menuItems={menuItems}
        sections={SESSION_GROUPS}
        activeId={sessionTab}
        moreTestId="session-tabs-more"
        measureKey={decorationKey}
        aria-label="Session tabs"
        trailing={
          extraRow === undefined ? undefined : (
            <div
              className="flex items-center border-l border-border pl-1"
              data-testid="session-lens-extra"
            >
              <SessionTabTrigger
                row={extraRow.row}
                active
                placement="row"
                decorations={decorations}
                onSelect={() => onSessionTabChange(extraRow.tab)}
              />
            </div>
          )
        }
      />
    </div>
  );
}
