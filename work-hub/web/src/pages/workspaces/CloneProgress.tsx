// Progress of the clone a "New workspace" request is running (D11): polls `GET /clone-ops/{opId}`
// every 500 ms while the create request is pending. A 404 means the server has not registered
// the op yet ("starting"). Cancel asks the server to stop the clone; the create request then
// answers 409 `clone_cancelled`, which the dialog handles.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError, errorMessage } from "../../api/client";
import {
  cancelCloneOp,
  getCloneOp,
  remoteKeys,
  type CloneOp,
} from "../../api/remotes";
import { Button } from "../../ui/button";
import { DialogFooter } from "../../ui/dialog";
import styles from "./CloneSource.module.css";

const POLL_MS = 500;

/** The op, or `null` while the server has not registered it yet. */
async function pollOp(opId: string): Promise<CloneOp | null> {
  try {
    return await getCloneOp(opId);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) return null;
    throw err;
  }
}

export interface CloneProgressProps {
  opId: string;
}

export function CloneProgress({ opId }: CloneProgressProps) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: remoteKeys.cloneOp(opId),
    queryFn: () => pollOp(opId),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
    gcTime: 0,
  });

  const op = query.data ?? null;
  const percent = op?.percent ?? null;
  const line = op?.line ?? "";

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelCloneOp(opId);
    } catch (err) {
      setCancelling(false);
      setCancelError(errorMessage(err));
    }
  };

  return (
    <div className={styles.progress} data-testid="clone-progress">
      <div className={styles.progressHead}>
        <span>
          {cancelling
            ? "Cancelling…"
            : op
              ? "Cloning the repository…"
              : "Starting…"}
        </span>
        {percent !== null && (
          <span data-testid="clone-progress-percent">{percent}%</span>
        )}
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        {percent !== null ? (
          <div className={styles.bar} style={{ width: `${percent}%` }} />
        ) : (
          <div className={styles.barIndeterminate} />
        )}
      </div>
      <p
        className={styles.lastLine}
        title={line}
        data-testid="clone-progress-line"
      >
        {line}
      </p>
      {cancelError && (
        <p className={styles.errorText} role="alert">
          {cancelError}
        </p>
      )}
      <DialogFooter>
        <Button
          variant="outline"
          disabled={cancelling}
          onClick={() => void cancel()}
          data-testid="clone-cancel"
        >
          Cancel
        </Button>
      </DialogFooter>
    </div>
  );
}
