// "Delete…" on a workspace card (FR-12a, D9 Delete). Cancel changes nothing.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { errorMessage } from "../../api/client";
import {
  deleteWorkspace,
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
import { useToast } from "../../ui/toast";
import styles from "./DeleteWorkspaceDialog.module.css";

export const deleteWorkspaceText = (agentName: string) =>
  `This deletes the workspace's files, its containers and saved setups, its ${agentName} login and the history of all its workstreams.`;

export interface DeleteWorkspaceDialogProps {
  /** The workspace to delete; `null` keeps the dialog closed. */
  workspace: Pick<Workspace, "id" | "name" | "agentName"> | null;
  onClose: () => void;
}

export function DeleteWorkspaceDialog({
  workspace,
  onClose,
}: DeleteWorkspaceDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setError(null);
    onClose();
  };

  const confirm = async () => {
    if (!workspace) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteWorkspace(workspace.id);
      queryClient.removeQueries({
        queryKey: workspaceKeys.detail(workspace.id),
      });
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.all,
        exact: true,
      });
      toast.show(`Deleted ${workspace.name}.`, "success");
      setDeleting(false);
      close();
    } catch (err) {
      setDeleting(false);
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={workspace !== null}
      onOpenChange={(o) => {
        if (!o && !deleting) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="delete-workspace-dialog"
      >
        <DialogHeader>
          <DialogTitle>Delete {workspace?.name}?</DialogTitle>
          <DialogDescription>
            {workspace ? deleteWorkspaceText(workspace.agentName) : null}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className={styles.errorText} role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={deleting} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleting}
            onClick={() => void confirm()}
            data-testid="delete-workspace-confirm"
          >
            {deleting && <Loader2 className={styles.spin} />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
