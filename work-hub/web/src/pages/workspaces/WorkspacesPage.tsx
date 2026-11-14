// `#/` — the user's workspaces (FR-9, Visual/UX → Workspaces list).

import { useQuery } from "@tanstack/react-query";
import { FolderGit2, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { errorMessage } from "../../api/client";
import {
  listWorkspaces,
  workspaceKeys,
  type Workspace,
} from "../../api/workspaces";
import { TopBar } from "../../layout/TopBar";
import { routes } from "../../routes";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import styles from "./WorkspacesPage.module.css";
import { DeleteWorkspaceDialog } from "./DeleteWorkspaceDialog";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";

function openWorkstreamsText(n: number): string {
  return `${n} open workstream${n === 1 ? "" : "s"}`;
}

function WorkspaceCard({
  workspace,
  onDelete,
}: {
  workspace: Workspace;
  onDelete: () => void;
}) {
  return (
    <Card
      className={styles.card}
      data-testid="workspace-card"
      data-workspace-id={workspace.id}
    >
      <div className={styles.cardHead}>
        <FolderGit2 className={styles.cardIcon} />
        <div className={styles.cardBody}>
          <p className={styles.cardName} title={workspace.name}>
            {workspace.name}
          </p>
          <p className={styles.cardMeta}>
            {workspace.workingBranch} ·{" "}
            {openWorkstreamsText(workspace.openWorkstreams)}
          </p>
          {workspace.loginState === "missing" && (
            <p className={styles.cardLogin}>
              Needs a {workspace.agentName} login
            </p>
          )}
        </div>
      </div>
      <div className={styles.cardActions}>
        <Button asChild size="sm">
          <Link to={routes.workspace(workspace.id)}>Open</Link>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={styles.deleteButton}
          onClick={onDelete}
          data-testid="workspace-delete"
        >
          <Trash2 />
          Delete…
        </Button>
      </div>
    </Card>
  );
}

export function WorkspacesPage() {
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Workspace | null>(null);

  const query = useQuery({
    queryKey: workspaceKeys.all,
    queryFn: listWorkspaces,
  });

  const workspaces = query.data ?? [];

  return (
    <div className={styles.page}>
      <TopBar crumb="Workspaces" />
      <main className={styles.main}>
        <div className={styles.content}>
          <div className={styles.header}>
            <h1 className={styles.title}>Workspaces</h1>
            <Button
              onClick={() => setNewOpen(true)}
              data-testid="new-workspace"
            >
              <Plus />
              New workspace
            </Button>
          </div>

          {query.isPending ? (
            <div className={styles.loading}>
              <Loader2 className={styles.spinner} />
            </div>
          ) : query.isError ? (
            <div className={styles.error}>
              <p className={styles.errorText}>
                {errorMessage(query.error, "Unable to load your workspaces.")}
              </p>
              <Button variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : workspaces.length === 0 ? (
            <p className={styles.empty} data-testid="workspaces-empty">
              No workspaces yet. Create one to start.
            </p>
          ) : (
            <div className={styles.grid}>
              {workspaces.map((ws) => (
                <WorkspaceCard
                  key={ws.id}
                  workspace={ws}
                  onDelete={() => setToDelete(ws)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <NewWorkspaceDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onDone={(ws) => {
          setNewOpen(false);
          void navigate(routes.workspace(ws.id));
        }}
      />
      <DeleteWorkspaceDialog
        workspace={toDelete}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}
