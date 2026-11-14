import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  createHashRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from "react-router-dom";

import styles from "./App.module.css";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { DockerStatusGate } from "./layout/DockerStatusGate";
import { HistoryPage } from "./pages/history/HistoryPage";
import { ConfirmEmailPage } from "./pages/confirm/ConfirmEmailPage";
import { LoginPage } from "./pages/login/LoginPage";
import { ForgotPasswordPage } from "./pages/password/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/password/ResetPasswordPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { SignupPage } from "./pages/signup/SignupPage";
import { WorkspacePage } from "./pages/workspace/WorkspacePage";
import { WorkspacesPage } from "./pages/workspaces/WorkspacesPage";
import { ROUTE } from "./routes";
import { Button } from "./ui/button";
import { ToastProvider } from "./ui/toast";
import { TooltipProvider } from "./ui/tooltip";

/** A 4xx is an answer, not a glitch: only network and 5xx errors are retried. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const statusCode =
          "statusCode" in error && typeof error.statusCode === "number"
            ? error.statusCode
            : undefined;
        if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
          return false;
        }
        return failureCount < 3;
      },
      refetchOnWindowFocus: false,
    },
  },
});

/** Waits for the first `GET /auth/me` before any route renders. */
function Bootstrap() {
  const { status, refresh } = useAuth();

  if (status === "loading") {
    return (
      <div className={styles.loading}>
        <Loader2 className={styles.spinner} />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className={styles.error}>
        <p className={styles.errorText}>
          Unable to connect to the server. Please try again.
        </p>
        <Button onClick={refresh}>Retry</Button>
      </div>
    );
  }
  return <Outlet />;
}

/** Sends a signed-out user to `#/login`, remembering where they were going. */
function AuthGuard() {
  const { user } = useAuth();
  const location = useLocation();
  if (user === null) {
    return <Navigate to={ROUTE.login} state={{ from: location }} replace />;
  }
  return <Outlet />;
}

/** Every signed-in page: the Docker / image gate around a full-height column. */
function AppLayout() {
  return (
    <div className={styles.layout}>
      <DockerStatusGate>
        <Outlet />
      </DockerStatusGate>
    </div>
  );
}

const router = createHashRouter([
  {
    element: <Bootstrap />,
    children: [
      { path: ROUTE.login, element: <LoginPage /> },
      { path: ROUTE.signup, element: <SignupPage /> },
      { path: ROUTE.confirmEmail, element: <ConfirmEmailPage /> },
      { path: ROUTE.forgotPassword, element: <ForgotPasswordPage /> },
      { path: ROUTE.resetPassword, element: <ResetPasswordPage /> },
      {
        element: <AuthGuard />,
        children: [
          {
            element: <AppLayout />,
            children: [
              {
                path: ROUTE.workspaces,
                element: <WorkspacesPage />,
              },
              {
                path: ROUTE.workspace,
                element: <WorkspacePage />,
              },
              {
                path: ROUTE.workstream,
                element: <WorkspacePage />,
              },
              {
                path: ROUTE.history,
                element: <HistoryPage />,
              },
              {
                path: ROUTE.settings,
                element: <SettingsPage />,
              },
              {
                path: "*",
                element: <Navigate to={ROUTE.workspaces} replace />,
              },
            ],
          },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
