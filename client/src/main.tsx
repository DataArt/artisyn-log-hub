import './viewer/app.css';
import {
  createHashRouter,
  RouterProvider,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react';
import {
  fetchMe,
  ApiError,
  setUnauthorizedHandler,
  clearLogoutGuard,
} from './viewer/api';
import { useKeepAlive } from './viewer/hooks/useKeepAlive';
import { ROUTE } from './app-routes';
import { routes } from './viewer/hooks/useHashRoute';
import { AuthProvider, useAuth } from './viewer/context/AuthContext';
import { AppShell } from './viewer/components/AppShell';
import { DataCollectionConsentScreen } from './viewer/components/DataCollectionConsentScreen';
import { PendingDisclosureGate } from './viewer/components/teams/PendingDisclosureGate';
import { useDataCollectionConsent } from './viewer/hooks/useDataCollectionConsent';
import { useNewUserNudge } from './viewer/hooks/useNewUserNudge';
import {
  consentNoticeQuery,
  retentionDaysQuery,
  userSettingsQuery,
} from './viewer/lib/consent-queries';
import { LazyFallback } from './viewer/components/LazyFallback';
import { RepositoryView } from './viewer/pages/repository/RepositoryView';
import { Button } from './viewer/ui/button';

const LoginPage = lazy(() =>
  import('./viewer/pages/auth-lazy-group').then((m) => ({
    default: m.LoginPage,
  })),
);
const SignupPage = lazy(() =>
  import('./viewer/pages/auth-lazy-group').then((m) => ({
    default: m.SignupPage,
  })),
);
const ForgotPasswordPage = lazy(() =>
  import('./viewer/pages/auth-lazy-group').then((m) => ({
    default: m.ForgotPasswordPage,
  })),
);
const ResetPasswordPage = lazy(() =>
  import('./viewer/pages/auth-lazy-group').then((m) => ({
    default: m.ResetPasswordPage,
  })),
);
const ConfirmEmailPage = lazy(() =>
  import('./viewer/pages/auth-lazy-group').then((m) => ({
    default: m.ConfirmEmailPage,
  })),
);
const MainPage = lazy(() =>
  import('./viewer/pages/workspace-lazy-group').then((m) => ({
    default: m.MainPage,
  })),
);
const TeamsPage = lazy(() =>
  import('./viewer/pages/workspace-lazy-group').then((m) => ({
    default: m.TeamsPage,
  })),
);
const TeamDetailPage = lazy(() =>
  import('./viewer/pages/workspace-lazy-group').then((m) => ({
    default: m.TeamDetailPage,
  })),
);
const ApiKeysPage = lazy(() =>
  import('./viewer/pages/workspace-lazy-group').then((m) => ({
    default: m.ApiKeysPage,
  })),
);
const HookStatePage = lazy(() =>
  import('./viewer/pages/hook-state/HookStatePage').then((m) => ({
    default: m.HookStatePage,
  })),
);
const AdminPage = lazy(() =>
  import('./viewer/pages/admin/AdminPage').then((m) => ({
    default: m.AdminPage,
  })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (
          typeof statusCode === 'number' &&
          statusCode >= 400 &&
          statusCode < 500
        ) {
          return false;
        }
        return failureCount < 3;
      },
      refetchOnWindowFocus: false,
    },
  },
});

// Resolves auth state before rendering any routes.
function Bootstrap() {
  const { setUser } = useAuth();
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const navigate = useNavigate();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // A 401 from any endpoint may just mean the session expired — Mode 1
      // (auth "none") re-identifies silently via AutoIdentifyGuard on /me, so
      // retry before dropping the user onto the manual identify form.
      void fetchMe()
        .then((profile) => setUser(profile))
        .catch(() => {
          setUser(null);
          navigate(routes.login, { replace: true });
        })
        .finally(() => clearLogoutGuard());
    });
  }, [setUser, navigate]);

  function runBootstrap() {
    clearLogoutGuard();
    setStatus('loading');
    fetchMe()
      .then(async (profile) => {
        setUser(profile);
        // Everything the consent gate in AppLayout needs, resolved behind the
        // spinner that is already up — so the gate decides from cache and the
        // app never flashes in front of (or behind) the consent screen.
        await Promise.all([
          queryClient.prefetchQuery(userSettingsQuery(profile.id)),
          queryClient.prefetchQuery(consentNoticeQuery),
          queryClient.prefetchQuery(retentionDaysQuery),
        ]);
        setStatus('ok');
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.statusCode === 401) {
          setStatus('ok'); // user stays null → AuthGuard redirects to /login
        } else {
          setStatus('error');
        }
      });
  }

  useKeepAlive();

  useEffect(() => {
    runBootstrap();
    // runBootstrap is stable (defined in the component body, not reactive)
  }, []);

  if (status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground font-sans">
        <Loader2 className="animate-spin size-6" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex h-screen items-center justify-center flex-col gap-4 bg-background text-foreground font-sans">
        <p className="text-sm text-muted-foreground">
          Unable to connect to the server. Please try again.
        </p>
        <Button onClick={runBootstrap}>Retry</Button>
      </div>
    );
  }

  return <Outlet />;
}

// Redirects unauthenticated users to /login, saving current location for restore.
function AuthGuard() {
  const { user } = useAuth();
  const location = useLocation();
  if (user === null) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <Outlet />;
}

// Restricts access to admin-only routes; non-admins are redirected to /main.
function AdminGuard() {
  const { user } = useAuth();
  if (user === null || user.role !== 'admin') {
    return <Navigate to="/main" replace />;
  }
  return <Outlet />;
}

// Separate component so useNewUserNudge is never called conditionally: it
// only ever mounts once consent is in place.
function AuthedApp() {
  useNewUserNudge();
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

// Gates every authenticated route behind the data-collection notice. The
// consent screen *replaces* the shell rather than overlaying it, so a deep
// link cannot get behind it and none of the shell queries fire.
function AppLayout() {
  const consent = useDataCollectionConsent();
  if (consent === 'loading') {
    // Only reachable when the identity changed without a reload (auth mode
    // "none"), so the new user's settings still have to be fetched. Showing
    // the same spinner Bootstrap uses keeps both the app and the notice hidden
    // until we know which one is right.
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground font-sans">
        <Loader2 className="animate-spin size-6" />
      </div>
    );
  }
  if (consent === 'required') {
    return <DataCollectionConsentScreen />;
  }
  // The login-time disclosure gate sits one layer behind the data-collection notice: the app itself is
  // usable, but any team the user was added to without an Accept step puts its
  // disclosure up as a modal until acknowledged.
  return (
    <>
      <PendingDisclosureGate />
      <AuthedApp />
    </>
  );
}

function withSuspense(element: ReactElement) {
  return <Suspense fallback={<LazyFallback fullScreen />}>{element}</Suspense>;
}

const router = createHashRouter([
  {
    element: <Bootstrap />,
    children: [
      { path: ROUTE.login, element: withSuspense(<LoginPage />) },
      { path: ROUTE.signup, element: withSuspense(<SignupPage />) },
      {
        path: ROUTE.forgotPassword,
        element: withSuspense(<ForgotPasswordPage />),
      },
      {
        path: ROUTE.resetPassword,
        element: withSuspense(<ResetPasswordPage />),
      },
      { path: ROUTE.confirmEmail, element: withSuspense(<ConfirmEmailPage />) },
      {
        element: <AuthGuard />,
        children: [
          {
            element: <AppLayout />,
            children: [
              { index: true, element: <Navigate to="/main" replace /> },
              { path: ROUTE.main, element: withSuspense(<MainPage />) },
              { path: ROUTE.teams, element: withSuspense(<TeamsPage />) },
              {
                path: ROUTE.teamDetail,
                element: withSuspense(<TeamDetailPage />),
              },
              { path: ROUTE.apiKeys, element: withSuspense(<ApiKeysPage />) },
              { path: ROUTE.repo, element: <RepositoryView /> },
              {
                path: ROUTE.teamRepo,
                element: <RepositoryView />,
              },
              {
                path: ROUTE.hookState,
                element: withSuspense(<HookStatePage />),
              },
              {
                element: <AdminGuard />,
                children: [
                  { path: ROUTE.admin, element: withSuspense(<AdminPage />) },
                ],
              },
              {
                path: ROUTE.notFound,
                element: <Navigate to="/main" replace />,
              },
            ],
          },
        ],
      },
    ],
  },
]);

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </QueryClientProvider>,
);
