/**
 * A link that opens the in-app help on a section of `user-docs/otel-tab.md` (offline, no
 * external link — "Offline first"). The help modal is lazy-loaded on the first click.
 */
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { OTEL_HELP_SLUG } from './otel.constants';

const HelpModal = lazy(() =>
  import('../../../help/HelpModal').then((m) => ({ default: m.HelpModal })),
);

export interface OtelHelpLinkProps {
  /** Heading id in `otel-tab.md` (`OTEL_HELP_ANCHORS`). */
  anchor: string;
  children: ReactNode;
  /** `button` renders an outlined button instead of an inline link. */
  variant?: 'link' | 'button';
  className?: string;
}

export function OtelHelpLink({
  anchor,
  children,
  variant = 'link',
  className,
}: OtelHelpLinkProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      <button
        type="button"
        className={cn(
          variant === 'link'
            ? 'text-blue-600 underline-offset-2 hover:underline'
            : 'rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent',
          className,
        )}
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
      >
        {children}
      </button>
      {loaded && (
        <Suspense fallback={null}>
          <HelpModal
            open={open}
            onOpenChange={setOpen}
            initialSlug={OTEL_HELP_SLUG}
            initialAnchor={anchor}
          />
        </Suspense>
      )}
    </>
  );
}
