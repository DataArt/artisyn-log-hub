import { cn } from '../../../lib/cn';

export function SourceBadge({
  source,
}: {
  source?: 'project' | 'user' | 'plugin';
}) {
  if (!source) return <span className="text-muted-foreground">—</span>;
  const cls =
    source === 'project'
      ? 'text-sky-600 dark:text-sky-400'
      : source === 'user'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-violet-600 dark:text-violet-400';
  return <span className={cn('text-xs', cls)}>{source}</span>;
}
