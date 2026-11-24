// "+ Add connection" (Visual/UX notes → Add dialog). The form step picks the provider, base URL,
// name and auth method plus the secret; Save creates the connection. A generated key is made by
// the server on create, so its public key and the Test step show only after that. A token or an
// uploaded key runs Test right away.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError, errorMessage } from "../../api/client";
import {
  connectionKeys,
  createConnection,
  type Connection,
  type CreateConnectionInput,
  type ProviderInfo,
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
import styles from "./dialogs.module.css";
import { fillWeb, normalizeBase, webOf } from "./format";
import { PatStep, type PatValue } from "./PatStep";
import { ProviderStep, type ProviderChoice } from "./ProviderStep";
import { SshKeyStep, type UploadedKey } from "./SshKeyStep";
import { TestResultView } from "./TestResultView";

export interface AddConnectionDialogProps {
  open: boolean;
  providers: ProviderInfo[];
  onClose: () => void;
}

interface Errors {
  baseUrl?: string | null;
  name?: string | null;
  token?: string | null;
  key?: string | null;
  envName?: string | null;
  form?: string | null;
}

const EMPTY_CHOICE: ProviderChoice = {
  providerId: null,
  baseUrl: "",
  name: "",
  authMethod: null,
};
const EMPTY_PAT: PatValue = {
  username: "",
  token: "",
  expose: false,
  envName: "",
};
const EMPTY_KEY: UploadedKey = { key: "", passphrase: "" };

/** Server error code → the field it belongs to. */
function fieldOf(code: string | undefined): keyof Errors {
  if (code === "duplicate_name") return "name";
  if (code === "invalid_env_name" || code === "expose_not_allowed")
    return "envName";
  return "form";
}

export function AddConnectionDialog({
  open,
  providers,
  onClose,
}: AddConnectionDialogProps) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<ProviderChoice>(EMPTY_CHOICE);
  const [pat, setPat] = useState<PatValue>(EMPTY_PAT);
  const [key, setKey] = useState<UploadedKey>(EMPTY_KEY);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Connection | null>(null);

  const provider = providers.find((p) => p.id === choice.providerId);
  const web = provider ? webOf(provider, choice.baseUrl) : "";

  const close = () => {
    setChoice(EMPTY_CHOICE);
    setPat(EMPTY_PAT);
    setKey(EMPTY_KEY);
    setErrors({});
    setSaving(false);
    setCreated(null);
    onClose();
  };

  const validate = (): Errors => {
    const e: Errors = {};
    if (!provider) e.form = "Choose a provider.";
    if (provider && !provider.baseUrlFixed && !normalizeBase(choice.baseUrl))
      e.baseUrl = "Enter the server URL.";
    if (!choice.name.trim()) e.name = "Enter a name.";
    if (choice.authMethod === "pat") {
      if (!pat.token.trim()) e.token = "Enter the token.";
      if (pat.expose && !pat.envName.trim())
        e.envName = "Enter the variable name.";
    }
    if (choice.authMethod === "ssh_uploaded" && !key.key.trim())
      e.key = "Paste the private key.";
    return e;
  };

  const save = async () => {
    const e = validate();
    if (Object.values(e).some(Boolean)) {
      setErrors(e);
      return;
    }
    if (!provider || !choice.authMethod) return;
    const input: CreateConnectionInput = {
      name: choice.name.trim(),
      provider: provider.id,
      authMethod: choice.authMethod,
      ...(provider.baseUrlFixed
        ? {}
        : { baseUrl: normalizeBase(choice.baseUrl) }),
    };
    if (choice.authMethod === "pat") {
      input.secret = pat.token.trim();
      if (provider.needsUsername && pat.username.trim())
        input.username = pat.username.trim();
      if (pat.expose) input.exposeEnv = pat.envName.trim();
    } else if (choice.authMethod === "ssh_uploaded") {
      input.secret = key.key;
      if (key.passphrase) input.passphrase = key.passphrase;
    }
    setErrors({});
    setSaving(true);
    try {
      const conn = await createConnection(input);
      void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      setCreated(conn);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setErrors({ [fieldOf(code)]: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void save();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !saving) close();
      }}
    >
      <DialogContent
        className={styles.dialog}
        showCloseButton={!saving}
        data-testid="add-connection-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {created ? `Connection ${created.name}` : "Add connection"}
          </DialogTitle>
          <DialogDescription>
            {created
              ? created.authMethod === "ssh_generated"
                ? "Add the public key to the git host, then test the connection."
                : "Saved. Testing the connection with the git host."
              : "Work Hub keeps the credential; containers never see it."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className={styles.form}>
            {created.authMethod === "ssh_generated" && (
              <SshKeyStep
                mode="generated"
                publicKey={created.publicKey}
                fingerprint={created.keyFingerprint}
                keysPageUrl={fillWeb(
                  provider?.sshKeysPageUrl ?? null,
                  created.baseUrl,
                )}
              />
            )}
            <TestResultView
              connection={created}
              provider={provider}
              autoRun={created.authMethod !== "ssh_generated"}
            />
            <DialogFooter>
              <Button onClick={close} data-testid="add-connection-done">
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form className={styles.form} onSubmit={submit}>
            <ProviderStep
              providers={providers}
              value={choice}
              onChange={(v) => {
                setChoice(v);
                setErrors({});
              }}
              errors={errors}
            />
            {provider && choice.authMethod === "ssh_uploaded" && (
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
            {provider && choice.authMethod === "pat" && (
              <PatStep
                provider={provider}
                web={web}
                value={pat}
                onChange={(v) => {
                  setPat(v);
                  setErrors({});
                }}
                errors={errors}
              />
            )}
            {errors.form && (
              <p className={styles.errorText} role="alert">
                {errors.form}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving || !provider}
                data-testid="add-connection-save"
              >
                {saving && <Loader2 className={styles.spin} />}
                {choice.authMethod === "ssh_generated"
                  ? "Generate key"
                  : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
