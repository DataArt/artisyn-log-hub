// "＋ Attach remote" (Visual/UX "Settings → Remotes"): a remote name (default `origin`), one of the
// user's connections — those not granted to this workspace are listed disabled with "Grant…",
// which adds this workspace to the connection's grants — the repository URL and the push policy.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { ApiError, errorMessage } from "../../api/client";
import {
  connectionKeys,
  listConnections,
  setGrants,
  type Connection,
} from "../../api/connections";
import { attachRemote, remoteKeys } from "../../api/remotes";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import dialogs from "../connections/dialogs.module.css";
import { PolicyFields, type Policy } from "./PushPolicyDialog";
import styles from "./Remotes.module.css";

const NAME_ERRORS = new Set(["invalid_remote_name", "duplicate_name"]);
const DEFAULT_POLICY: Policy = {
  blockDefaultRewrite: true,
  onlyWsBranches: false,
};

export interface AttachRemoteDialogProps {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
}

const isGranted = (c: Connection, wsId: string) =>
  c.grants.some((g) => g.workspaceId === wsId);

export function AttachRemoteDialog({
  open,
  workspaceId,
  onClose,
}: AttachRemoteDialogProps) {
  const queryClient = useQueryClient();
  const connections = useQuery({
    queryKey: connectionKeys.all,
    queryFn: listConnections,
    enabled: open,
  });
  const [name, setName] = useState("origin");
  const [connectionId, setConnectionId] = useState("");
  const [url, setUrl] = useState("");
  const [policy, setPolicy] = useState<Policy>(DEFAULT_POLICY);
  const [granting, setGranting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{
    name?: string;
    url?: string;
    form?: string;
  }>({});

  useEffect(() => {
    if (!open) return;
    setName("origin");
    setConnectionId("");
    setUrl("");
    setPolicy(DEFAULT_POLICY);
    setErrors({});
  }, [open]);

  const grant = async (c: Connection) => {
    setGranting(c.id);
    setErrors({});
    try {
      await setGrants(c.id, [
        ...c.grants.map((g) => g.workspaceId),
        workspaceId,
      ]);
      await queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      setConnectionId(c.id);
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setGranting(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // The dialog renders in a portal but React bubbles its submit to the settings form.
    e.stopPropagation();
    if (!connectionId) {
      setErrors({ form: "Choose a connection." });
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      await attachRemote(workspaceId, {
        name: name.trim(),
        connectionId,
        url: url.trim(),
        ...policy,
      });
      void queryClient.invalidateQueries({
        queryKey: remoteKeys.ofWorkspace(workspaceId),
      });
      void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      onClose();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const message = errorMessage(err);
      if (code && NAME_ERRORS.has(code)) setErrors({ name: message });
      else if (code === "invalid_remote_url") setErrors({ url: message });
      else setErrors({ form: message });
    } finally {
      setSaving(false);
    }
  };

  const list = connections.data ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
    >
      <DialogContent
        className={dialogs.dialog}
        data-testid="attach-remote-dialog"
      >
        <DialogHeader>
          <DialogTitle>Attach remote</DialogTitle>
          <DialogDescription>
            The workspace pushes and fetches through Work Hub with the chosen
            connection; the agent never sees its secret.
          </DialogDescription>
        </DialogHeader>
        <form className={dialogs.form} onSubmit={(e) => void submit(e)}>
          <div className={dialogs.field}>
            <label htmlFor="attach-remote-name" className={dialogs.label}>
              Remote name
            </label>
            <Input
              id="attach-remote-name"
              value={name}
              aria-invalid={errors.name !== undefined}
              onChange={(e) => setName(e.target.value)}
              data-testid="attach-remote-name"
            />
            {errors.name && (
              <p className={dialogs.errorText} role="alert">
                {errors.name}
              </p>
            )}
          </div>

          <div className={dialogs.field}>
            <span className={dialogs.label}>Connection</span>
            {connections.isPending ? (
              <Loader2 className={dialogs.spin} />
            ) : connections.isError ? (
              <p className={dialogs.errorText}>
                {errorMessage(connections.error, "Unable to load connections.")}
              </p>
            ) : list.length === 0 ? (
              <p className={dialogs.hint}>
                No connections yet. Add one on the Connections page first.
              </p>
            ) : (
              list.map((c) => {
                const granted = isGranted(c, workspaceId);
                return (
                  <div key={c.id} className={styles.connRow}>
                    <label className={dialogs.choice} data-disabled={!granted}>
                      <input
                        type="radio"
                        name="attach-remote-connection"
                        disabled={!granted}
                        checked={connectionId === c.id}
                        onChange={() => setConnectionId(c.id)}
                        data-testid="attach-remote-connection"
                        data-connection-id={c.id}
                      />
                      {c.name} · {c.providerName}
                    </label>
                    {!granted && (
                      <span className={dialogs.hint}>
                        not granted here ·{" "}
                        <button
                          type="button"
                          className={styles.grantButton}
                          disabled={granting !== null}
                          onClick={() => void grant(c)}
                          data-testid="attach-remote-grant"
                        >
                          {granting === c.id ? "Granting…" : "Grant…"}
                        </button>
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className={dialogs.field}>
            <label htmlFor="attach-remote-url" className={dialogs.label}>
              Repository URL
            </label>
            <Input
              id="attach-remote-url"
              value={url}
              aria-invalid={errors.url !== undefined}
              onChange={(e) => setUrl(e.target.value)}
              data-testid="attach-remote-url"
            />
            {errors.url && (
              <p className={dialogs.errorText} role="alert">
                {errors.url}
              </p>
            )}
          </div>

          <PolicyFields value={policy} onChange={setPolicy} />

          {errors.form && (
            <p className={dialogs.errorText} role="alert">
              {errors.form}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving}
              data-testid="attach-remote-submit"
            >
              {saving && <Loader2 className={dialogs.spin} />}
              Attach
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
