// The table of the Connections page (Visual/UX notes): name / provider, auth, status, grants
// and the row actions.

import type { Connection } from "../../api/connections";
import { Button } from "../../ui/button";
import styles from "./ConnectionsPage.module.css";
import {
  authSummary,
  plural,
  shortDate,
  STATUS_LABEL,
  statusTone,
} from "./format";

export interface ConnectionsTableProps {
  connections: Connection[];
  onTest: (c: Connection) => void;
  onEdit: (c: Connection) => void;
  onDelete: (c: Connection) => void;
}

function StatusCell({ c }: { c: Connection }) {
  const when = shortDate(c.statusAt);
  return (
    <>
      <span className={styles.status} data-testid="connection-status">
        <span className={styles.dot} data-tone={statusTone(c.status)} />
        {STATUS_LABEL[c.status]}
      </span>
      {c.statusDetail && <p className={styles.muted}>{c.statusDetail}</p>}
      {c.status === "ok" && c.statusUser && (
        <p className={styles.muted}>as {c.statusUser}</p>
      )}
      {when && <p className={styles.muted}>{when}</p>}
    </>
  );
}

function GrantsCell({ c, onEdit }: { c: Connection; onEdit: () => void }) {
  if (c.grants.length > 0) {
    return (
      <span title={c.grants.map((g) => g.workspaceName).join(", ")}>
        {plural(c.grants.length, "workspace")}
      </span>
    );
  }
  return (
    <span className={styles.muted}>
      none ·{" "}
      <Button
        variant="link"
        size="xs"
        className={styles.linkButton}
        onClick={onEdit}
        data-testid="connection-grant"
      >
        Grant…
      </Button>
    </span>
  );
}

export function ConnectionsTable({
  connections,
  onTest,
  onEdit,
  onDelete,
}: ConnectionsTableProps) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} data-testid="connections-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Auth</th>
            <th>Status</th>
            <th>Granted to</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {connections.map((c) => (
            <tr
              key={c.id}
              data-testid="connection-row"
              data-connection-id={c.id}
            >
              <td>
                <p className={styles.name}>{c.name}</p>
                <p className={styles.muted}>
                  {c.providerName} · {c.baseUrl}
                </p>
                {c.exposeEnv && (
                  <span
                    className={styles.badge}
                    title={`Exposed as ${c.exposeEnv}`}
                    data-testid="connection-exposed"
                  >
                    👁 Visible to the agent
                  </span>
                )}
              </td>
              <td>
                <span className={styles.mono}>{authSummary(c)}</span>
              </td>
              <td>
                <StatusCell c={c} />
              </td>
              <td>
                <GrantsCell c={c} onEdit={() => onEdit(c)} />
              </td>
              <td>
                <div className={styles.actions}>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onTest(c)}
                    data-testid="connection-test"
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onEdit(c)}
                    data-testid="connection-edit"
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onDelete(c)}
                    data-testid="connection-delete"
                  >
                    Delete…
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
