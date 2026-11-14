// "+ Open workstream" (FR-26, D10): a name, then "Preparing…" while the server copies the
// workspace and starts the workstream's container (~3 s). Without an agent login the server
// answers `login_required` and the agent login choice opens instead; on success the page moves
// to the new workstream with its chat tab in front.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError, errorMessage } from "../../api/client";
import {
  openWorkstream,
  workspaceKeys,
  type WorkspaceDetail,
} from "../../api/workspaces";
import { routes } from "../../routes";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { AgentLoginDialog } from "./AgentLoginDialog";
import styles from "./OpenWorkstreamDialog.module.css";

export interface OpenWorkstreamDialogProps {
  open: boolean;
  workspace: WorkspaceDetail;
  onClose: () => void;
}

type Phase =
  | { kind: "form" }
  | { kind: "preparing" }
  | { kind: "failed"; message: string }
  | { kind: "login" };

export function OpenWorkstreamDialog({
  open,
  workspace,
  onClose,
}: OpenWorkstreamDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const reset = () => {
    setName("");
    setNameError(null);
    setPhase({ kind: "form" });
  };

  const cancel = () => {
    reset();
    onClose();
  };

  const submitName = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Enter a name.");
      return;
    }
    setNameError(null);
    setPhase({ kind: "preparing" });
    try {
      const stream = await openWorkstream(workspace.id, trimmed);
      // Show the new chip at once; the refetch brings the server's view.
      queryClient.setQueryData<WorkspaceDetail>(
        workspaceKeys.detail(workspace.id),
        (old) =>
          old && !old.workstreams.some((s) => s.id === stream.id)
            ? {
                ...old,
                openWorkstreams: old.openWorkstreams + 1,
                workstreams: [...old.workstreams, stream],
              }
            : old,
      );
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
      reset();
      onClose();
      void navigate(routes.workstream(workspace.id, stream.id));
    } catch (err) {
      // A 400 is a name error (`invalid_name` / `duplicate_name`): it belongs to the field.
      if (err instanceof ApiError && err.code === "login_required") {
        setPhase({ kind: "login" });
        return;
      }
      if (err instanceof ApiError && err.statusCode === 400) {
        setNameError(errorMessage(err));
        setPhase({ kind: "form" });
        return;
      }
      setPhase({ kind: "failed", message: errorMessage(err) });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void submitName();
  };

  if (phase.kind === "login") {
    // After the login choice the name is still there; "Open" tries again.
    return (
      <AgentLoginDialog
        open={open}
        workspaceId={workspace.id}
        agentName={workspace.agentName}
        onClose={() => {
          setPhase({ kind: "form" });
          void queryClient.invalidateQueries({
            queryKey: workspaceKeys.detail(workspace.id),
          });
        }}
      />
    );
  }

  const preparing = phase.kind === "preparing";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !preparing) cancel();
      }}
    >
      <DialogContent
        showCloseButton={!preparing}
        onInteractOutside={(e) => {
          if (preparing) e.preventDefault();
        }}
        data-testid="open-workstream-dialog"
      >
        <DialogHeader>
          <DialogTitle>Open workstream</DialogTitle>
          <DialogDescription>
            A workstream is a separate copy of the workspace on{" "}
            {workspace.workingBranch}, with its own agent chat.
          </DialogDescription>
        </DialogHeader>

        {preparing ? (
          <div
            className={styles.preparing}
            data-testid="open-workstream-preparing"
          >
            <Loader2 className={styles.preparingIcon} />
            Preparing…
          </div>
        ) : phase.kind === "failed" ? (
          <>
            <p
              className={styles.errorText}
              role="alert"
              data-testid="open-workstream-error"
            >
              {phase.message}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={cancel}>
                Cancel
              </Button>
              <Button
                onClick={() => void submitName()}
                data-testid="open-workstream-try-again"
              >
                Try again
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form className={styles.form} onSubmit={submit}>
            <div className={styles.field}>
              <label htmlFor="open-workstream-name" className={styles.label}>
                Name
              </label>
              <Input
                id="open-workstream-name"
                autoFocus
                value={name}
                placeholder="What will the agent work on?"
                aria-invalid={nameError !== null}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(null);
                }}
                data-testid="open-workstream-name"
              />
              {nameError && (
                <p
                  className={styles.errorText}
                  role="alert"
                  data-testid="open-workstream-name-error"
                >
                  {nameError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancel}>
                Cancel
              </Button>
              <Button type="submit" data-testid="open-workstream-submit">
                Open
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
