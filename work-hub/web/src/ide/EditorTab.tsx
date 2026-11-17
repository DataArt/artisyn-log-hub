// A text file in Monaco (FR-14, FR-15, D12, D19). Save (button or Ctrl+S) sends the text with
// `If-Match` of the version it was loaded at; the server commits it. When the poll reports a new
// version, a clean tab reloads silently and a dirty one shows "Changed by the agent".

import { Loader2, Save } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { ApiError, errorMessage } from "../api/client";
import { readFile, saveFile } from "../api/fs";
import { Button } from "../ui/button";
import { useToast } from "../ui/toast";
import { ChangedOnDiskBanner } from "./ChangedOnDiskBanner";
import styles from "./EditorTab.module.css";
import type { MonacoEditorHandle } from "./MonacoEditor";

const MonacoEditor = lazy(() => import("./MonacoEditor"));

const decoder = new TextDecoder("utf-8");

/** The text of loaded file bytes. */
export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export interface EditorTabProps {
  workspaceId: string;
  view: string;
  path: string;
  initialText: string;
  initialVersion: string;
  /** The version the poll last saw on disk (`undefined` before the first poll, `null` = gone). */
  diskVersion: string | null | undefined;
  onDirtyChange: (dirty: boolean) => void;
  /** A save changed the file: answers of polls sent before it are stale. */
  onLocalChange: () => void;
}

export function EditorTab({
  workspaceId,
  view,
  path,
  initialText,
  initialVersion,
  diskVersion,
  onDirtyChange,
  onLocalChange,
}: EditorTabProps) {
  const toast = useToast();
  const editorRef = useRef<MonacoEditorHandle | null>(null);
  /** The text on disk at `version`: the tab is dirty when the editor differs from it. */
  const savedTextRef = useRef(initialText);
  const versionRef = useRef(initialVersion);
  const pathRef = useRef(path);
  const busyRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** The disk version the unsaved edits conflict with, while the banner shows. */
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  /**
   * A poll answer predating our own save or reload: the version it reports is the one we just
   * replaced, so it is ignored until the poll reports something else.
   */
  const diskVersionRef = useRef(diskVersion);
  const staleDiskVersionRef = useRef<string | null | undefined>(diskVersion);
  useEffect(() => {
    diskVersionRef.current = diskVersion;
  }, [diskVersion]);
  const markDiskVersionStale = useCallback(() => {
    staleDiskVersionRef.current = diskVersionRef.current;
  }, []);

  const onDirtyRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);

  const dirtyRef = useRef(false);
  const updateDirty = useCallback((text: string) => {
    const next = text !== savedTextRef.current;
    if (next === dirtyRef.current) return;
    dirtyRef.current = next;
    setDirty(next);
    onDirtyRef.current(next);
  }, []);

  const currentText = useCallback(
    () => editorRef.current?.getValue() ?? savedTextRef.current,
    [],
  );

  /** Loads the file from disk into the editor, dropping unsaved edits. */
  const reloadFromDisk = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const content = await readFile(workspaceId, view, pathRef.current);
      if (content.kind !== "text") {
        toast.show("The file on disk can no longer be edited here.", "error");
        return;
      }
      const text = decodeText(content.bytes);
      savedTextRef.current = text;
      versionRef.current = content.version;
      markDiskVersionStale();
      editorRef.current?.setValue(text);
      updateDirty(text);
      setConflict(null);
    } catch (err) {
      // A gone file is reported by the deleted-file banner; other errors are shown.
      if (!(err instanceof ApiError && err.statusCode === 404)) {
        toast.show(errorMessage(err), "error");
      }
    } finally {
      busyRef.current = false;
    }
  }, [workspaceId, view, toast, updateDirty, markDiskVersionStale]);

  /** Saves the editor's text over `ifMatch` (default: the version it was loaded at). */
  const save = useCallback(
    async (ifMatch?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setSaving(true);
      const text = currentText();
      // Polls already on their way may report the version this save replaces.
      onLocalChange();
      try {
        const { version } = await saveFile(
          workspaceId,
          view,
          pathRef.current,
          text,
          ifMatch ?? versionRef.current,
        );
        onLocalChange();
        markDiskVersionStale();
        savedTextRef.current = text;
        versionRef.current = version;
        updateDirty(currentText());
        setConflict(null);
      } catch (err) {
        if (err instanceof ApiError && err.code === "changed_on_disk") {
          const v = err.details.version;
          setConflict(typeof v === "string" ? v : versionRef.current);
        } else {
          toast.show(errorMessage(err), "error");
        }
      } finally {
        busyRef.current = false;
        setSaving(false);
      }
    },
    [
      workspaceId,
      view,
      currentText,
      onLocalChange,
      updateDirty,
      markDiskVersionStale,
      toast,
    ],
  );

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  const saveFromKey = useCallback(() => void saveRef.current(), []);

  // The poll saw another version on disk.
  useEffect(() => {
    if (
      saving ||
      typeof diskVersion !== "string" ||
      diskVersion === versionRef.current ||
      diskVersion === staleDiskVersionRef.current
    ) {
      return;
    }
    if (dirty) {
      setConflict(diskVersion);
    } else {
      void reloadFromDisk();
    }
  }, [diskVersion, dirty, saving, reloadFromDisk]);

  return (
    <div
      className={styles.root}
      data-testid="editor-tab"
      data-path={path}
      onKeyDown={(e) => {
        // Ctrl+S outside the editor itself (e.g. on the Save button) saves too.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void save();
        }
      }}
    >
      {conflict !== null && dirty && (
        <ChangedOnDiskBanner
          busy={saving}
          onKeepMine={() => void save(conflict)}
          onTakeTheirs={() => void reloadFromDisk()}
        />
      )}
      <div className={styles.toolbar}>
        <span className={styles.path} title={path}>
          {path}
        </span>
        <Button
          size="xs"
          variant={dirty ? "default" : "outline"}
          disabled={!dirty || saving}
          onClick={() => void save()}
          title="Save (Ctrl+S)"
          data-testid="editor-save"
        >
          {saving ? <Loader2 className={styles.spin} /> : <Save />}
          Save
        </Button>
      </div>
      <div className={styles.body}>
        <Suspense
          fallback={
            <div className={styles.fallback}>
              <Loader2 className={styles.loader} />
            </div>
          }
        >
          <MonacoEditor
            path={path}
            initialValue={initialText}
            onChange={updateDirty}
            onSave={saveFromKey}
            onReady={(handle) => {
              editorRef.current = handle;
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
