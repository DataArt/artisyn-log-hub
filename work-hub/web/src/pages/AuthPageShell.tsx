import type { ReactNode } from "react";

import styles from "./AuthPageShell.module.css";

/** The centred layout of the signed-out pages, with the product name above the card. */
export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <p className={styles.product}>Artisyn AI Work Hub</p>
      {children}
    </div>
  );
}
