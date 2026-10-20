import { useSearchParams } from 'react-router-dom';
import { formatGeneratedAt, formatPeriodLabel } from './report-format';
import { formatAttributeFilterLabel } from './report-url';

interface Props {
  title: string;
  repoUrl: string;
  teamName: string | null;
  startDate: string;
  endDate: string;
  /** Extra muted line under the title, e.g. "Artisyn Log Hub · Telemetry
   * Report" (see wireframes/report-header.svg). Omitted by default — other
   * reports keep the current header with no extra line. */
  dataSourceLabel?: string;
  /** Render the period as a rounded pill instead of the plain "Period: …"
   * text line. Omitted (default) keeps the existing plain-text rendering. */
  periodAsBadge?: boolean;
}

// Shared on-page header for every report document — title, repo/team, period,
// generated-on timestamp. Every report in the Reports tab is a printable
// document now, so this header is identical across all of them.
export function ReportDocumentHeader({
  title,
  repoUrl,
  teamName,
  startDate,
  endDate,
  dataSourceLabel,
  periodAsBadge,
}: Props) {
  // Prints the current URL's `attr=` filter(s), so a filtered
  // export can never be mistaken for an unfiltered one. Read directly off the URL (rather
  // than threaded through as a prop) so every report gets this for free through this one
  // shared header, regardless of whether its own report currently has a UI control that sets
  // `attr=` — the filter still round-trips through the URL either way.
  const [searchParams] = useSearchParams();
  const attrFilterLabels = searchParams
    .getAll('attr')
    .map(formatAttributeFilterLabel);

  return (
    <div className="mb-4 border-b border-border pb-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold text-foreground">{title}</h1>
        <span className="text-xs text-muted-foreground">
          Generated on {formatGeneratedAt()} UTC
        </span>
      </div>
      {dataSourceLabel && (
        <p className="text-xs font-medium text-muted-foreground">
          {dataSourceLabel}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {repoUrl}
        {teamName ? ` · ${teamName}` : ''}
      </p>
      {attrFilterLabels.length > 0 && (
        <p className="mt-0.5 text-xs font-medium text-foreground">
          Attribute filter: {attrFilterLabels.join(' · ')}
        </p>
      )}
      {periodAsBadge ? (
        <span className="mt-1 inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground">
          {formatPeriodLabel(startDate, endDate)}
        </span>
      ) : (
        <p className="text-xs text-muted-foreground">
          Period: {formatPeriodLabel(startDate, endDate)}
        </p>
      )}
    </div>
  );
}
