// "Edit" of a connection (Visual/UX notes → Edit dialog): rename, replace the key or token,
// regenerate a generated key, the expose switch (PAT only) and the workspace grants. Provider,
// base URL and auth method are fixed once the connection exists.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError, errorMessage } from "../../api/client";
import {
  connectionKeys,
  updateConnection,
  type Connection,
  type ProviderInfo,
  type UpdateConnectionInput,
} from "../../api/connections";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import styles from "./dialogs.module.css";
import { AUTH_LABEL, fillWeb, isSsh } from "./format";
import { GrantsEditor } from "./GrantsEditor";
import { ExposeSwitch, PatStep, type PatValue } from "./PatStep";
import { RegenerateKey } from "./RegenerateKey";
import { SshKeyStep, type UploadedKey } from "./SshKeyStep";

export interface EditConnectionDialogProps {
  /** The connection to edit; `null` keeps the dialog closed. */
  connection: Connection | null;
  providers: ProviderInfo[];
  onClose: () => void;
}

interface Errors {
  name?: string | null;
  token?: string | null;
  key?: string | null;
  envName?: string | null;
  form?: string | null;
}

function fieldOf(code: string | undefined): keyof Errors {
  if (code === "duplicate_name") return "name";
  if (code === "invalid_env_name" || code === "expose_not_allowed")
    return "envName";
  return "form";
}

function EditForm({
  connection: c,
  provider,
  onClose,
}: {
  connection: Connection;
  provider: ProviderInfo | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const ssh = isSsh(c.authMethod);
  const [name, setName] = useState(c.name);
  const [updating, setUpdating] = useState(false);
  const [key, setKey] = useState<UploadedKey>({ key: "", passphrase: "" });
  const [pat, setPat] = useState<PatValue>({
    username: c.username ?? "",
    token: "",
    expose: c.exposeEnv !== null,
    envName: c.exposeEnv ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });

  const save = async () => {
    const input: UpdateConnectionInput = {};
    const e: Errors = {};
    if (!name.trim()) e.name = "Enter a name.";
    else if (name.trim() !== c.name) input.name = name.trim();
    if (updating && c.authMethod === "ssh_uploaded") {
      if (!key.key.trim()) e.key = "Paste the private key.";
      input.secret = key.key;
      if (key.passphrase) input.passphrase = key.passphrase;
    }
    if (c.authMethod === "pat") {
      if (updating) {
        if (!pat.token.trim()) e.token = "Enter the token.";
        input.secret = pat.token.trim();
        if (provider?.needsUsername && pat.username.trim())
          input.username = pat.username.trim();
      }
      const env = pat.expose ? pat.envName.trim() : null;
      if (pat.expose && !env) e.envName = "Enter the variable name.";
      if (env !== c.exposeEnv) input.exposeEnv = env;
    }
    if (Object.values(e).some(Boolean)) {
      setErrors(e);
      return;
    }
    if (Object.keys(input).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await updateConnection(c.id, input);
      refresh();
      onClose();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setErrors({ [fieldOf(code)]: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void save();
  };

  return (
    <>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.field}>
          <label htmlFor="edit-connection-name" className={styles.label}>
            Name
          </label>
          <Input
            id="edit-connection-name"
            value={name}
            aria-invalid={Boolean(errors.name)}
            onChange={(e) => {
              setName(e.target.value);
              setErrors({});
            }}
            data-testid="edit-connection-name"
          />
          {errors.name && (
            <p className={styles.errorText} role="alert">
              {errors.name}
            </p>
          )}
        </div>

        <div className={styles.section}>
          <p className={styles.sectionTitle}>{AUTH_LABEL[c.authMethod]}</p>
          {c.authMethod === "ssh_generated" && (
            <>
              <SshKeyStep
                mode="generated"
                publicKey={c.publicKey}
                fingerprint={c.keyFingerprint}
                keysPageUrl={fillWeb(
                  provider?.sshKeysPageUrl ?? null,
                  c.baseUrl,
                )}
              />
              <RegenerateKey connectionId={c.id} />
            </>
          )}
          {c.authMethod !== "ssh_generated" && !updating && (
            <div className={styles.row}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setUpdating(true)}
                data-testid="update-secret"
              >
                {c.authMethod === "pat" ? "Update token…" : "Update key…"}
              </Button>
            </div>
          )}
          {updating && c.authMethod === "ssh_uploaded" && (
            <SshKeyStep
              mode="uploaded"
              value={key}
              onChange={(v) => {
                setKey(v);
                setErrors({});
              }}
              error={errors.key}
            />
          )}
          {c.authMethod === "pat" && provider && (
            <PatStep
              provider={provider}
              web={c.baseUrl}
              value={pat}
              onChange={(v) => {
                setPat(v);
                setErrors({});
              }}
              showToken={updating}
              showUsername={updating}
              tokenPlaceholder="New token"
              errors={errors}
            />
          )}
          {ssh && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <ExposeSwitch
                    expose={false}
                    envName=""
                    disabled
                    onChange={() => undefined}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                Only an access token can be exposed to the agent.
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {errors.form && (
          <p className={styles.errorText} role="alert">
            {errors.form}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={busy}
            data-testid="edit-connection-save"
          >
            {busy && <Loader2 className={styles.spin} />}
            Save
          </Button>
        </DialogFooter>
      </form>
      <GrantsEditor connection={c} />
    </>
  );
}

export function EditConnectionDialog({
  connection,
  providers,
  onClose,
}: EditConnectionDialogProps) {
  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className={styles.dialog}
        data-testid="edit-connection-dialog"
      >
        <DialogHeader>
          <DialogTitle>Edit {connection?.name}</DialogTitle>
          <DialogDescription>
            {connection
              ? `${connection.providerName} · ${connection.baseUrl}`
              : null}
          </DialogDescription>
        </DialogHeader>
        {connection && (
          <EditForm
            key={connection.id}
            connection={connection}
            provider={providers.find((p) => p.id === connection.provider)}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
