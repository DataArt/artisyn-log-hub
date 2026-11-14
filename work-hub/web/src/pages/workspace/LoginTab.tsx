// The Login service tab (FR-24, D11): the agent's login program in a terminal.
// The login itself is started by `AgentLoginDialog` (`POST …/login/start`, idempotent); this tab
// attaches to it. A socket to a session that is no longer running gets `ended` at once.

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { errorMessage } from "../../api/client";
import {
  cancelLogin,
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
  const closedRef = useRef(false);

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
            : `Log in to ${agentName ?? "the agent"} in the terminal below. A pasted code shows as * and is sent with Enter.`}
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
      <div className={styles.body}>
        <TerminalView
          wsPath={loginSocketPath(workspaceId)}
          onEnded={handleEnded}
          takenOverText="This login was opened in another tab"
          maskPastes
        />
      </div>
    </div>
  );
}
