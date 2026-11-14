// "New workspace" (FR-9, D9): a name, then "Preparing…" while the server creates the workspace
// (~3–10 s), then the agent login choice for the new workspace.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError, errorMessage } from "../../api/client";
import {
  createWorkspace,
  workspaceKeys,
  type Workspace,
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
import { Input } from "../../ui/input";
import styles from "./NewWorkspaceDialog.module.css";
import { AgentLoginDialog } from "../workspace/AgentLoginDialog";

/** Error codes that belong to the name field rather than to the whole dialog. */
const NAME_ERRORS = new Set(["invalid_name", "duplicate_name"]);

export interface NewWorkspaceDialogProps {
  open: boolean;
  /** Called when the dialog is cancelled before a workspace was created. */
  onClose: () => void;
  /** Called once the new workspace's login choice is done (logged in or "Not now"). */
  onDone: (workspace: Workspace) => void;
}

type Phase =
  | { kind: "form" }
  | { kind: "preparing" }
  | { kind: "failed"; message: string }
  | { kind: "login"; workspace: Workspace };

export function NewWorkspaceDialog({
  open,
  onClose,
  onDone,
}: NewWorkspaceDialogProps) {
  const queryClient = useQueryClient();
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

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Enter a name.");
      return;
    }
    setNameError(null);
    setPhase({ kind: "preparing" });
    try {
      const workspace = await createWorkspace(trimmed);
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.all,
        exact: true,
      });
      if (workspace.loginState === "ok") {
        reset();
        onDone(workspace);
        return;
      }
      setPhase({ kind: "login", workspace });
    } catch (err) {
      if (err instanceof ApiError && err.code && NAME_ERRORS.has(err.code)) {
        setNameError(errorMessage(err));
        setPhase({ kind: "form" });
        return;
      }
      setPhase({ kind: "failed", message: errorMessage(err) });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create();
  };

  if (phase.kind === "login") {
    const ws = phase.workspace;
    const finish = () => {
      reset();
      onDone(ws);
    };
    return (
      <AgentLoginDialog
        open={open}
        workspaceId={ws.id}
        agentName={ws.agentName}
        onClose={finish}
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
        data-testid="new-workspace-dialog"
      >
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            The workspace starts empty, with Work Hub's default container.
          </DialogDescription>
        </DialogHeader>

        {preparing ? (
          <div
            className={styles.preparing}
            data-testid="new-workspace-preparing"
          >
            <Loader2 className={styles.preparingIcon} />
            Preparing…
          </div>
        ) : phase.kind === "failed" ? (
          <>
            <p className={styles.errorText} role="alert">
              {phase.message}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={cancel}>
                Cancel
              </Button>
              <Button onClick={() => void create()}>Try again</Button>
            </DialogFooter>
          </>
        ) : (
          <form className={styles.form} onSubmit={submit}>
            <div className={styles.field}>
              <label htmlFor="new-workspace-name" className={styles.label}>
                Name
              </label>
              <Input
                id="new-workspace-name"
                autoFocus
                value={name}
                aria-invalid={nameError !== null}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(null);
                }}
                data-testid="new-workspace-name"
              />
              {nameError && (
                <p
                  className={styles.errorText}
                  role="alert"
                  data-testid="new-workspace-name-error"
                >
                  {nameError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancel}>
                Cancel
              </Button>
              <Button type="submit" data-testid="new-workspace-create">
                Create
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
