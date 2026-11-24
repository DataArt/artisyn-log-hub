// The "Start from: Empty repository | Clone from a connection" segmented control of
// "New workspace", plus the client id of a clone op (D11: the client picks the `opId`).

import styles from "./CloneSource.module.css";

export type StartFrom = "empty" | "clone";

const OPTIONS: { value: StartFrom; label: string }[] = [
  { value: "empty", label: "Empty repository" },
  { value: "clone", label: "Clone from a connection" },
];

export function StartFromSwitch({
  value,
  onChange,
}: {
  value: StartFrom;
  onChange: (v: StartFrom) => void;
}) {
  return (
    <div
      className={styles.segmented}
      role="radiogroup"
      aria-label="Start from"
      data-testid="new-workspace-start-from"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={styles.segment}
          onClick={() => onChange(o.value)}
          data-testid={`new-workspace-start-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A random v4 uuid for the clone op. `crypto.randomUUID` exists only in secure contexts (https or
 * localhost), and Work Hub may be opened over plain http on a LAN, so fall back to
 * `getRandomValues`, which is available everywhere.
 */
export function newOpId(): string {
  if (typeof crypto.randomUUID === "function" && window.isSecureContext) {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
