// The Login service tab (FR-24, D11): the agent's login program in a terminal.
// The login itself is started by `AgentLoginDialog` (`POST …/login/start`, idempotent); this tab
// attaches to it. A socket to a session that is no longer running gets `ended` at once.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { errorMessage } from "../../api/client";
import {
  cancelLogin,
  getLoginLink,
  loginSocketPath,
  workspaceKeys,
} from "../../api/workspaces";
import { TerminalView } from "../../terminal/TerminalView";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import styles from "./LoginTab.module.css";

export interface LoginTabProps {
  workspaceId: string;
  /** Display name of the agent (`agentName` from the API). */
  agentName?: string;
  /** Closes the service tab. */
  onClose: () => void;
}

export function LoginTab({ workspaceId, agentName, onClose }: LoginTabProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [skipping, setSkipping] = useState(false);
  const [notLoggedIn, setNotLoggedIn] = useState(false);
  const [pasted, setPasted] = useState<number | null>(null);
  const closedRef = useRef(false);

  // The sign-in link, taken from the terminal by the server (whole, even when wrapped), so it
  // can be opened or copied with one click instead of being selected in the terminal.
  const link = useQuery({
    queryKey: [...workspaceKeys.detail(workspaceId), "login-link"],
    queryFn: () => getLoginLink(workspaceId),
    refetchInterval: (q) => (q.state.data?.url ? false : 2000),
    enabled: !notLoggedIn,
  });
  const url = link.data?.url ?? null;

  const copyLink = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.show("Link copied", "success");
    } catch {
      toast.show("Couldn't copy the link. Use Open instead.", "error");
    }
  };

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.detail(workspaceId),
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.all,
      exact: true,
    });
  }, [queryClient, workspaceId]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  }, [onClose]);

  const handleEnded = useCallback(
    ({ loggedIn }: { loggedIn?: boolean }) => {
      refresh();
      if (loggedIn) {
        toast.show(`Logged in to ${agentName ?? "the agent"}.`, "success");
        close();
      } else {
        setNotLoggedIn(true);
      }
    },
    [refresh, toast, agentName, close],
  );

  const skip = async () => {
    setSkipping(true);
    try {
      await cancelLogin(workspaceId);
    } catch (err) {
      toast.show(errorMessage(err), "error");
    } finally {
      setSkipping(false);
    }
    refresh();
    close();
  };

  return (
    <div className={styles.tab} data-testid="login-tab">
      <div className={styles.bar}>
        <span className={styles.barText}>
          {notLoggedIn
            ? "The login did not finish. You can log in later from the workspace."
            : pasted !== null
              ? `Pasted ${pasted} characters (the terminal does not show them). Press Enter.`
              : `Log in to ${agentName ?? "the agent"}: open the sign-in page, then paste the code into the terminal below and press Enter.`}
        </span>
        {notLoggedIn ? (
          <Button size="sm" variant="outline" onClick={close}>
            Close
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={skipping}
            onClick={() => void skip()}
          >
            Skip for now
          </Button>
        )}
      </div>
      {url && !notLoggedIn && (
        <div className={styles.linkBar} data-testid="login-link-bar">
          <span className={styles.linkText} title={url}>
            {url}
          </span>
          <Button
            size="sm"
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            data-testid="login-link-open"
          >
            <ExternalLink />
            Open sign-in page
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyLink()}
            data-testid="login-link-copy"
          >
            <Copy />
            Copy link
          </Button>
        </div>
      )}
      <div className={styles.body}>
        <TerminalView
          wsPath={loginSocketPath(workspaceId)}
          onEnded={handleEnded}
          takenOverText="This login was opened in another tab"
          onPaste={setPasted}
        />
      </div>
    </div>
  );
}
