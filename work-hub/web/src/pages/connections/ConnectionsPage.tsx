// `#/connections` — the signed-in user's git connections (credential vault, Visual/UX notes →
// Connections page): the table, "+ Add connection" and the Test / Edit / Delete dialogs.

import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";

import { errorMessage } from "../../api/client";
import {
  connectionKeys,
  listConnections,
  listProviders,
  type Connection,
} from "../../api/connections";
import { TopBar } from "../../layout/TopBar";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { AddConnectionDialog } from "./AddConnectionDialog";
import styles from "./ConnectionsPage.module.css";
import { ConnectionsTable } from "./ConnectionsTable";
import { DeleteConnectionDialog } from "./DeleteConnectionDialog";
import dialogStyles from "./dialogs.module.css";
import { EditConnectionDialog } from "./EditConnectionDialog";
import { TestResultView } from "./TestResultView";

export function ConnectionsPage() {
  const [addOpen, setAddOpen] = useState(false);
  // Ids, not rows: the dialogs always show the latest row from the query.
  const [testId, setTestId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: connectionKeys.all,
    queryFn: listConnections,
  });
  const providersQuery = useQuery({
    queryKey: connectionKeys.providers,
    queryFn: listProviders,
    staleTime: Infinity,
  });

  const connections = query.data ?? [];
  const providers = providersQuery.data ?? [];
  const find = (id: string | null): Connection | null =>
    (id && connections.find((c) => c.id === id)) || null;
  const testing = find(testId);

  return (
    <div className={styles.page}>
      <TopBar crumb="Connections" />
      <main className={styles.main}>
        <div className={styles.content}>
          <div className={styles.header}>
            <h1 className={styles.title}>Connections</h1>
            <Button
              onClick={() => setAddOpen(true)}
              disabled={providers.length === 0}
              data-testid="add-connection"
            >
              <Plus />
              Add connection
            </Button>
          </div>

          {query.isPending ? (
            <div className={styles.loading}>
              <Loader2 className={styles.spinner} />
            </div>
          ) : query.isError ? (
            <div className={styles.error}>
              <p className={styles.errorText}>
                {errorMessage(query.error, "Unable to load your connections.")}
              </p>
              <Button variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : connections.length === 0 ? (
            <p className={styles.empty} data-testid="connections-empty">
              No connections yet. Work Hub works fully without them.
            </p>
          ) : (
            <ConnectionsTable
              connections={connections}
              onTest={(c) => setTestId(c.id)}
              onEdit={(c) => setEditId(c.id)}
              onDelete={(c) => setDeleteId(c.id)}
            />
          )}
        </div>
      </main>

      <AddConnectionDialog
        open={addOpen}
        providers={providers}
        onClose={() => setAddOpen(false)}
      />
      <Dialog
        open={testing !== null}
        onOpenChange={(o) => {
          if (!o) setTestId(null);
        }}
      >
        <DialogContent
          className={dialogStyles.dialog}
          data-testid="test-connection-dialog"
        >
          <DialogHeader>
            <DialogTitle>Test {testing?.name}</DialogTitle>
            <DialogDescription>
              Checks that the git host accepts this credential.
            </DialogDescription>
          </DialogHeader>
          {testing && (
            <TestResultView
              key={testing.id}
              connection={testing}
              provider={providers.find((p) => p.id === testing.provider)}
              autoRun
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestId(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <EditConnectionDialog
        connection={find(editId)}
        providers={providers}
        onClose={() => setEditId(null)}
      />
      <DeleteConnectionDialog
        connection={find(deleteId)}
        onClose={() => setDeleteId(null)}
      />
    </div>
  );
}
