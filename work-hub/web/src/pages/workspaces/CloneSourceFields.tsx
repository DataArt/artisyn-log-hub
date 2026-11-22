// Clone mode of "New workspace" (FR-4, Visual/UX "New workspace dialog"): one of the user's
// connections, the repository URL (its branches are listed on blur) and the branch to start on.
// A new workspace needs no grant up front: creating it grants the chosen connection to it.

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ApiError, errorMessage } from "../../api/client";
import {
  connectionKeys,
  listBranches,
  listConnections,
  type Branches,
} from "../../api/connections";
import { routes } from "../../routes";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import styles from "./CloneSource.module.css";

export interface CloneSourceValue {
  connectionId: string;
  url: string;
  /** `null`: the remote's default branch. */
  branch: string | null;
}

export const EMPTY_SOURCE: CloneSourceValue = {
  connectionId: "",
  url: "",
  branch: null,
};

/** An error of the source, from the branch listing or from the create request. */
export interface SourceError {
  code: string | undefined;
  message: string;
}

export function sourceErrorOf(err: unknown): SourceError {
  return {
    code: err instanceof ApiError ? err.code : undefined,
    message: errorMessage(err),
  };
}

export interface CloneSourceFieldsProps {
  value: CloneSourceValue;
  onChange: (v: CloneSourceValue) => void;
  /** An error the create request returned for the source (`credential_rejected`, …). */
  error: SourceError | null;
  onClearError: () => void;
}

function CredentialBox({ message }: { message: string }) {
  return (
    <div
      className={styles.box}
      role="alert"
      data-testid="clone-credential-rejected"
    >
      <span>{message}</span>
      <Link to={routes.connections} className={styles.boxLink}>
        Update key in Connections
      </Link>
    </div>
  );
}

export function CloneSourceFields({
  value,
  onChange,
  error,
  onClearError,
}: CloneSourceFieldsProps) {
  const navigate = useNavigate();
  const connections = useQuery({
    queryKey: connectionKeys.all,
    queryFn: listConnections,
  });
  const [branches, setBranches] = useState<Branches | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<SourceError | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** The `connection + url` the branches were last listed for (a blur without a change is a no-op). */
  const listedFor = useRef("");

  const shown = error ?? listError;

  const reset = (next: CloneSourceValue) => {
    setBranches(null);
    setListError(null);
    listedFor.current = "";
    onClearError();
    onChange({ ...next, branch: null });
  };

  const loadBranches = async () => {
    const url = value.url.trim();
    const key = `${value.connectionId}\n${url}`;
    if (!value.connectionId || !url || key === listedFor.current) return;
    listedFor.current = key;
    setLoading(true);
    setListError(null);
    try {
      const b = await listBranches(value.connectionId, url);
      if (listedFor.current !== key) return;
      setBranches(b);
      onChange({
        ...value,
        branch: b.defaultBranch ?? b.branches[0] ?? null,
      });
    } catch (err) {
      if (listedFor.current !== key) return;
      setBranches(null);
      setListError(sourceErrorOf(err));
    } finally {
      setLoading(false);
    }
  };

  const list = connections.data ?? [];
  const branchList = branches?.branches ?? [];

  return (
    <div className={styles.fields} data-testid="clone-source">
      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label htmlFor="clone-connection" className={styles.label}>
            Connection
          </label>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setConfirmLeave(true)}
            data-testid="clone-add-connection"
          >
            Add connection…
          </button>
        </div>
        {connections.isPending ? (
          <Loader2 className={styles.spin} />
        ) : connections.isError ? (
          <p className={styles.errorText}>
            {errorMessage(connections.error, "Unable to load connections.")}
          </p>
        ) : list.length === 0 ? (
          <p className={styles.hint}>
            No connections yet. Add one to clone a repository.
          </p>
        ) : (
          <Select
            value={value.connectionId || undefined}
            onValueChange={(id) => reset({ ...value, connectionId: id })}
          >
            <SelectTrigger id="clone-connection" data-testid="clone-connection">
              <SelectValue placeholder="Choose a connection" />
            </SelectTrigger>
            <SelectContent>
              {list.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} · {c.providerName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className={styles.field}>
        <label htmlFor="clone-url" className={styles.label}>
          Repository URL
        </label>
        <Input
          id="clone-url"
          value={value.url}
          aria-invalid={shown?.code === "invalid_remote_url"}
          onChange={(e) => reset({ ...value, url: e.target.value })}
          onBlur={() => void loadBranches()}
          data-testid="clone-url"
        />
        {shown &&
          (shown.code === "credential_rejected" ? (
            <CredentialBox message={shown.message} />
          ) : (
            <p
              className={styles.errorText}
              role="alert"
              data-testid="clone-source-error"
            >
              {shown.message}
            </p>
          ))}
      </div>

      <div className={styles.field}>
        <label htmlFor="clone-branch" className={styles.label}>
          Branch
        </label>
        {loading ? (
          <p className={styles.hint}>
            <Loader2 className={styles.spin} />
            Reading branches…
          </p>
        ) : branchList.length === 0 ? (
          <p className={styles.hint} data-testid="clone-branch-default">
            {branches
              ? "The repository is empty: the workspace starts on main."
              : "The repository's default branch."}
          </p>
        ) : (
          <Select
            value={value.branch ?? undefined}
            onValueChange={(b) => onChange({ ...value, branch: b })}
          >
            <SelectTrigger id="clone-branch" data-testid="clone-branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {branchList.map((b) => (
                <SelectItem key={b} value={b}>
                  {b === branches?.defaultBranch ? `${b} (default)` : b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <ConfirmDialog
        open={confirmLeave}
        header="Leave this dialog?"
        message="Connections opens in this tab and the new workspace is not created. Come back here once the connection is added."
        confirmLabel="Open Connections"
        onConfirm={() => {
          setConfirmLeave(false);
          void navigate(routes.connections);
        }}
        onCancel={() => setConfirmLeave(false)}
      />
    </div>
  );
}
