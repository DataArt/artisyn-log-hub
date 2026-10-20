import { cn } from '../../../lib/cn';

export function SourceBadge({
  source,
}: {
  source?: 'project' | 'builtin' | 'plugin';
}) {
  if (!source) return <span className="text-muted-foreground">—</span>;
  const cls =
    source === 'project'
      ? 'text-sky-600 dark:text-sky-400'
      : source === 'plugin'
        ? 'text-violet-600 dark:text-violet-400'
        : 'text-muted-foreground';
  const label =
    source === 'project'
      ? 'project'
      : source === 'plugin'
        ? 'plugin'
        : 'built-in';
  return <span className={cn('text-xs', cls)}>{label}</span>;
}
