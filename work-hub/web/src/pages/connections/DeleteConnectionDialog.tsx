// "Delete…" of a connection (D14 Delete). Remotes that use it are listed; deleting then breaks
// them, so the confirm button says so and sends `force=true`. When the server answers 409
// `connection_in_use` (a remote was attached meanwhile) its list is shown and a second click
// confirms.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { ApiError, errorMessage } from "../../api/client";
import {
  connectionKeys,
  deleteConnection,
  type Connection,
} from "../../api/connections";
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
import styles from "./dialogs.module.css";
import { plural } from "./format";

export interface DeleteConnectionDialogProps {
  /** The connection to delete; `null` keeps the dialog closed. */
  connection: Connection | null;
  onClose: () => void;
}

/** `details.workspaces` of a 409 `connection_in_use`, as display names. */
function inUseNames(err: ApiError): string[] {
  const raw = err.details.workspaces;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w: unknown) =>
    typeof w === "object" &&
    w !== null &&
    "name" in w &&
    typeof w.name === "string"
      ? [w.name]
      : [],
  );
}

export function DeleteConnectionDialog({
  connection,
  onClose,
}: DeleteConnectionDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string[] | null>(null);

  const usedBy = connection?.usedBy ?? [];
  const lines =
    conflict ?? usedBy.map((u) => `${u.workspaceName} · ${u.remoteName}`);
  const breaking = lines.length > 0;

  const close = () => {
    setError(null);
    setConflict(null);
    setDeleting(false);
    onClose();
  };

  const confirm = async () => {
    if (!connection) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteConnection(connection.id, breaking);
      queryClient.removeQueries({
        queryKey: connectionKeys.detail(connection.id),
      });
      await queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      toast.show(`Deleted ${connection.name}.`, "success");
      close();
    } catch (err) {
      setDeleting(false);
      if (err instanceof ApiError && err.code === "connection_in_use") {
        setConflict(inUseNames(err));
        return;
      }
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(o) => {
        if (!o && !deleting) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="delete-connection-dialog"
      >
        <DialogHeader>
          <DialogTitle>Delete {connection?.name}?</DialogTitle>
          <DialogDescription>
            Work Hub forgets the credential. Remotes that use this connection
            stay in their workspaces but cannot fetch or push until you rebind
            them.
          </DialogDescription>
        </DialogHeader>
        {breaking && (
          <div data-testid="delete-connection-in-use">
            <p className={styles.label}>
              {conflict ? "Still used in these workspaces:" : "Used by:"}
            </p>
            <ul className={styles.list}>
              {lines.map((l, i) => (
                <li key={`${l}-${i}`}>{l}</li>
              ))}
            </ul>
          </div>
        )}
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
            data-testid="delete-connection-confirm"
          >
            {deleting && <Loader2 className={styles.spin} />}
            {breaking
              ? `Delete and break ${plural(lines.length, "remote")}`
              : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
