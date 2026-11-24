// `#/admin` — the admin resource overview (FR-12, plan D15): one group per user (e-mail,
// workspace count, total) and one row per workspace (branch, open / total workstreams and the
// disk it takes), the grand total and the git cache in a summary line, and "Refresh". Read-only;
// a non-admin sees "Not allowed".

import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { Fragment } from "react";

import {
  adminKeys,
  getAdminOverview,
  type AdminUser,
  type AdminWorkspace,
} from "../../api/admin";
import { ApiError, errorMessage } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { TopBar } from "../../layout/TopBar";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import styles from "./AdminPage.module.css";

/** "1.2 GB", "340 MB", "0 B"; "—" when the size could not be measured. */
function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function WorkspaceRow({ ws }: { ws: AdminWorkspace }) {
  const d = ws.disk;
  return (
    <tr
      className={styles.row}
      data-testid="admin-workspace"
      data-workspace-id={ws.id}
    >
      <td className={cn(styles.td, styles.tdName)}>{ws.name}</td>
      <td className={cn(styles.td, styles.muted)}>{ws.workingBranch}</td>
      <td className={cn(styles.td, styles.num)} data-testid="admin-streams">
        {ws.workstreamsOpen} / {ws.workstreamsTotal}
      </td>
      <td className={cn(styles.td, styles.num)}>{formatBytes(d.filesBytes)}</td>
      <td className={cn(styles.td, styles.num)}>
        {formatBytes(d.containersBytes)}
      </td>
      <td className={cn(styles.td, styles.num)}>
        {formatBytes(d.volumesBytes)}
      </td>
      <td className={cn(styles.td, styles.num)}>
        {formatBytes(d.imagesBytes)}
      </td>
      <td
        className={cn(styles.td, styles.num, styles.strong)}
        data-testid="admin-workspace-total"
        data-bytes={d.totalBytes}
      >
        {formatBytes(d.totalBytes)}
      </td>
    </tr>
  );
}

function UserGroup({ user }: { user: AdminUser }) {
  return (
    <Fragment>
      <tr
        className={styles.userRow}
        data-testid="admin-user"
        data-email={user.email}
      >
        <td className={styles.td} colSpan={7}>
          <span className={styles.strong}>{user.email}</span>
          <span className={styles.muted}>
            {" · "}
            {plural(user.workspaces.length, "workspace")}
          </span>
        </td>
        <td
          className={cn(styles.td, styles.num, styles.strong)}
          data-testid="admin-user-total"
        >
          {formatBytes(user.totalBytes)}
        </td>
      </tr>
      {user.workspaces.map((ws) => (
        <WorkspaceRow key={ws.id} ws={ws} />
      ))}
    </Fragment>
  );
}

export function AdminPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const query = useQuery({
    queryKey: adminKeys.overview,
    queryFn: getAdminOverview,
    enabled: isAdmin,
    // Sizes are measured on load and on "Refresh" only.
    staleTime: Infinity,
    retry: false,
  });
  const forbidden =
    !isAdmin ||
    (query.error instanceof ApiError && query.error.statusCode === 403);
  const data = query.data;

  return (
    <div className={styles.page}>
      <TopBar crumb="Admin" />
      <main className={styles.main}>
        <div className={styles.content}>
          <div className={styles.header}>
            <h1 className={styles.title}>Resource overview</h1>
            {!forbidden && (
              <Button
                variant="outline"
                size="sm"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
                data-testid="admin-refresh"
              >
                {query.isFetching ? (
                  <Loader2 className={styles.spin} />
                ) : (
                  <RefreshCw />
                )}
                Refresh
              </Button>
            )}
          </div>

          {forbidden ? (
            <p className={styles.notice} data-testid="admin-forbidden">
              Not allowed. Only a Work Hub administrator can see this page.
            </p>
          ) : query.isPending ? (
            <div className={styles.loading}>
              <Loader2 className={styles.spinner} />
            </div>
          ) : query.isError ? (
            <p className={cn(styles.notice, styles.error)}>
              {errorMessage(query.error)}
            </p>
          ) : data ? (
            <>
              <p className={styles.summary} data-testid="admin-summary">
                {plural(data.users.length, "user")} · total{" "}
                <span className={styles.strong} data-testid="admin-total">
                  {formatBytes(data.totalBytes)}
                </span>{" "}
                · git cache {formatBytes(data.instance.gitCacheBytes)} ·
                measured {new Date(data.generatedAt).toLocaleString()}
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table} data-testid="admin-table">
                  <thead className={styles.thead}>
                    <tr>
                      <th className={styles.th}>Workspace</th>
                      <th className={styles.th}>Branch</th>
                      <th className={cn(styles.th, styles.num)}>
                        Workstreams (open / total)
                      </th>
                      <th className={cn(styles.th, styles.num)}>Files</th>
                      <th className={cn(styles.th, styles.num)}>Containers</th>
                      <th className={cn(styles.th, styles.num)}>Volumes</th>
                      <th className={cn(styles.th, styles.num)}>Images</th>
                      <th className={cn(styles.th, styles.num)}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((u) => (
                      <UserGroup key={u.id} user={u} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}
