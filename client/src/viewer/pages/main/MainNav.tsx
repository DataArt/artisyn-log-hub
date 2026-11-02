import { lazy, Suspense, useState } from 'react';
import { HelpCircle, House, LayoutGrid, Loader2 } from 'lucide-react';
import { logout } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useAuthConfig } from '../../hooks/useAuthConfig';
import { useLocation, useNavigate } from 'react-router-dom';
import { routes } from '../../hooks/useHashRoute';
import { NotificationBell } from '../../components/top-nav/NotificationBell';
import { AppLogo } from '../../components/top-nav/AppLogo';
import { UserMenu } from '../../components/top-nav/UserMenu';
import { AccessModeBadge } from '../../components/teams/AccessModeBadge';
import { Button } from '../../ui/button';
import { useBuildVersion } from '../../hooks/useBuildVersion';
import { useOpenAllViews } from '../../hooks/useAllViewsShortcut';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../ui/tooltip';

const HelpModal = lazy(() =>
  import('../../help/HelpModal').then((m) => ({ default: m.HelpModal })),
);

export function MainNav() {
  const { user, setUser } = useAuth();
  const { data: authConfig } = useAuthConfig();
  const navigate = useNavigate();
  const onHome = useLocation().pathname === routes.main;
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpLoaded, setHelpLoaded] = useState(false);
  const { data: buildVersion } = useBuildVersion();
  const openAllViews = useOpenAllViews();
  // The short commit identifies the running build; the package version is not bumped per
  // release, so it went stale. Without a baked-in commit (local dev) fall back to the version.
  const buildLabel = !buildVersion
    ? null
    : buildVersion.gitCommit && buildVersion.gitCommit !== 'unknown'
      ? buildVersion.gitCommit.slice(0, 7)
      : buildVersion.version;
  // Mode 1 has no separate logout concept — "Edit email" calls the same
  // endpoint but returns to the identify prompt instead of the login form.
  const isNoAuthMode = authConfig?.mode === 'none';

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setUser(null);
      navigate(routes.login);
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2">
      <AppLogo />
      <span className="font-semibold text-sm">
        {user?.env_name
          ? `[${user.env_name}] Artisyn Log Hub`
          : 'Artisyn Log Hub'}
        {buildLabel && (
          <span
            className="ml-1.5 font-normal text-xs text-muted-foreground font-mono"
            title={buildVersion?.gitCommit}
          >
            {buildLabel}
          </span>
        )}
      </span>
      {/* Home sits on the left, next to the app name, where it is looked for first. */}
      <Button
        variant="ghost"
        size="sm"
        data-testid="nav-home"
        aria-current={onHome ? 'page' : undefined}
        className={onHome ? 'bg-accent' : undefined}
        onClick={() => void navigate(routes.main)}
      >
        <House className="size-4" />
        Home
      </Button>
      <div className="flex-1" />
      {/* Names the access mode of the team whose route is open; renders
          nothing on every other route. */}
      <AccessModeBadge />
      {/* The All views map, scoped to the current route (DD-18). */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-testid="nav-all-views"
              onClick={openAllViews}
            >
              <LayoutGrid className="size-4" />
              All views
            </Button>
          </TooltipTrigger>
          <TooltipContent variant="light" side="bottom">
            All views (Ctrl+K)
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setHelpOpen(true);
          setHelpLoaded(true);
        }}
        aria-label="Help"
      >
        <HelpCircle className="size-4" />
      </Button>
      <NotificationBell />
      {isNoAuthMode ? (
        <>
          <span className="text-sm text-muted-foreground">{user?.email}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            disabled={isLoggingOut}
          >
            {isLoggingOut && <Loader2 className="animate-spin size-3.5 mr-1" />}
            Edit email
          </Button>
        </>
      ) : (
        // Every other mode gets the account menu, which owns "Log out" plus the
        // change-password / delete-account actions.
        <UserMenu />
      )}
      {helpLoaded && (
        <Suspense fallback={null}>
          <HelpModal open={helpOpen} onOpenChange={setHelpOpen} />
        </Suspense>
      )}
    </div>
  );
}
