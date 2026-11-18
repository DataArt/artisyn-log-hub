// An image file (D12 kind `image`): shown in an `<img>` from a blob URL of the loaded bytes.

import { useEffect, useState } from "react";

import styles from "./ImageTab.module.css";
import { baseName } from "./tree-model";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

function mimeFor(path: string): string {
  const ext = baseName(path).split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}

export interface ImageTabProps {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export function ImageTab({ path, bytes }: ImageTabProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const blobUrl = URL.createObjectURL(
      new Blob([bytes], { type: mimeFor(path) }),
    );
    setUrl(blobUrl);
    return () => URL.revokeObjectURL(blobUrl);
  }, [bytes, path]);

  return (
    <div className={styles.root} data-testid="image-tab">
      {url && <img src={url} alt={baseName(path)} className={styles.image} />}
    </div>
  );
}
