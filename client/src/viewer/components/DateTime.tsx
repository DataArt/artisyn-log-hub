interface DateTimeProps {
  value: string | Date | null | undefined;
}

function formatDateTime(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}.${mo}.${d} ${h}:${mi}:${s}`;
}

export function DateTime({ value }: DateTimeProps) {
  if (!value) return <span className="text-muted-foreground">—</span>;

  const date = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(date.getTime()))
    return <span className="text-muted-foreground">—</span>;

  return <span>{formatDateTime(date)}</span>;
}
