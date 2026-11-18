// The Configure service tab (FR-25a/b, D11): the agent sets up the workspace container in a
// terminal; "Finish configuration" saves the container as the next checkpoint.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, errorMessage } from "../../api/client";
import {
  configureSocketPath,
  finishConfigure,
  startConfigure,
  workspaceKeys,
} from "../../api/workspaces";
import { TerminalView } from "../../terminal/TerminalView";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import styles from "./ConfigureTab.module.css";

export interface ConfigureTabProps {
  workspaceId: string;
  /** Closes the service tab. */
  onClose: () => void;
}

type Phase =
  | { kind: "starting" }
  /** `notice`: a plain message shown above the terminal (e.g. `configure_running`). */
  | { kind: "running"; notice?: string }
  /** The session could not start (e.g. `login_required`): message only, no terminal. */
  | { kind: "blocked"; message: string };

export function ConfigureTab({ workspaceId, onClose }: ConfigureTabProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [finishing, setFinishing] = useState(false);
  const finishingRef = useRef(false);
  const startedForRef = useRef<string | null>(null);
  const closedRef = useRef(false);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.detail(workspaceId),
    });
  }, [queryClient, workspaceId]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    // Once per workspace, also under StrictMode's double effect run.
    if (startedForRef.current === workspaceId) return;
    startedForRef.current = workspaceId;
    setPhase({ kind: "starting" });
    void (async () => {
      try {
        await startConfigure(workspaceId);
        setPhase({ kind: "running" });
      } catch (err) {
        if (err instanceof ApiError && err.code === "configure_running") {
          // A configuration is already running (another tab, or a reload): attach to it.
          setPhase({ kind: "running", notice: errorMessage(err) });
        } else {
          setPhase({
            kind: "blocked",
            message: errorMessage(
              err,
              "The configuration could not be started. Please try again.",
            ),
          });
        }
      }
      refresh();
    })();
  }, [workspaceId, refresh]);

  const finish = async () => {
    finishingRef.current = true;
    setFinishing(true);
    toast.show("Saving the container setup…", "info");
    try {
      await finishConfigure(workspaceId);
      toast.show("Saved", "success");
      refresh();
      close();
    } catch (err) {
      toast.show(errorMessage(err), "error");
      finishingRef.current = false;
      setFinishing(false);
    }
  };

  const handleEnded = useCallback(() => {
    // Ended by "Finish configuration": the finish call closes the tab when it returns.
    if (finishingRef.current) return;
    toast.show(
      "The configuration finished and the container setup was saved.",
      "success",
    );
    refresh();
    close();
  }, [toast, refresh, close]);

  return (
    <div className={styles.tab} data-testid="configure-tab">
      <div className={styles.bar}>
        <span className={styles.barText}>
          {phase.kind === "blocked"
            ? phase.message
            : phase.kind === "running" && phase.notice
              ? phase.notice
              : "Ask the agent to install what this project needs. Finish when it is done."}
        </span>
        {phase.kind === "blocked" ? (
          <Button size="sm" variant="outline" onClick={close}>
            Close
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={phase.kind !== "running" || finishing}
            onClick={() => void finish()}
          >
            {finishing && <Loader2 className={styles.spin} />}
            Finish configuration
          </Button>
        )}
      </div>
      <div className={styles.body}>
        {phase.kind === "starting" && (
          <div className={styles.starting}>
            <Loader2 className={styles.startingIcon} />
            Starting…
          </div>
        )}
        {phase.kind === "running" && (
          <TerminalView
            wsPath={configureSocketPath(workspaceId)}
            onEnded={handleEnded}
            takenOverText="This configuration was opened in another tab"
          />
        )}
      </div>
    </div>
  );
}
