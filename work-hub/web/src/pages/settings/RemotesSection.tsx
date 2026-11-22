// Settings → Remotes (Visual/UX "Settings → Remotes"): one card per git remote of the workspace —
// name, connection, status, URL, auth and push policy — with Test, Push policy… and Detach…, and
// "＋ Attach remote". It sits inside the settings form, so every button here is `type="button"`.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";

import { errorMessage } from "../../api/client";
import {
  connectionKeys,
  listConnections,
  type Connection,
  type TestResult,
} from "../../api/connections";
import {
  detachRemote,
  listRemotes,
  remoteKeys,
  testRemote,
  type Remote,
} from "../../api/remotes";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { useToast } from "../../ui/toast";
import { STATUS_LABEL, authSummary, statusTone } from "../connections/format";
import { AttachRemoteDialog } from "./AttachRemoteDialog";
import { PushPolicyDialog, policySummary } from "./PushPolicyDialog";
import styles from "./Remotes.module.css";

type TestState =
  | { kind: "running" }
  | { kind: "done"; result: TestResult }
  | { kind: "error"; message: string };

function testText(r: TestResult): string {
  switch (r.result) {
    case "ok":
      return `✓ Reachable${r.user ? ` · authenticated as ${r.user}` : ""}`;
    case "rejected":
      return `Rejected by the host${r.message ? `: ${r.message}` : ""}`;
    case "host_key_unknown":
    case "host_key_changed":
      return "The host key needs checking: test the connection on the Connections page.";
    case "failed":
      return `Test failed${r.message ? `: ${r.message}` : ""}`;
  }
}

function RemoteCard({
  remote,
  connection,
  test,
  onTest,
  onPolicy,
  onDetach,
}: {
  remote: Remote;
  connection: Connection | undefined;
  test: TestState | undefined;
  onTest: () => void;
  onPolicy: () => void;
  onDetach: () => void;
}) {
  return (
    <div
      className={styles.card}
      data-testid="remote-card"
      data-remote-name={remote.name}
    >
      <div className={styles.cardHead}>
        <span>
          <span className={styles.name}>{remote.name}</span>
          {" · "}
          {remote.connectionId ? remote.connectionName : "connection deleted"}
        </span>
        <span className={styles.status} data-testid="remote-status">
          <span className={styles.dot} data-tone={statusTone(remote.status)} />
          {STATUS_LABEL[remote.status]}
        </span>
      </div>
      <p className={styles.url}>{remote.url}</p>
      {connection && <p className={styles.muted}>{authSummary(connection)}</p>}
      <p className={styles.muted} data-testid="remote-policy">
        {policySummary(remote)}
      </p>
      {remote.statusDetail && (
        <p className={styles.muted}>{remote.statusDetail}</p>
      )}
      {test && test.kind !== "running" && (
        <p
          className={styles.result}
          data-tone={
            test.kind === "done" && test.result.result === "ok" ? "ok" : "bad"
          }
          data-testid="remote-test-result"
        >
          {test.kind === "done" ? testText(test.result) : test.message}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={test?.kind === "running"}
          onClick={onTest}
          data-testid="remote-test"
        >
          {test?.kind === "running" && <Loader2 className={styles.spin} />}
          Test
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onPolicy}
          data-testid="remote-policy-edit"
        >
          Push policy…
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDetach}
          data-testid="remote-detach"
        >
          Detach…
        </Button>
      </div>
    </div>
  );
}

export function RemotesSection({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const remotes = useQuery({
    queryKey: remoteKeys.ofWorkspace(workspaceId),
    queryFn: () => listRemotes(workspaceId),
  });
  const connections = useQuery({
    queryKey: connectionKeys.all,
    queryFn: listConnections,
  });
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [attaching, setAttaching] = useState(false);
  const [policyOf, setPolicyOf] = useState<Remote | null>(null);
  const [detachOf, setDetachOf] = useState<Remote | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: remoteKeys.ofWorkspace(workspaceId),
    });
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
  };

  const runTest = async (r: Remote) => {
    setTests((t) => ({ ...t, [r.id]: { kind: "running" } }));
    let next: TestState;
    try {
      next = { kind: "done", result: await testRemote(r.id) };
      refresh();
    } catch (err) {
      next = { kind: "error", message: errorMessage(err) };
    }
    setTests((t) => ({ ...t, [r.id]: next }));
  };

  const detach = async (r: Remote) => {
    setDetachOf(null);
    try {
      await detachRemote(r.id);
      refresh();
      toast.show(`Detached ${r.name}.`, "success");
    } catch (err) {
      toast.show(errorMessage(err), "error");
    }
  };

  const byId = new Map((connections.data ?? []).map((c) => [c.id, c]));

  return (
    <div className={styles.section} data-testid="settings-remotes">
      {remotes.isPending ? (
        <Loader2 className={styles.spin} />
      ) : remotes.isError ? (
        <p className={styles.muted}>
          {errorMessage(remotes.error, "Unable to load the remotes.")}
        </p>
      ) : remotes.data.length === 0 ? (
        <p className={styles.muted} data-testid="remotes-empty">
          none — this workspace has no remote repository
        </p>
      ) : (
        remotes.data.map((r) => (
          <RemoteCard
            key={r.id}
            remote={r}
            connection={r.connectionId ? byId.get(r.connectionId) : undefined}
            test={tests[r.id]}
            onTest={() => void runTest(r)}
            onPolicy={() => setPolicyOf(r)}
            onDetach={() => setDetachOf(r)}
          />
        ))
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setAttaching(true)}
          data-testid="remote-attach"
        >
          <Plus />
          Attach remote
        </Button>
      </div>

      <AttachRemoteDialog
        open={attaching}
        workspaceId={workspaceId}
        onClose={() => setAttaching(false)}
      />
      <PushPolicyDialog remote={policyOf} onClose={() => setPolicyOf(null)} />
      <ConfirmDialog
        open={detachOf !== null}
        header={`Detach ${detachOf?.name ?? "remote"}?`}
        message="The workspace and its workstreams stop pushing to and fetching from this remote. The remote repository itself is not changed."
        confirmLabel="Detach"
        destructive
        onConfirm={() => {
          if (detachOf) void detach(detachOf);
        }}
        onCancel={() => setDetachOf(null)}
      />
    </div>
  );
}
