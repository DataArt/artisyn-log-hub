// The "Push <branch> to <remote>" choice of the Close dialog (D12, Visual/UX "Close dialog"): a checkbox with
// the remote's connection as a chip, unchecked by default. Nothing renders when the workspace has no
// remote (`pushRemote` is null). "Bring into main" pushes the base branch, "Close for now" the
// workstream's own branch; "Already merged elsewhere" never pushes, so the dialog disables the
// checkbox while that option is hovered or focused.

import type { PushRemote } from "../../api/workstreams";
import styles from "./Push.module.css";

export interface PushOptionProps {
  pushRemote: PushRemote | null;
  /** The branch the aimed-at way to close pushes: the base branch for "Bring into main", the
   *  workstream's branch for "Close for now". */
  branch: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Set when the chosen way to close does not push ("Already merged elsewhere"). */
  disabled?: boolean;
}

export function PushOption({
  pushRemote,
  branch,
  checked,
  onChange,
  disabled = false,
}: PushOptionProps) {
  if (!pushRemote) return null;
  const chip = pushRemote.providerName
    ? `${pushRemote.connectionName} · ${pushRemote.providerName}`
    : pushRemote.connectionName;
  return (
    <div
      className={styles.option}
      data-disabled={disabled}
      data-testid="close-push-option"
    >
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={checked && !disabled}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          data-testid="close-push"
        />
        Push {branch} to {pushRemote.name}
        <span className={styles.chip} data-testid="close-push-connection">
          {chip}
        </span>
      </label>
      <p className={styles.hint}>
        {disabled
          ? "Nothing is pushed when the work was already merged elsewhere."
          : `"Bring into main" pushes the base branch; "Close for now" pushes the workstream's branch. "Already merged elsewhere" does not push.`}
      </p>
    </div>
  );
}
