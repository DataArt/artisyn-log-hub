// Asks before replacing files (D12 `target_exists`): lists the taken names; "Replace" re-sends
// the upload or move with overwrite, "Cancel" does nothing.

import { Loader2 } from "lucide-react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import styles from "./OverwriteDialog.module.css";

export interface OverwriteDialogProps {
  open: boolean;
  /** Repo-relative paths that already exist. */
  paths: string[];
  busy?: boolean;
  onReplace: () => void;
  onCancel: () => void;
}

export function OverwriteDialog({
  open,
  paths,
  busy = false,
  onReplace,
  onCancel,
}: OverwriteDialogProps) {
  const one = paths.length === 1;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} data-testid="overwrite-dialog">
        <DialogHeader>
          <DialogTitle>
            {one ? "Replace the existing file?" : "Replace the existing files?"}
          </DialogTitle>
          <DialogDescription>
            {one
              ? "This name is already taken:"
              : `These ${paths.length} names are already taken:`}
          </DialogDescription>
        </DialogHeader>
        <ul className={styles.paths} data-testid="overwrite-paths">
          {paths.map((p) => (
            <li key={p} className={styles.path} title={p}>
              {p}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={onCancel}
            data-testid="overwrite-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={onReplace}
            data-testid="overwrite-replace"
          >
            {busy && <Loader2 className={styles.spin} />}
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
