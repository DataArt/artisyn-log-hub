// "New workspace" (FR-9, D9; FR-4, D11): a name and where to start from — an empty repository or a
// clone through one of the user's connections — then "Preparing…" (or the clone progress) while
// the server creates the workspace, then the agent login choice for the new workspace.

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
import cloneStyles from "./CloneSource.module.css";
import { AgentLoginDialog } from "../workspace/AgentLoginDialog";
import { CloneProgress } from "./CloneProgress";
import {
  CloneSourceFields,
  EMPTY_SOURCE,
  sourceErrorOf,
  type CloneSourceValue,
  type SourceError,
} from "./CloneSourceFields";
import { StartFromSwitch, newOpId, type StartFrom } from "./StartFromSwitch";

/** Error codes that belong to the name field rather than to the whole dialog. */
const NAME_ERRORS = new Set(["invalid_name", "duplicate_name"]);
/** Error codes shown under the clone source fields. */
const SOURCE_ERRORS = new Set([
  "credential_rejected",
  "invalid_remote_url",
  "remote_error",
  "git_proxy_not_ready",
  "not_found",
]);

export interface NewWorkspaceDialogProps {
  open: boolean;
  /** Called when the dialog is cancelled before a workspace was created. */
  onClose: () => void;
  /** Called once the new workspace's login choice is done (logged in or "Not now"). */
  onDone: (workspace: Workspace) => void;
}

type Phase =
  | { kind: "form" }
  | { kind: "preparing"; opId: string | null }
  | { kind: "failed"; message: string; gitMessage: boolean }
  | { kind: "login"; workspace: Workspace };

export function NewWorkspaceDialog({
  open,
  onClose,
  onDone,
}: NewWorkspaceDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [startFrom, setStartFrom] = useState<StartFrom>("empty");
  const [source, setSource] = useState<CloneSourceValue>(EMPTY_SOURCE);
  const [sourceError, setSourceError] = useState<SourceError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const reset = () => {
    setName("");
    setNameError(null);
    setStartFrom("empty");
    setSource(EMPTY_SOURCE);
    setSourceError(null);
    setNotice(null);
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
      setPhase({ kind: "form" });
      return;
    }
    const cloning = startFrom === "clone";
    if (cloning && (!source.connectionId || !source.url.trim())) {
      setSourceError({
        code: undefined,
        message: "Choose a connection and enter the repository URL.",
      });
      setPhase({ kind: "form" });
      return;
    }
    setNameError(null);
    setSourceError(null);
    setNotice(null);
    const opId = cloning ? newOpId() : null;
    setPhase({ kind: "preparing", opId });
    try {
      const workspace = cloning
        ? await createWorkspace(
            trimmed,
            {
              connectionId: source.connectionId,
              url: source.url.trim(),
              branch: source.branch,
            },
            opId ?? undefined,
          )
        : await createWorkspace(trimmed);
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
      const code = err instanceof ApiError ? err.code : undefined;
      if (code && NAME_ERRORS.has(code)) {
        setNameError(errorMessage(err));
        setPhase({ kind: "form" });
        return;
      }
      if (cloning && code === "clone_cancelled") {
        setNotice(errorMessage(err, "The clone was cancelled."));
        setPhase({ kind: "form" });
        return;
      }
      if (cloning && code && SOURCE_ERRORS.has(code)) {
        setSourceError(sourceErrorOf(err));
        setPhase({ kind: "form" });
        return;
      }
      setPhase({
        kind: "failed",
        message: errorMessage(err),
        gitMessage: code === "clone_failed",
      });
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

  let body;
  if (phase.kind === "preparing") {
    body = phase.opId ? (
      <CloneProgress opId={phase.opId} />
    ) : (
      <div className={styles.preparing} data-testid="new-workspace-preparing">
        <Loader2 className={styles.preparingIcon} />
        Preparing…
      </div>
    );
  } else if (phase.kind === "failed") {
    body = (
      <>
        {phase.gitMessage ? (
          <div
            className={cloneStyles.box}
            role="alert"
            data-testid="clone-failed"
          >
            <span>The repository could not be cloned:</span>
            <pre className={cloneStyles.gitMessage}>{phase.message}</pre>
          </div>
        ) : (
          <p className={styles.errorText} role="alert">
            {phase.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
          {phase.gitMessage && (
            <Button
              variant="outline"
              onClick={() => setPhase({ kind: "form" })}
            >
              Change source
            </Button>
          )}
          <Button onClick={() => void create()}>Try again</Button>
        </DialogFooter>
      </>
    );
  } else {
    body = (
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
        <div className={styles.field}>
          <span className={styles.label}>Start from</span>
          <StartFromSwitch
            value={startFrom}
            onChange={(v) => {
              setStartFrom(v);
              setSourceError(null);
              setNotice(null);
            }}
          />
        </div>
        {startFrom === "clone" && (
          <CloneSourceFields
            value={source}
            onChange={setSource}
            error={sourceError}
            onClearError={() => setSourceError(null)}
          />
        )}
        {notice && (
          <p className={cloneStyles.hint} data-testid="new-workspace-notice">
            {notice}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" data-testid="new-workspace-create">
            Create
          </Button>
        </DialogFooter>
      </form>
    );
  }

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
        data-testid="new-workspace-dialog"
      >
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            {startFrom === "clone"
              ? "The workspace starts from a copy of a remote repository, with Work Hub's default container."
              : "The workspace starts empty, with Work Hub's default container."}
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
