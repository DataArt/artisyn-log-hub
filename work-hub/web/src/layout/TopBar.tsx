import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { logout } from "../api/auth";
import { useAuth } from "../auth/AuthContext";
import { useAuthConfig } from "../auth/useAuthConfig";
import { ChangePasswordDialog } from "../pages/password/ChangePasswordDialog";
import { ROUTE } from "../routes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import styles from "./TopBar.module.css";

export interface TopBarProps {
  /** Shown after "Artisyn AI Work Hub ›" (the workspace name, a page title). */
  crumb?: ReactNode;
  /** Slots right of the crumb, in this order (Visual/UX): History, Settings, Configure. */
  history?: ReactNode;
  settings?: ReactNode;
  configure?: ReactNode;
}

/** The account menu: "Edit email" under mode `none`, "Logout" otherwise (as in Log Hub). */
function UserMenu() {
  const { user, setUser } = useAuth();
  const { data: authConfig } = useAuthConfig();
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  const isIdentifyMode = authConfig?.mode === "none";
  const canChangePassword =
    authConfig?.mode === "password" || authConfig?.mode === "password-confirm";

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setIsLoggingOut(false);
      setUser(null);
      void navigate(ROUTE.login);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="user-menu"
            className={styles.userButton}
          >
            <span className={styles.userEmail}>{user?.email}</span>
            <ChevronDown className={styles.userChevron} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className={styles.menu}>
          <DropdownMenuLabel>
            <p className={styles.signedInAs}>Signed in as</p>
            <p className={styles.menuEmail}>{user?.email}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {canChangePassword && (
            <DropdownMenuItem onSelect={() => setChangePasswordOpen(true)}>
              <KeyRound className={styles.primaryIcon} />
              Change password
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={isLoggingOut}
            onSelect={() => void handleLogout()}
          >
            {isLoggingOut ? (
              <Loader2 className={styles.spin} />
            ) : isIdentifyMode ? (
              <Mail />
            ) : (
              <LogOut />
            )}
            {isIdentifyMode ? "Edit email" : "Logout"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {changePasswordOpen && (
        <ChangePasswordDialog
          email={user?.email ?? ""}
          onClose={() => setChangePasswordOpen(false)}
        />
      )}
    </>
  );
}

/** The header of every signed-in page: "Artisyn AI Work Hub › <crumb>", page slots, user menu. */
export function TopBar({ crumb, history, settings, configure }: TopBarProps) {
  return (
    <header className={styles.header}>
      <nav className={styles.nav}>
        <Link to={ROUTE.workspaces} className={styles.home}>
          Artisyn AI Work Hub
        </Link>
        {crumb != null && (
          <>
            <ChevronRight className={styles.crumbChevron} />
            <span className={styles.crumb}>{crumb}</span>
          </>
        )}
      </nav>
      <div className={styles.slots}>
        {history}
        {settings}
        {configure}
        <UserMenu />
      </div>
    </header>
  );
}
