import {
  type BuildVersion,
  useBuildVersion,
} from '../../hooks/useBuildVersion';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../ui/tooltip';

export interface BuildTooltipRow {
  label: string;
  value: string;
}

function isKnown(value: string | undefined | null): value is string {
  return !!value && value !== 'unknown';
}

/**
 * Rows of the build-label tooltip. A row is dropped when its value is empty, `'unknown'` or an
 * invalid date; `Official release` is shown only when the server sent `origin` (older and
 * unbundled servers do not).
 */
export function buildTooltipRows(v: BuildVersion): BuildTooltipRow[] {
  const origin = v.origin;
  const rows: BuildTooltipRow[] = [];
  if (origin && isKnown(origin.branch)) {
    rows.push({ label: 'Branch', value: origin.branch });
  }
  const version = origin?.version ?? v.version;
  if (isKnown(version)) rows.push({ label: 'Version', value: version });
  if (origin && isKnown(origin.builtAt)) {
    const builtAt = new Date(origin.builtAt);
    if (!Number.isNaN(builtAt.getTime())) {
      rows.push({ label: 'Built', value: builtAt.toLocaleString() });
    }
  }
  if (origin) {
    rows.push({
      label: 'Official release',
      value: origin.officialRelease ? 'Yes' : 'No',
    });
  }
  if (isKnown(v.gitCommit)) rows.push({ label: 'Commit', value: v.gitCommit });
  return rows;
}

/**
 * The short build label next to the app name, with a tooltip naming where the build came from.
 * The short commit identifies the running build; without a baked-in commit (local dev) the label
 * falls back to the version.
 */
export function BuildLabel() {
  const { data: buildVersion } = useBuildVersion();
  if (!buildVersion) return null;
  const label =
    buildVersion.gitCommit && buildVersion.gitCommit !== 'unknown'
      ? buildVersion.gitCommit.slice(0, 7)
      : buildVersion.version;
  if (!label) return null;
  const rows = buildTooltipRows(buildVersion);

  const trigger = (
    <span
      data-testid="nav-build-label"
      tabIndex={0}
      className="ml-1.5 font-normal text-xs text-muted-foreground font-mono"
    >
      {label}
    </span>
  );
  if (rows.length === 0) return trigger;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent variant="light" side="bottom">
          <div
            data-testid="nav-build-tooltip"
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs"
          >
            {rows.map((row) => (
              <div key={row.label} className="contents">
                <span className="text-muted-foreground">{row.label}</span>
                <span className="font-mono">{row.value}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
