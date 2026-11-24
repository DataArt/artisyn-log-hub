// Which of the user's workspaces may use a connection: a checklist saved with
// `PUT /connections/{id}/grants`, which replaces the whole set.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { errorMessage } from "../../api/client";
import {
  connectionKeys,
  setGrants,
  type Connection,
} from "../../api/connections";
import { listWorkspaces, workspaceKeys } from "../../api/workspaces";
import { Button } from "../../ui/button";
import styles from "./dialogs.module.css";

export interface GrantsEditorProps {
  connection: Connection;
  onSaved?: (c: Connection) => void;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function GrantsEditor({ connection, onSaved }: GrantsEditorProps) {
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: workspaceKeys.all,
    queryFn: listWorkspaces,
  });
  const initial = new Set(connection.grants.map((g) => g.workspaceId));
  const [checked, setChecked] = useState<Set<string>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    setChecked(next);
    setError(null);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const c = await setGrants(connection.id, [...checked]);
      void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      setSaved(true);
      onSaved?.(c);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const list = workspaces.data ?? [];

  return (
    <div className={styles.section} data-testid="grants-editor">
      <p className={styles.sectionTitle}>Workspaces that may use it</p>
      {workspaces.isPending ? (
        <Loader2 className={styles.spin} />
      ) : workspaces.isError ? (
        <p className={styles.errorText}>
          {errorMessage(workspaces.error, "Unable to load your workspaces.")}
        </p>
      ) : list.length === 0 ? (
        <p className={styles.hint}>You have no workspaces yet.</p>
      ) : (
        list.map((ws) => (
          <label key={ws.id} className={styles.choice}>
            <input
              type="checkbox"
              checked={checked.has(ws.id)}
              onChange={(e) => toggle(ws.id, e.target.checked)}
              data-testid="grant-workspace"
              data-workspace-id={ws.id}
            />
            {ws.name}
          </label>
        ))
      )}
      {error && (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      )}
      <div className={styles.row}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving || sameSet(checked, initial)}
          onClick={() => void save()}
          data-testid="grants-save"
        >
          {saving && <Loader2 className={styles.spin} />}
          Save access
        </Button>
        {saved && <span className={styles.hint}>Saved.</span>}
      </div>
    </div>
  );
}
