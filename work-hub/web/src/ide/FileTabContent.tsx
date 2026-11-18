// The body of a file tab: loads the file once and shows it by its kind (D12) — text in
// `EditorTab` (HTML and SVG too, as code, never rendered), images in `ImageTab`, anything else in
// `BinaryTab`. A file the poll reports as gone gets the deleted-file banner.

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "../api/client";
import { downloadUrl, readFile, type FileContent } from "../api/fs";
import { Button } from "../ui/button";
import { BinaryTab } from "./BinaryTab";
import { DeletedFileBanner } from "./ChangedOnDiskBanner";
import { decodeText, EditorTab } from "./EditorTab";
import styles from "./FileTabContent.module.css";
import { ImageTab } from "./ImageTab";

export interface FileTabContentProps {
  workspaceId: string;
  view: string;
  path: string;
  /** The version the poll last saw (`undefined` before the first poll, `null` = gone). */
  diskVersion: string | null | undefined;
  onDirtyChange: (dirty: boolean) => void;
  onLocalChange: () => void;
  onCloseTab: () => void;
}

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; content: FileContent; text: string | null };

export function FileTabContent({
  workspaceId,
  view,
  path,
  diskVersion,
  onDirtyChange,
  onLocalChange,
  onCloseTab,
}: FileTabContentProps) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const pathRef = useRef(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  const fetchContent = useCallback(async () => {
    try {
      const content = await readFile(workspaceId, view, pathRef.current);
      setLoad({
        status: "ok",
        content,
        text: content.kind === "text" ? decodeText(content.bytes) : null,
      });
    } catch (err) {
      setLoad({
        status: "error",
        message: errorMessage(err, "The file could not be opened."),
      });
    }
  }, [workspaceId, view]);

  // Loaded once per tab; a move re-points `path` without reloading.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void fetchContent();
  }, [fetchContent]);

  // Images and other files have no unsaved state: a new version on disk just reloads them.
  const loadedVersion =
    load.status === "ok" && load.content.kind !== "text"
      ? load.content.version
      : null;
  useEffect(() => {
    if (
      loadedVersion !== null &&
      typeof diskVersion === "string" &&
      diskVersion !== loadedVersion
    ) {
      void fetchContent();
    }
  }, [diskVersion, loadedVersion, fetchContent]);

  const gone = diskVersion === null;

  return (
    <div className={styles.root}>
      {gone && <DeletedFileBanner onCloseTab={onCloseTab} />}
      <div className={styles.body}>
        {load.status === "loading" && (
          <div className={styles.center}>
            <Loader2 className={styles.loader} />
          </div>
        )}
        {load.status === "error" && (
          <div className={styles.error}>
            <p className={styles.errorText}>{load.message}</p>
            <Button
              variant="outline"
              onClick={() => {
                setLoad({ status: "loading" });
                void fetchContent();
              }}
            >
              Try again
            </Button>
          </div>
        )}
        {load.status === "ok" && load.text !== null && (
          <EditorTab
            workspaceId={workspaceId}
            view={view}
            path={path}
            initialText={load.text}
            initialVersion={load.content.version}
            diskVersion={diskVersion}
            onDirtyChange={onDirtyChange}
            onLocalChange={onLocalChange}
          />
        )}
        {load.status === "ok" && load.content.kind === "image" && (
          <ImageTab path={path} bytes={load.content.bytes} />
        )}
        {load.status === "ok" && load.content.kind === "binary" && (
          <BinaryTab
            path={path}
            downloadHref={downloadUrl(workspaceId, view, path)}
          />
        )}
      </div>
    </div>
  );
}
