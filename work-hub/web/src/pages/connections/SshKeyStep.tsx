// The SSH part of a connection. A generated key shows its public half with Copy and a link to the
// provider's SSH keys page; an uploaded key takes the private key and its passphrase, which the
// server uses once to strip the key and never stores (D14).

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { copyText } from "../../lib/clipboard";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import styles from "./dialogs.module.css";

export interface UploadedKey {
  key: string;
  passphrase: string;
}

export type SshKeyStepProps =
  | {
      mode: "generated";
      publicKey: string | null;
      fingerprint: string | null;
      /** The provider's SSH keys page with `{web}` filled in. */
      keysPageUrl: string | null;
    }
  | {
      mode: "uploaded";
      value: UploadedKey;
      onChange: (v: UploadedKey) => void;
      error?: string | null;
    };

function GeneratedKey({
  publicKey,
  fingerprint,
  keysPageUrl,
}: {
  publicKey: string | null;
  fingerprint: string | null;
  keysPageUrl: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!publicKey) return;
    const ok = await copyText(publicKey);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className={styles.field}>
      <label htmlFor="connection-public-key" className={styles.label}>
        Public key
      </label>
      <textarea
        id="connection-public-key"
        className={styles.textarea}
        readOnly
        value={publicKey ?? ""}
        onFocus={(e) => e.currentTarget.select()}
        data-testid="connection-public-key"
      />
      {fingerprint && <p className={styles.hint}>{fingerprint}</p>}
      <p className={styles.hint}>
        Add this key to your account on the git host, then run Test.
      </p>
      <div className={styles.row}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!publicKey}
          onClick={() => void copy()}
          data-testid="connection-public-key-copy"
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
        {keysPageUrl && (
          <a
            className={styles.link}
            href={keysPageUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open SSH keys page ↗
          </a>
        )}
      </div>
    </div>
  );
}

export function SshKeyStep(props: SshKeyStepProps) {
  if (props.mode === "generated") {
    return (
      <GeneratedKey
        publicKey={props.publicKey}
        fingerprint={props.fingerprint}
        keysPageUrl={props.keysPageUrl}
      />
    );
  }
  const { value, onChange, error } = props;
  return (
    <>
      <div className={styles.field}>
        <label htmlFor="connection-private-key" className={styles.label}>
          Private key
        </label>
        <textarea
          id="connection-private-key"
          className={styles.textarea}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          spellCheck={false}
          autoComplete="off"
          value={value.key}
          aria-invalid={Boolean(error)}
          onChange={(e) => onChange({ ...value, key: e.target.value })}
          data-testid="connection-private-key"
        />
        {error && (
          <p className={styles.errorText} role="alert">
            {error}
          </p>
        )}
      </div>
      <div className={styles.field}>
        <label htmlFor="connection-passphrase" className={styles.label}>
          Passphrase (if the key has one)
        </label>
        <Input
          id="connection-passphrase"
          type="password"
          autoComplete="off"
          value={value.passphrase}
          onChange={(e) => onChange({ ...value, passphrase: e.target.value })}
          data-testid="connection-passphrase"
        />
        <p className={styles.hint}>
          Used once to unlock the key; Work Hub does not keep it.
        </p>
      </div>
    </>
  );
}
