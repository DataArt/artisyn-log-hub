// Shared date/period formatting for report documents (on-page and PDF).
export function formatPeriodLabel(startDate: string, endDate: string): string {
  const fmt = (d: string) =>
    new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(d + 'T00:00:00'));
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

// Report totals routinely span many hours (e.g. "Total Work Time" across a
// 30-day period) — @/lib/format's formatDuration only rolls up to minutes,
// so a large total prints as an unreadable "1751m 43s". Reports need an
// hour-aware format instead.
export function formatReportDuration(ms: number): string {
  const totalMinutes = ms / 60_000;
  if (totalMinutes < 1) return '<1m';
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatGeneratedAt(): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date());
}

// Single-timestamp counterpart of formatPeriodLabel, for row-level dates
// (e.g. a session's start time in a per-session table) rather than a range.
export function formatReportDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

// Compact token-count format for report tables (e.g. "412k"), matching the
// "TOKENS (IN / OUT)" column style in tmp/exec-report/img_1.png.
export function formatReportTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
