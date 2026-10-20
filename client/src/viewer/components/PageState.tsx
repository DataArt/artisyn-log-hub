import { cn } from '../lib/cn';

export function PageState({
  message,
  variant = 'muted',
}: {
  message: string;
  variant?: 'muted' | 'error';
}) {
  return (
    <div
      className={cn(
        'flex h-full items-center justify-center text-sm',
        variant === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {message}
    </div>
  );
}
