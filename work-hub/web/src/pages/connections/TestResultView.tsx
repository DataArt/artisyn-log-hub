// Test of a connection (D14 Test): an optional repository URL (when the provider's Test needs
// one), the Test button, the host-key prompt and the outcome. Used by the Add dialog after the
// connection exists and by the table's "Test" action.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { errorMessage } from "../../api/client";
import {
  connectionKeys,
  testConnection,
  type Connection,
  type ProviderInfo,
  type TestResult,
} from "../../api/connections";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import styles from "./dialogs.module.css";
import { hostOf } from "./format";
import { HostKeyPrompt } from "./HostKeyPrompt";

export interface TestResultViewProps {
  connection: Connection;
  provider: ProviderInfo | undefined;
  /** Run the test once on mount (only when no URL is needed). */
  autoRun?: boolean;
}

function Outcome({ result }: { result: TestResult }) {
  if (result.result === "ok") {
    return (
      <p
        className={cn(styles.box, styles.boxOk)}
        data-testid="connection-test-ok"
      >
        ✓ Test passed
        {result.user ? ` · authenticated as ${result.user}` : ""}
      </p>
    );
  }
  if (result.result === "rejected" || result.result === "failed") {
    return (
      <div
        className={cn(styles.box, styles.boxBad)}
        role="alert"
        data-testid="connection-test-failed"
      >
        <p className={styles.sectionTitle}>
          {result.result === "rejected"
            ? "Rejected by the host"
            : "Test failed"}
        </p>
        {result.message && <p className={styles.mono}>{result.message}</p>}
      </div>
    );
  }
  return null;
}

export function TestResultView({
  connection,
  provider,
  autoRun = false,
}: TestResultViewProps) {
  const queryClient = useQueryClient();
  const needsUrl = provider?.testNeedsUrl ?? false;
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const run = async (acceptHostKey?: string) => {
    const typed = url.trim();
    if (needsUrl && !typed) {
      setError("Enter a repository URL to test with.");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const r = await testConnection(connection.id, {
        ...(typed ? { url: typed } : {}),
        ...(acceptHostKey ? { acceptHostKey } : {}),
      });
      setResult(r);
      void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (!autoRun || needsUrl || started.current) return;
    started.current = true;
    void run();
    // Runs once on mount; `run` reads the latest state when called later.
  }, [autoRun, needsUrl]);

  const hostKey =
    result &&
    (result.result === "host_key_unknown" ||
      result.result === "host_key_changed") &&
    result.hostKey
      ? result.hostKey
      : null;

  return (
    <div className={styles.form} data-testid="connection-test">
      {needsUrl && (
        <div className={styles.field}>
          <label htmlFor="connection-test-url" className={styles.label}>
            Repository URL to test with
          </label>
          <Input
            id="connection-test-url"
            value={url}
            placeholder={provider?.baseUrlPlaceholder}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            data-testid="connection-test-url"
          />
        </div>
      )}
      <div className={styles.row}>
        <Button
          variant="outline"
          disabled={running}
          onClick={() => void run()}
          data-testid="connection-test-run"
        >
          {running && <Loader2 className={styles.spin} />}
          Test
        </Button>
      </div>
      {error && (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      )}
      {hostKey && result ? (
        <HostKeyPrompt
          changed={result.result === "host_key_changed"}
          host={hostOf(url) ?? hostOf(connection.baseUrl)}
          fingerprint={hostKey.fingerprint}
          keyType={hostKey.keyType}
          busy={running}
          onTrust={(fp) => void run(fp)}
          onCancel={() => setResult(null)}
        />
      ) : (
        result && <Outcome result={result} />
      )}
    </div>
  );
}
