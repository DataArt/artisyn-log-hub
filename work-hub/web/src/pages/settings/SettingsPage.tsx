// `#/w/:wsId/settings` — workspace settings (FR-12, D9 Settings): the name (read-only), the
// working branch and what the workspace was started from.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { errorMessage } from "../../api/client";
import {
  getWorkspace,
  logoutAgent,
  setWorkingBranch,
  workspaceKeys,
  type WorkspaceDetail,
} from "../../api/workspaces";
import { TopBar } from "../../layout/TopBar";
import { routes } from "../../routes";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { useToast } from "../../ui/toast";
import styles from "./SettingsPage.module.css";

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <label htmlFor={htmlFor} className={styles.label}>
        {label}
      </label>
      <div className={styles.field}>{children}</div>
    </div>
  );
}

/** The agent login row: its state and "Log out of <agent>" (with a confirmation). */
function AgentLoginRow({ workspace }: { workspace: WorkspaceDetail }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const logout = useMutation({
    mutationFn: () => logoutAgent(workspace.id),
    onSuccess: ({ loggedIn }) => {
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
      toast.show(
        loggedIn
          ? `Still logged in to ${workspace.agentName}.`
          : `Logged out of ${workspace.agentName}.`,
        loggedIn ? "error" : "success",
      );
    },
    onError: (err) => toast.show(errorMessage(err), "error"),
  });
  const loggedIn = workspace.loginState === "ok";
  return (
    <Row label={`${workspace.agentName} login`}>
      <div className={styles.loginRow}>
        <p className={styles.mutedText} data-testid="settings-login-state">
          {loggedIn ? "Logged in" : "Not logged in"}
        </p>
        {loggedIn && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={logout.isPending}
            onClick={() => setConfirming(true)}
            data-testid="settings-logout"
          >
            {logout.isPending && <Loader2 className={styles.spin} />}
            Log out of {workspace.agentName}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        header={`Log out of ${workspace.agentName}?`}
        message={`This workspace forgets its ${workspace.agentName} login. Open workstreams keep their own copy until you close them; new workstreams will ask for a login.`}
        confirmLabel="Log out"
        destructive
        onConfirm={() => {
          setConfirming(false);
          logout.mutate();
        }}
        onCancel={() => setConfirming(false)}
      />
    </Row>
  );
}

function SettingsForm({ workspace }: { workspace: WorkspaceDetail }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [branch, setBranch] = useState(workspace.workingBranch);

  const save = useMutation({
    mutationFn: (workingBranch: string) =>
      setWorkingBranch(workspace.id, workingBranch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
      toast.show("Saved", "success");
    },
  });

  const branches = workspace.branches.includes(workspace.workingBranch)
    ? workspace.branches
    : [workspace.workingBranch, ...workspace.branches];
  const changed = branch !== workspace.workingBranch;

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) save.mutate(branch);
      }}
    >
      <Row label="Name" htmlFor="settings-name">
        <Input
          id="settings-name"
          value={workspace.name}
          readOnly
          className={styles.readOnlyInput}
          data-testid="settings-name"
        />
      </Row>
      <Row label="Working branch" htmlFor="settings-branch">
        <Select
          value={branch}
          onValueChange={(v) => {
            setBranch(v);
            save.reset();
          }}
        >
          <SelectTrigger id="settings-branch" data-testid="settings-branch">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {branches.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Repository">
        <p className={styles.mutedText}>none — started empty</p>
      </Row>
      <Row label="Container">
        <p className={styles.mutedText}>Work Hub default</p>
      </Row>
      <AgentLoginRow workspace={workspace} />

      {save.isError && (
        <p className={styles.errorText} role="alert">
          {errorMessage(save.error)}
        </p>
      )}

      <div className={styles.footer}>
        <Button
          type="submit"
          disabled={!changed || save.isPending}
          data-testid="settings-save"
        >
          {save.isPending && <Loader2 className={styles.spin} />}
          Save
        </Button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const { wsId = "" } = useParams();
  const query = useQuery({
    queryKey: workspaceKeys.detail(wsId),
    queryFn: () => getWorkspace(wsId),
    enabled: wsId !== "",
  });
  const workspace = query.data;

  return (
    <div className={styles.page}>
      <TopBar
        crumb={
          workspace ? (
            <>
              <Link
                to={routes.workspace(workspace.id)}
                className={styles.crumbLink}
              >
                {workspace.name}
              </Link>{" "}
              › Settings
            </>
          ) : (
            "Settings"
          )
        }
      />
      <main className={styles.main}>
        <div className={styles.content}>
          <div className={styles.heading}>
            <Button asChild variant="ghost" size="icon-sm">
              <Link to={routes.workspace(wsId)} aria-label="Back to workspace">
                <ArrowLeft />
              </Link>
            </Button>
            <h1 className={styles.title}>Settings</h1>
          </div>
          {query.isPending ? (
            <div className={styles.loading}>
              <Loader2 className={styles.loader} />
            </div>
          ) : query.isError ? (
            <div className={styles.errorBox}>
              <p className={styles.destructive}>{errorMessage(query.error)}</p>
              <Button variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <SettingsForm
              key={`${query.data.id}:${query.data.workingBranch}`}
              workspace={query.data}
            />
          )}
        </div>
      </main>
    </div>
  );
}
