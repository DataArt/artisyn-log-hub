// What the push of a close did (D12, Visual/UX "Close dialog"). The workstream is closed either
// way: a failed push never fails the close.

import { Link } from "react-router-dom";

import type { PushResult } from "../../api/workstreams";
import { routes } from "../../routes";
import styles from "./Push.module.css";

export function PushResultView({ result }: { result: PushResult }) {
  if (result.ok) {
    return (
      <div
        className={styles.result}
        data-tone="ok"
        data-testid="close-push-result"
        data-push-result="ok"
      >
        <p className={styles.title}>
          ✓ Pushed {result.branch} to {result.remote}
        </p>
        {result.prUrl && (
          <a
            href={result.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
            data-testid="close-push-pr"
          >
            Create {result.prLabel ?? "pull request"} ↗
          </a>
        )}
      </div>
    );
  }
  const credential = result.rejectedBy === "credential";
  return (
    <div
      className={styles.result}
      data-tone="bad"
      role="alert"
      data-testid="close-push-result"
      data-push-result={result.rejectedBy ?? "host"}
    >
      <p className={styles.title}>
        {credential
          ? `${result.remote} did not accept the connection's credential`
          : result.rejectedBy === "policy"
            ? "Push rejected by the push policy"
            : "Push rejected"}
      </p>
      {result.message && <pre className={styles.message}>{result.message}</pre>}
      <p>
        The workstream is closed locally; {result.branch} was not pushed to{" "}
        {result.remote}.
      </p>
      {credential && (
        <Link to={routes.connections} className={styles.link}>
          Update key in Connections
        </Link>
      )}
    </div>
  );
}
