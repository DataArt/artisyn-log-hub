// `#/w/:wsId/history` — every workstream of the workspace (FR-33, Visual/UX "History"): name,
// state chip, "added to main", opened and closed dates. The selected row replays its chat
// read-only. "Reopen" and "Discard…" are offered only for a closed workstream: open ones are
// discarded from the close dialog, and a done or discarded one has neither.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { errorMessage } from "../../api/client";
import {
  getWorkspace,
  listWorkstreams,
  workspaceKeys,
} from "../../api/workspaces";
import {
  discardWorkstream,
  reopenWorkstream,
  type WorkstreamState,
  type WorkstreamSummary,
} from "../../api/workstreams";
import { TopBar } from "../../layout/TopBar";
import { cn } from "../../lib/cn";
import { routes } from "../../routes";
import { ReplayView } from "../../terminal/ReplayView";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { useToast } from "../../ui/toast";
import styles from "./HistoryPage.module.css";

const STATE_CHIP: Record<WorkstreamState, string> = {
  open: styles.chipOpen,
  closed: styles.chipClosed,
  done: styles.chipSuccess,
  discarded: styles.chipDiscarded,
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function StateChip({ state }: { state: WorkstreamState }) {
  return (
    <span
      className={cn(styles.chip, styles.chipState, STATE_CHIP[state])}
      data-testid="history-state"
    >
      {state}
    </span>
  );
}

/** The actions of the selected row (above its replay). */
function SelectedActions({
  workspaceId,
  stream,
}: {
  workspaceId: string;
  stream: WorkstreamSummary;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState<"reopen" | "discard" | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
  };

  const reopen = async () => {
    setBusy("reopen");
    try {
      await reopenWorkstream(stream.id);
      refresh();
      void navigate(routes.workstream(workspaceId, stream.id));
    } catch (err) {
      toast.show(errorMessage(err), "error");
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setConfirmDiscard(false);
    setBusy("discard");
    try {
      await discardWorkstream(stream.id);
      toast.show(`${stream.name} was discarded.`, "success");
    } catch (err) {
      toast.show(errorMessage(err), "error");
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <div className={cn(styles.bar, styles.actionsBar)}>
      <span className={styles.selectedName}>{stream.name}</span>
      {stream.state === "open" && (
        <Button asChild size="sm" variant="outline">
          <Link
            to={routes.workstream(workspaceId, stream.id)}
            data-testid="history-go-to-chat"
          >
            Go to the workstream
          </Link>
        </Button>
      )}
      {stream.state === "closed" && (
        <>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void reopen()}
            data-testid="history-reopen"
          >
            {busy === "reopen" ? (
              <Loader2 className={styles.spin} />
            ) : (
              <RotateCcw />
            )}
            Reopen
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={styles.discard}
            disabled={busy !== null}
            onClick={() => setConfirmDiscard(true)}
            data-testid="history-discard"
          >
            {busy === "discard" ? (
              <Loader2 className={styles.spin} />
            ) : (
              <Trash2 />
            )}
            Discard…
          </Button>
        </>
      )}
      <ConfirmDialog
        open={confirmDiscard}
        header="Discard workstream"
        message={`Discard ${stream.name}? Its files and its work are removed and nothing is added to ${stream.baseBranch}. This cannot be undone.`}
        confirmLabel="Discard"
        destructive
        onConfirm={() => void discard()}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}

/** "1.2 GB", "340 MB", "12 KB"; "—" when unknown or nothing is left on disk. */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function HistoryPage() {
  const { wsId = "" } = useParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const workspace = useQuery({
    queryKey: workspaceKeys.detail(wsId),
    queryFn: () => getWorkspace(wsId),
    enabled: wsId !== "",
  });
  const streams = useQuery({
    queryKey: workspaceKeys.workstreams(wsId),
    queryFn: () => listWorkstreams(wsId),
    enabled: wsId !== "",
  });
  // Folder sizes walk the disk, so they come in a separate, slower request.
  const sizes = useQuery({
    queryKey: [...workspaceKeys.workstreams(wsId), "disk"],
    queryFn: () => listWorkstreams(wsId, { disk: true }),
    enabled: wsId !== "",
  });
  const sizeOf = new Map(
    (sizes.data ?? []).map((s) => [s.id, s.diskBytes] as const),
  );

  const rows = [...(streams.data ?? [])].sort((a, b) =>
    b.openedAt.localeCompare(a.openedAt),
  );
  const selected = rows.find((s) => s.id === selectedId) ?? null;

  const crumb = workspace.data ? `${workspace.data.name} › History` : "History";

  return (
    <div className={styles.page}>
      <TopBar crumb={crumb} />

      <div className={cn(styles.bar, styles.headerBar)}>
        <Button asChild variant="ghost" size="sm">
          <Link to={routes.workspace(wsId)} data-testid="history-back">
            <ArrowLeft />
            Back to the workspace
          </Link>
        </Button>
        <h1 className={styles.title}>Workstream history</h1>
      </div>

      {streams.isPending && (
        <div className={styles.centerFill}>
          <Loader2 className={styles.loader} />
        </div>
      )}

      {streams.isError && (
        <div className={styles.errorBox}>
          <p className={styles.errorText}>{errorMessage(streams.error)}</p>
          <Button variant="outline" onClick={() => void streams.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {streams.data && rows.length === 0 && (
        <div className={styles.emptyBox}>
          No workstreams yet. Open one from the workspace.
        </div>
      )}

      {rows.length > 0 && (
        <div className={styles.column}>
          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid="history-table">
              <thead className={styles.thead}>
                <tr>
                  <th className={styles.th}>Name</th>
                  <th className={styles.th}>State</th>
                  <th className={styles.th}>Opened</th>
                  <th className={styles.th}>Closed</th>
                  <th className={cn(styles.th, styles.thSize)}>On disk</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr
                    key={s.id}
                    tabIndex={0}
                    aria-selected={s.id === selectedId}
                    onClick={() => setSelectedId(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(s.id);
                      }
                    }}
                    className={cn(
                      styles.row,
                      s.id === selectedId && styles.rowSelected,
                    )}
                    data-testid="history-row"
                    data-stream-id={s.id}
                    data-state={s.state}
                  >
                    <td className={cn(styles.td, styles.tdName)}>{s.name}</td>
                    <td className={styles.td}>
                      <div className={styles.chips}>
                        <StateChip state={s.state} />
                        {s.mergedAt && (
                          <span
                            className={cn(styles.chip, styles.chipSuccess)}
                            title={formatDate(s.mergedAt)}
                            data-testid="history-added-to-main"
                          >
                            added to main
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={cn(styles.td, styles.tdDate)}>
                      {formatDate(s.openedAt)}
                    </td>
                    <td className={cn(styles.td, styles.tdDate)}>
                      {formatDate(s.closedAt ?? s.discardedAt)}
                    </td>
                    <td
                      className={cn(styles.td, styles.tdSize)}
                      data-testid="history-size"
                    >
                      {formatBytes(sizeOf.get(s.id))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected ? (
            <div className={styles.column}>
              <SelectedActions workspaceId={wsId} stream={selected} />
              <div className={styles.replay}>
                <ReplayView key={selected.id} workstreamId={selected.id} />
              </div>
            </div>
          ) : (
            <div className={styles.emptyBox}>
              Select a workstream to see its chat.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
