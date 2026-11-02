/**
 * The card shell every Home widget renders in (FR-F5a): a title, an optional header action, a
 * skeleton while the widget's data loads, an "Error" line with Retry when it failed, and the
 * widget's `data-testid`. The shell itself renders at once — only its body waits for data.
 */
import type { ReactNode } from 'react';
import { RotateCw, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Skeleton } from '../../../ui/skeleton';
import { HOME_TONES, type HomeTone } from './home-tones';

export interface HomeWidgetProps {
  /** `home-repos`, `home-questions`, … (DD-4). */
  testId: string;
  title: ReactNode;
  /** Header icon, shown in a chip of the widget's tone. */
  icon?: LucideIcon;
  /** The widget's muted colour (home-tones.ts); `slate` when not set. */
  tone?: HomeTone;
  /** Shown on the right of the title (a link, a select). */
  action?: ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  /** Retry after an error (the widget's `refetch`). */
  onRetry?: () => void;
  /** Placeholder line count while loading. */
  skeletonLines?: number;
  className?: string;
  children?: ReactNode;
}

export function HomeWidget({
  testId,
  title,
  icon: Icon,
  tone = 'slate',
  action,
  isLoading = false,
  isError = false,
  onRetry,
  skeletonLines = 3,
  className,
  children,
}: HomeWidgetProps) {
  const toneClasses = HOME_TONES[tone];
  return (
    <section
      data-testid={testId}
      aria-busy={isLoading || undefined}
      className={cn(
        'relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-lg border border-border bg-card p-4 text-card-foreground',
        className,
      )}
    >
      {/* The tone accent is a strip inside the card, clipped by its rounded corners — a coloured
          top border would meet the grey side borders in a jagged corner. */}
      <span
        aria-hidden
        className={cn('absolute inset-x-0 top-0 h-0.5', toneClasses.accent)}
      />
      <header className="flex min-h-7 items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {Icon && (
            <span
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-md ring-1',
                toneClasses.chip,
              )}
              aria-hidden
            >
              <Icon className="size-4" />
            </span>
          )}
          {title}
        </h2>
        {action}
      </header>
      {isError ? (
        <HomeWidgetError onRetry={onRetry} />
      ) : isLoading ? (
        <HomeSkeletonLines count={skeletonLines} />
      ) : (
        children
      )}
    </section>
  );
}

export function HomeSkeletonLines({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-2" data-testid="home-widget-skeleton">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

export function HomeWidgetError({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 text-sm text-destructive"
    >
      <span>Error</span>
      {onRetry && (
        <button
          type="button"
          data-testid="home-widget-retry"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:bg-accent"
        >
          <RotateCw className="size-3" aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}

/** A muted one-line empty state inside a widget. */
export function HomeEmpty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
