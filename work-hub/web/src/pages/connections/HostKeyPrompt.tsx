// "First connection to <host>": shows the scanned SSH host key and lets the user pin it (D14 Test).
// "Trust and pin" hands back the exact fingerprint string shown, which the server compares with
// what it scans again.

import { Loader2 } from "lucide-react";

import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import styles from "./dialogs.module.css";

export interface HostKeyPromptProps {
  /** `true` when the pinned key no longer matches (`host_key_changed`). */
  changed: boolean;
  host: string | null;
  fingerprint: string;
  keyType: string;
  busy: boolean;
  onTrust: (fingerprint: string) => void;
  onCancel: () => void;
}

export function HostKeyPrompt({
  changed,
  host,
  fingerprint,
  keyType,
  busy,
  onTrust,
  onCancel,
}: HostKeyPromptProps) {
  const where = host ?? "the git host";
  return (
    <div
      className={cn(styles.box, changed ? styles.boxBad : styles.boxWarn)}
      role="alert"
      data-testid="host-key-prompt"
    >
      <p className={styles.sectionTitle}>
        {changed
          ? `The host key of ${where} changed`
          : `First connection to ${where}`}
      </p>
      <p>
        {changed
          ? "Check with the host's admin that the new key is expected before you trust it."
          : "Check that this fingerprint matches the one the host publishes."}
      </p>
      <p>
        {keyType}{" "}
        <span className={styles.mono} data-testid="host-key-fingerprint">
          {fingerprint}
        </span>
      </p>
      <div className={styles.row}>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onTrust(fingerprint)}
          data-testid="host-key-trust"
        >
          {busy && <Loader2 className={styles.spin} />}
          Trust and pin
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
