// "Regenerate key…" of a generated SSH key (D14 Regenerate), with the warning that the git host
// needs the new public key. The pinned host key is kept by the server.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { errorMessage } from "../../api/client";
import { connectionKeys, regenerateKey } from "../../api/connections";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import styles from "./dialogs.module.css";

export function RegenerateKey({ connectionId }: { connectionId: string }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      await regenerateKey(connectionId);
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {confirm ? (
        <div className={cn(styles.box, styles.boxWarn)} role="alert">
          <p>
            The old key stops working. Add the new public key to the git host
            before you use this connection again.
          </p>
          <div className={styles.row}>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void regenerate()}
              data-testid="regenerate-key-confirm"
            >
              {busy && <Loader2 className={styles.spin} />}
              Regenerate key
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.row}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setConfirm(true)}
            data-testid="regenerate-key"
          >
            Regenerate key…
          </Button>
        </div>
      )}
      {error && (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      )}
    </>
  );
}
