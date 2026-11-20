// The agent login choice (FR-24, D9): "New login", "Copy from my workspace" or "Not now".
// Opened after creating a workspace, from the workspace's login banner and from
// "Open workstream" when the server answers `login_required`.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";

import { errorMessage } from "../../api/client";
import {
  copyLogin,
  listLoginSources,
  startLogin,
  workspaceKeys,
} from "../../api/workspaces";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { useToast } from "../../ui/toast";
import { LoginTab } from "./LoginTab";
import styles from "./AgentLoginDialog.module.css";

export interface AgentLoginDialogProps {
  open: boolean;
  workspaceId: string;
  /** Display name of the agent (`agentName` from the API). */
  agentName: string;
  /** Called when the dialog closes, whatever the outcome. */
  onClose: () => void;
  /**
   * When given, "New login" hands the started login to the caller (the workspace page opens it
   * as its Login service tab) and the dialog closes. Without it the dialog shows the Login tab
   * itself.
   */
  onLoginStarted?: () => void;
}

type Stage = "choose" | "login";

export function AgentLoginDialog({
  open,
  workspaceId,
  agentName,
  onClose,
  onLoginStarted,
}: AgentLoginDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("choose");
  const [busy, setBusy] = useState<"start" | "copy" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sources = useQuery({
    queryKey: workspaceKeys.loginSources(workspaceId),
    queryFn: () => listLoginSources(workspaceId),
    enabled: open && stage === "choose",
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
  };

  const close = () => {
    setStage("choose");
    setBusy(null);
    setError(null);
    onClose();
  };

  const newLogin = async () => {
    setBusy("start");
    setError(null);
    try {
      await startLogin(workspaceId);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
      return;
    }
    setBusy(null);
    if (onLoginStarted) {
      onLoginStarted();
      close();
    } else {
      setStage("login");
    }
  };

  const copyFrom = async (fromId: string, fromName: string) => {
    setBusy("copy");
    setError(null);
    try {
      const { loggedIn } = await copyLogin(workspaceId, fromId);
      refresh();
      if (loggedIn) {
        toast.show(
          `Copied the ${agentName} login from ${fromName}.`,
          "success",
        );
        close();
        return;
      }
      setError(
        `The login copied from ${fromName} does not work. Try a new login instead.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(null);
  };

  const sourceList = sources.data ?? [];

  if (stage === "login") {
    return (
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className={styles.terminalDialog}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          data-testid="agent-login-terminal-dialog"
        >
          <DialogHeader>
            <DialogTitle>Log in to {agentName}</DialogTitle>
            <DialogDescription className="sr-only">
              The {agentName} login runs in the terminal below.
            </DialogDescription>
          </DialogHeader>
          <div className={styles.terminalFrame}>
            <LoginTab
              workspaceId={workspaceId}
              agentName={agentName}
              onClose={close}
            />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && busy === null) close();
      }}
    >
      <DialogContent data-testid="agent-login-dialog">
        <DialogHeader>
          <DialogTitle>Log in to {agentName}</DialogTitle>
          <DialogDescription>
            This workspace needs a {agentName} login before the agent can work
            in it.
          </DialogDescription>
        </DialogHeader>

        <div className={styles.choices}>
          <Button
            className={styles.startButton}
            disabled={busy !== null}
            onClick={() => void newLogin()}
            data-testid="agent-login-new"
          >
            {busy === "start" ? (
              <Loader2 className={styles.spin} />
            ) : (
              <KeyRound />
            )}
            New login
          </Button>

          {sourceList.length > 0 && (
            <div className={styles.sources}>
              <p className={styles.sourcesLabel}>Copy from my workspace</p>
              <ul
                className={styles.sourceList}
                data-testid="agent-login-sources"
              >
                {sourceList.map((s) => (
                  <li key={s.id}>
                    <Button
                      variant="outline"
                      className={styles.sourceButton}
                      disabled={busy !== null}
                      onClick={() => void copyFrom(s.id, s.name)}
                    >
                      {busy === "copy" ? (
                        <Loader2 className={styles.spin} />
                      ) : (
                        <Copy />
                      )}
                      <span className={styles.truncate}>{s.name}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <p className={styles.errorText} role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={close}
            data-testid="agent-login-not-now"
          >
            Not now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
