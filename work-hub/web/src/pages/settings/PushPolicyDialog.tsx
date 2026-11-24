// "Push policy…" of a remote card: the two push rules the git proxy enforces for the remote
// (`PATCH /remotes/{id}` with `blockDefaultRewrite` / `onlyWsBranches`). `PolicyFields` is shared
// with AttachRemoteDialog.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage } from "../../api/client";
import { remoteKeys, updateRemote, type Remote } from "../../api/remotes";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import dialogs from "../connections/dialogs.module.css";

export interface Policy {
  blockDefaultRewrite: boolean;
  onlyWsBranches: boolean;
}

/** The card's one-line summary of a remote's policy. */
export function policySummary(p: Policy): string {
  const parts: string[] = [];
  if (p.blockDefaultRewrite) parts.push("force push to default branch blocked");
  if (p.onlyWsBranches) parts.push("only ws/* branches");
  return parts.length > 0 ? parts.join(" · ") : "no push restrictions";
}

export function PolicyFields({
  value,
  onChange,
}: {
  value: Policy;
  onChange: (p: Policy) => void;
}) {
  return (
    <div className={dialogs.field}>
      <span className={dialogs.label}>Push policy</span>
      <label className={dialogs.choice}>
        <input
          type="checkbox"
          checked={value.blockDefaultRewrite}
          onChange={(e) =>
            onChange({ ...value, blockDefaultRewrite: e.target.checked })
          }
          data-testid="remote-policy-block-default"
        />
        Block force push to the default branch
      </label>
      <label className={dialogs.choice}>
        <input
          type="checkbox"
          checked={value.onlyWsBranches}
          onChange={(e) =>
            onChange({ ...value, onlyWsBranches: e.target.checked })
          }
          data-testid="remote-policy-only-ws"
        />
        Only allow pushing Work Hub branches (ws/*)
      </label>
    </div>
  );
}

export interface PushPolicyDialogProps {
  remote: Remote | null;
  onClose: () => void;
}

export function PushPolicyDialog({ remote, onClose }: PushPolicyDialogProps) {
  const queryClient = useQueryClient();
  const [policy, setPolicy] = useState<Policy>({
    blockDefaultRewrite: true,
    onlyWsBranches: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!remote) return;
    setPolicy({
      blockDefaultRewrite: remote.blockDefaultRewrite,
      onlyWsBranches: remote.onlyWsBranches,
    });
    setError(null);
  }, [remote]);

  const save = async () => {
    if (!remote) return;
    setSaving(true);
    setError(null);
    try {
      await updateRemote(remote.id, policy);
      void queryClient.invalidateQueries({
        queryKey: remoteKeys.ofWorkspace(remote.workspaceId),
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={remote !== null}
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
    >
      <DialogContent data-testid="push-policy-dialog">
        <DialogHeader>
          <DialogTitle>Push policy of {remote?.name}</DialogTitle>
          <DialogDescription>
            Work Hub checks every push to this remote against these rules.
          </DialogDescription>
        </DialogHeader>
        <PolicyFields value={policy} onChange={setPolicy} />
        {error && (
          <p className={dialogs.errorText} role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() => void save()}
            data-testid="push-policy-save"
          >
            {saving && <Loader2 className={dialogs.spin} />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
