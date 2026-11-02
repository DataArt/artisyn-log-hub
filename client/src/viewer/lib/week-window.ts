/**
 * The "this week" window shared by Home and the map's question targets: the last 7 × 24 hours
 * ending at `now`.
 *
 * `from` / `to` are full ISO timestamps (the executive-summary endpoint parses them with
 * `new Date()`); `fromDate` / `toDate` are the local `YYYY-MM-DD` dates for the date-only URL
 * params (Reports `startDate`/`endDate`, Tools/MCP `tfrom`/`tto`).
 */

export const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeekWindow {
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
}

function localDate(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function weekWindow(now: Date): WeekWindow {
  const start = new Date(now.getTime() - WEEK_WINDOW_MS);
  return {
    from: start.toISOString(),
    to: now.toISOString(),
    fromDate: localDate(start),
    toDate: localDate(now),
  };
}
