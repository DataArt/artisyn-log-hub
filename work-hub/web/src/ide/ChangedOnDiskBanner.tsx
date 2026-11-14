// Banners above an open file (FR-15, D12): the file changed on disk while the tab has unsaved
// edits, or the file is gone (deleted, or moved by the agent).

import { FileX, Loader2, TriangleAlert } from "lucide-react";

import { Button } from "../ui/button";
import styles from "./ChangedOnDiskBanner.module.css";

export interface ChangedOnDiskBannerProps {
  /** Re-saves the tab's text over the version now on disk. */
  onKeepMine: () => void;
  /** Drops the unsaved edits and loads the file from disk. */
  onTakeTheirs: () => void;
  busy?: boolean;
}

export function ChangedOnDiskBanner({
  onKeepMine,
  onTakeTheirs,
  busy = false,
}: ChangedOnDiskBannerProps) {
  return (
    <div
      role="alert"
      data-testid="changed-on-disk-banner"
      className={styles.banner}
    >
      <TriangleAlert className={styles.icon} />
      <span className={styles.message}>
        Changed by the agent. Your unsaved edits are still here.
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={onKeepMine}
        data-testid="keep-mine"
      >
        {busy && <Loader2 className={styles.spin} />}
        Keep mine
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={onTakeTheirs}
        data-testid="take-theirs"
      >
        Take theirs
      </Button>
    </div>
  );
}

export function DeletedFileBanner({ onCloseTab }: { onCloseTab: () => void }) {
  return (
    <div
      role="alert"
      data-testid="deleted-file-banner"
      className={styles.banner}
    >
      <FileX className={styles.icon} />
      <span className={styles.message}>This file was deleted or moved.</span>
      <Button
        size="sm"
        variant="outline"
        onClick={onCloseTab}
        data-testid="close-deleted-tab"
      >
        Close tab
      </Button>
    </div>
  );
}
