// What the workstream route shows instead of the IDE when the workstream cannot be used: it is
// not open (closed, done, discarded or unknown), or its container could not be started
// ("Unavailable", AC-3a).

import { useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { errorMessage } from "../../api/client";
import { workspaceKeys } from "../../api/workspaces";
import { retryWorkstream, type WorkstreamSummary } from "../../api/workstreams";
import { routes } from "../../routes";
import { Button } from "../../ui/button";
import styles from "./WorkstreamNotice.module.css";

export interface WorkstreamNoticeProps {
  workspaceId: string;
  /** The open workstream of the route, `undefined` when it is not open. */
  stream: WorkstreamSummary | undefined;
  /** The workspace is being reloaded (the workstream may just have opened). */
  refetching: boolean;
}

export function WorkstreamNotice({
  workspaceId,
  stream,
  refetching,
}: WorkstreamNoticeProps) {
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (stream === undefined && refetching) {
    return (
      <div className={styles.loading}>
        <Loader2 className={styles.spinner} />
      </div>
    );
  }

  const retry = async (id: string) => {
    setRetrying(true);
    setError(null);
    try {
      await retryWorkstream(id);
    } catch (err) {
      setError(errorMessage(err, "Its container still could not be started."));
    } finally {
      setRetrying(false);
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(workspaceId),
      });
    }
  };

  return (
    <div
      className={styles.notice}
      data-testid={
        stream === undefined ? "workstream-not-open" : "workstream-unavailable"
      }
    >
      {stream === undefined ? (
        <>
          <p className={styles.muted}>This workstream is not open.</p>
          <div className={styles.actions}>
            <Button asChild variant="outline">
              <Link to={routes.history(workspaceId)}>Open History</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link to={routes.workspace(workspaceId)}>
                Back to the working branch
              </Link>
            </Button>
          </div>
        </>
      ) : (
        <>
          <TriangleAlert className={styles.warningIcon} />
          <p className={styles.name}>{stream.name} · Unavailable</p>
          <p className={styles.muted}>Its container could not be started.</p>
          {error && (
            <p className={styles.errorText} role="alert">
              {error}
            </p>
          )}
          <Button
            disabled={retrying}
            onClick={() => void retry(stream.id)}
            data-testid="workstream-try-again"
          >
            {retrying ? <Loader2 className={styles.spin} /> : <RotateCw />}
            Try again
          </Button>
        </>
      )}
    </div>
  );
}
