// A file the IDE does not show (D12 kind `binary`, or text over the editable size).

import { Download, FileQuestion } from "lucide-react";

import { Button } from "../ui/button";
import styles from "./BinaryTab.module.css";
import { triggerDownload } from "./download";
import { baseName } from "./tree-model";

export interface BinaryTabProps {
  path: string;
  /** The file's `…/download` URL. */
  downloadHref: string;
}

export function BinaryTab({ path, downloadHref }: BinaryTabProps) {
  return (
    <div className={styles.root} data-testid="binary-tab">
      <FileQuestion className={styles.icon} />
      <p className={styles.name}>{baseName(path)}</p>
      <p className={styles.muted}>This file can&apos;t be shown here.</p>
      <Button
        variant="outline"
        onClick={() => triggerDownload(downloadHref)}
        data-testid="binary-download"
      >
        <Download />
        Download
      </Button>
    </div>
  );
}
