// The switcher row above the tabs (Visual/UX "Switcher row", FR-13): the working branch, one chip
// per open workstream (an amber "Unavailable" chip with "Try again" when its container could not
// be started) and "+ Open workstream".

import { useQueryClient } from "@tanstack/react-query";
import {
  GitBranch,
  Loader2,
  MessageSquare,
  Plus,
  RotateCw,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { errorMessage } from "../../api/client";
import { workspaceKeys, type WorkspaceDetail } from "../../api/workspaces";
import { retryWorkstream, type WorkstreamSummary } from "../../api/workstreams";
import { cn } from "../../lib/cn";
import { routes } from "../../routes";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { OpenWorkstreamDialog } from "./OpenWorkstreamDialog";
import styles from "./WorkstreamSwitcher.module.css";

export interface WorkstreamSwitcherProps {
  workspace: WorkspaceDetail;
  /** The workstream shown, or `null` on the working-branch view. */
  activeStreamId: string | null;
}

const CHIP = styles.chip;

function chipClass(active: boolean): string {
  return cn(CHIP, active ? styles.chipActive : styles.chipInactive);
}

function UnavailableChip({
  workspaceId,
  stream,
  active,
}: {
  workspaceId: string;
  stream: WorkstreamSummary;
  active: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await retryWorkstream(stream.id);
      toast.show(`${stream.name} is available again.`, "success");
    } catch (err) {
      toast.show(
        errorMessage(err, "Its container still could not be started."),
        "error",
      );
    } finally {
      setRetrying(false);
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(workspaceId),
      });
    }
  };

  return (
    <div
      className={cn(
        CHIP,
        styles.chipUnavailable,
        active && styles.chipUnavailableActive,
      )}
      data-testid="switcher-chip-unavailable"
      data-stream-id={stream.id}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={routes.workstream(workspaceId, stream.id)}
            className={styles.chipLink}
          >
            {stream.name} · Unavailable
          </Link>
        </TooltipTrigger>
        <TooltipContent>Its container could not be started.</TooltipContent>
      </Tooltip>
      <Button
        size="xs"
        variant="outline"
        className={styles.retryButton}
        disabled={retrying}
        onClick={() => void retry()}
        data-testid="switcher-try-again"
      >
        {retrying ? <Loader2 className={styles.spin} /> : <RotateCw />}
        Try again
      </Button>
    </div>
  );
}

export function WorkstreamSwitcher({
  workspace,
  activeStreamId,
}: WorkstreamSwitcherProps) {
  const [openDialog, setOpenDialog] = useState(false);

  return (
    <div className={styles.row} data-testid="workstream-switcher">
      <Link
        to={routes.workspace(workspace.id)}
        className={chipClass(activeStreamId === null)}
        aria-current={activeStreamId === null ? "page" : undefined}
        data-testid="switcher-chip-main"
      >
        <GitBranch className={styles.chipIcon} />
        <span className={styles.truncate}>
          {workspace.workingBranch} (working branch)
        </span>
      </Link>

      {workspace.workstreams.map((stream) =>
        stream.available ? (
          <Link
            key={stream.id}
            to={routes.workstream(workspace.id, stream.id)}
            className={chipClass(activeStreamId === stream.id)}
            aria-current={activeStreamId === stream.id ? "page" : undefined}
            data-testid="switcher-chip"
            data-stream-id={stream.id}
          >
            <MessageSquare className={styles.chipIcon} />
            <span className={styles.truncate}>{stream.name}</span>
          </Link>
        ) : (
          <UnavailableChip
            key={stream.id}
            workspaceId={workspace.id}
            stream={stream}
            active={activeStreamId === stream.id}
          />
        ),
      )}

      <Button
        variant="ghost"
        size="sm"
        className={styles.openButton}
        onClick={() => setOpenDialog(true)}
        data-testid="switcher-open-workstream"
      >
        <Plus />
        Open workstream
      </Button>

      <OpenWorkstreamDialog
        open={openDialog}
        workspace={workspace}
        onClose={() => setOpenDialog(false)}
      />
    </div>
  );
}
