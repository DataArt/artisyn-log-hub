import { Eye } from 'lucide-react';
import { LENSES, parseLens, type LensId } from './session-lenses';

interface Props {
  lens: LensId;
  onLensChange: (lens: LensId) => void;
}

/**
 * The session lens select (DD-7): a compact "View" select at the start of the session tab row
 * (`data-testid="session-lens"`, value = the lens id). It is a view switch, not a level of tabs:
 * the bar keeps one row of tabs. Picking a lens is handled by the pane, which opens the lens's
 * default tab and remembers the lens.
 */
export function SessionLensSwitcher({ lens, onLensChange }: Props) {
  return (
    // Kept narrow (icon, small text, capped width) so the tab row next to it keeps its room.
    <label
      className="mr-1 flex shrink-0 items-center gap-1 text-muted-foreground"
      title="View: which tabs the row shows; every other tab is under More"
    >
      <Eye className="size-3.5" aria-hidden />
      <select
        data-testid="session-lens"
        aria-label="Session view"
        value={lens}
        onChange={(e) => {
          const next = parseLens(e.target.value);
          if (next !== null && next !== lens) onLensChange(next);
        }}
        className="h-7 max-w-[8.5rem] rounded-md border border-border bg-background px-1 text-xs font-medium text-foreground"
      >
        {LENSES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
