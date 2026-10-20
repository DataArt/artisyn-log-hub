export function formatRelativeDate(dateInput: string | Date): string {
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (isToday) return `today ${time}`;
  if (diffDays < 2) return `yesterday ${time}`;
  if (diffDays < 7)
    return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })} ${time}`;
}

export function formatDurationMinutes(durationMinutes?: number): string {
  if (!durationMinutes) return '\u2014';
  if (durationMinutes < 1) return '<1m';
  if (durationMinutes < 60) return `${Math.round(durationMinutes)}m`;
  const h = Math.floor(durationMinutes / 60);
  const m = Math.round(durationMinutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatCostUsd(totalCost?: number): string {
  if (totalCost == null) return '\u2014';
  if (totalCost < 0.01) return '<$0.01';
  return `$${totalCost.toFixed(2)}`;
}
