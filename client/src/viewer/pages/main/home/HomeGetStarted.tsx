/**
 * Home's Get started widget, shown instead of the empty sections when the viewer has no
 * repositories and no teams: install the hook (API keys › Install, seeded through router state
 * `apiKeysTab`), and the offline help articles "Your first session" and "Connecting a
 * Repository" (in-app help, lazy-loaded on the first click).
 */
import { lazy, Suspense, useState } from 'react';
import { Rocket } from 'lucide-react';
import { Link } from 'react-router-dom';
import { routes } from '../../../hooks/useHashRoute';
import { HomeWidget } from './HomeWidget';

const HelpModal = lazy(() =>
  import('../../../help/HelpModal').then((m) => ({ default: m.HelpModal })),
);

const HELP_LINKS = [
  { slug: 'getting-started', label: 'Your first session' },
  { slug: 'connect-repository', label: 'Connecting a repository' },
] as const;

export function HomeGetStarted() {
  const [helpSlug, setHelpSlug] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  return (
    <HomeWidget
      testId="home-get-started"
      title="Get started"
      icon={Rocket}
      tone="teal"
    >
      <p className="text-sm text-muted-foreground">
        You have no repositories yet. Install the hook in a repository and its
        Claude Code sessions show up here.
      </p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
        <li>
          <Link
            to={routes.apiKeys}
            state={{ apiKeysTab: 'install' }}
            data-testid="home-get-started-install"
            className="text-primary hover:underline"
          >
            Install the hook
          </Link>
        </li>
        {HELP_LINKS.map((h) => (
          <li key={h.slug}>
            <button
              type="button"
              data-testid={`home-get-started-help-${h.slug}`}
              onClick={() => {
                setLoaded(true);
                setHelpSlug(h.slug);
              }}
              className="text-primary hover:underline"
            >
              {h.label}
            </button>
          </li>
        ))}
      </ol>
      {loaded && (
        <Suspense fallback={null}>
          <HelpModal
            open={helpSlug !== null}
            onOpenChange={(open) => {
              if (!open) setHelpSlug(null);
            }}
            initialSlug={helpSlug ?? undefined}
          />
        </Suspense>
      )}
    </HomeWidget>
  );
}
