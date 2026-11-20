// The file tree (FR-13, FR-16–FR-19, D12): directories load lazily on expand, a click on a file
// opens it, the context menu offers "Download" only (no Rename/Delete in the alpha). Files and
// folders dropped from the computer are uploaded into the folder under the pointer; entries
// dragged inside the tree move into the folder they are dropped on.

import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
} from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { useRef, useState, type DragEvent } from "react";

import { ApiError, errorMessage } from "../api/client";
import {
  downloadUrl,
  movePath,
  uploadFiles,
  type Entry,
  type UploadItem,
} from "../api/fs";
import { cn } from "../lib/cn";
import { Button } from "../ui/button";
import { useToast } from "../ui/toast";
import {
  collectDroppedFiles,
  isFileDrag,
  isInternalDrag,
  startEntryDrag,
} from "./dnd";
import { triggerDownload } from "./download";
import styles from "./FileTree.module.css";
import { OverwriteDialog } from "./OverwriteDialog";
import {
  baseName,
  isWithin,
  joinPath,
  parentDir,
  ROOT_DIR,
  type FileTreeModel,
  type TreeRow,
} from "./tree-model";

export interface FileTreeProps {
  workspaceId: string;
  view: string;
  model: FileTreeModel;
  /** Path of the file in the active tab (highlighted). */
  activePath: string | null;
  onOpenFile: (path: string) => void;
  /** `from` now lives at `to` (tabs follow it). */
  onMoved: (from: string, to: string) => void;
  /** An upload or move changed files: answers of polls sent before it are stale. */
  onLocalChange: () => void;
  /** Label of the root folder in the drop hint, e.g. the workspace name. */
  rootLabel: string;
}

type PendingOp =
  | { kind: "upload"; dir: string; items: UploadItem[]; paths: string[] }
  | { kind: "move"; from: string; toDir: string; paths: string[] };

type DropState = { dir: string; kind: "upload" | "move" } | null;

const INDENT_PX = 12;

function EntryIcon({ row }: { row: TreeRow }) {
  if (row.entry.kind === "dir") {
    return row.expanded ? (
      <FolderOpen className={cn(styles.icon, styles.dirIcon)} />
    ) : (
      <Folder className={cn(styles.icon, styles.dirIcon)} />
    );
  }
  if (row.entry.kind === "symlink") {
    return <Link2 className={cn(styles.icon, styles.mutedIcon)} />;
  }
  return <File className={cn(styles.icon, styles.mutedIcon)} />;
}

export function FileTree({
  workspaceId,
  view,
  model,
  activePath,
  onOpenFile,
  onMoved,
  onLocalChange,
  rootLabel,
}: FileTreeProps) {
  const toast = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  /** The path being dragged inside the tree (`getData` is not readable during dragover). */
  const draggingRef = useRef<string | null>(null);
  const [drop, setDrop] = useState<DropState>(null);
  const [pending, setPending] = useState<PendingOp | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuEntry, setMenuEntry] = useState<Entry | null>(null);

  const dirLabel = (dir: string) =>
    dir === ROOT_DIR ? rootLabel : baseName(dir);

  /** Re-lists `dir` now; a collapsed folder keeps the fresh listing for its next expand. */
  const refreshDir = (dir: string) => model.reload(dir);

  // ---- upload ----------------------------------------------------------------------------------

  const runUpload = async (
    dir: string,
    items: UploadItem[],
    overwrite: boolean,
  ) => {
    setBusy(true);
    onLocalChange();
    try {
      const { paths } = await uploadFiles(
        workspaceId,
        view,
        dir,
        items,
        overwrite,
      );
      onLocalChange();
      setPending(null);
      await refreshDir(dir);
      if (dir !== ROOT_DIR) await model.expand(dir);
      toast.show(
        paths.length === 1
          ? `Uploaded ${baseName(paths[0])}.`
          : `Uploaded ${paths.length} files.`,
        "success",
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "target_exists") {
        setPending({ kind: "upload", dir, items, paths: err.paths });
      } else {
        setPending(null);
        toast.show(errorMessage(err), "error");
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- move ------------------------------------------------------------------------------------

  const runMove = async (from: string, toDir: string, overwrite: boolean) => {
    setBusy(true);
    onLocalChange();
    try {
      const { path } = await movePath(
        workspaceId,
        view,
        from,
        toDir,
        overwrite,
      );
      onLocalChange();
      setPending(null);
      model.forget(from);
      onMoved(from, path);
      if (
        model.state.selected !== null &&
        isWithin(model.state.selected, from)
      ) {
        model.select(path);
      }
      await Promise.all([refreshDir(parentDir(from)), refreshDir(toDir)]);
    } catch (err) {
      if (err instanceof ApiError && err.code === "target_exists") {
        const paths = err.paths.length
          ? err.paths
          : [joinPath(toDir, baseName(from))];
        setPending({ kind: "move", from, toDir, paths });
      } else {
        setPending(null);
        toast.show(errorMessage(err), "error");
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- drag and drop ---------------------------------------------------------------------------

  /** Whether `from` may move into `dir` (not into itself, not where it already is). */
  const canMoveInto = (from: string, dir: string) =>
    !isWithin(dir, from) && parentDir(from) !== dir;

  const onDragOverDir = (e: DragEvent, dir: string) => {
    const dt = e.dataTransfer;
    if (isInternalDrag(dt) && draggingRef.current !== null) {
      e.preventDefault();
      e.stopPropagation();
      if (canMoveInto(draggingRef.current, dir)) {
        dt.dropEffect = "move";
        if (drop?.dir !== dir || drop.kind !== "move") {
          setDrop({ dir, kind: "move" });
        }
      } else {
        dt.dropEffect = "none";
        if (drop !== null) setDrop(null);
      }
    } else if (isFileDrag(dt)) {
      e.preventDefault();
      e.stopPropagation();
      dt.dropEffect = "copy";
      if (drop?.dir !== dir || drop.kind !== "upload") {
        setDrop({ dir, kind: "upload" });
      }
    }
  };

  const onDropDir = (e: DragEvent, dir: string) => {
    const dt = e.dataTransfer;
    const from = draggingRef.current;
    setDrop(null);
    if (isInternalDrag(dt) && from !== null) {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = null;
      if (canMoveInto(from, dir)) void runMove(from, dir, false);
      return;
    }
    if (isFileDrag(dt)) {
      e.preventDefault();
      e.stopPropagation();
      // Read synchronously inside the event, then upload.
      const collecting = collectDroppedFiles(dt);
      void (async () => {
        let items: UploadItem[];
        try {
          items = await collecting;
        } catch {
          toast.show("The dropped files could not be read.", "error");
          return;
        }
        if (items.length === 0) {
          toast.show("Nothing to upload: the dropped folder is empty.", "info");
          return;
        }
        await runUpload(dir, items, false);
      })();
    }
  };

  const dropDirOf = (row: TreeRow) =>
    row.entry.kind === "dir" ? row.entry.path : parentDir(row.entry.path);

  // ---- render ----------------------------------------------------------------------------------

  const activateRow = (row: TreeRow) => {
    model.select(row.entry.path);
    if (row.entry.kind === "dir") model.toggle(row.entry.path);
    else onOpenFile(row.entry.path);
  };

  const rootHighlighted = drop?.dir === ROOT_DIR;

  return (
    <div className={styles.root} data-testid="file-tree">
      <ContextMenuPrimitive.Root
        onOpenChange={(open) => {
          if (!open) setMenuEntry(null);
        }}
      >
        <ContextMenuPrimitive.Trigger
          asChild
          onContextMenu={(e) => {
            const el =
              e.target instanceof Element
                ? e.target.closest<HTMLElement>("[data-tree-path]")
                : null;
            const path = el?.dataset.treePath;
            const row = model.rows.find((r) => r.entry.path === path);
            if (!row) {
              e.preventDefault();
              return;
            }
            model.select(row.entry.path);
            setMenuEntry(row.entry);
          }}
        >
          <div
            ref={containerRef}
            role="tree"
            aria-label="Files"
            className={cn(
              styles.tree,
              rootHighlighted && [styles.dropTarget, styles.treeDropTarget],
            )}
            onDragOver={(e) => onDragOverDir(e, ROOT_DIR)}
            onDragLeave={(e) => {
              const next =
                e.relatedTarget instanceof Node ? e.relatedTarget : null;
              if (!next || !containerRef.current?.contains(next)) setDrop(null);
            }}
            onDrop={(e) => onDropDir(e, ROOT_DIR)}
          >
            {model.rows.length === 0 && (
              <div className={styles.empty}>
                {model.rootError ? (
                  <div className={styles.emptyError}>
                    <span className={styles.errorText}>
                      {errorMessage(
                        model.rootError,
                        "The files could not be listed.",
                      )}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void model.loadRoot()}
                    >
                      Try again
                    </Button>
                  </div>
                ) : model.state.listings[ROOT_DIR] ? (
                  "No files yet. Drop files here to upload them."
                ) : (
                  <Loader2 className={cn(styles.loaderLg, styles.spin)} />
                )}
              </div>
            )}
            {model.rows.map((row) => {
              const { entry } = row;
              const isDir = entry.kind === "dir";
              const highlighted = isDir && drop?.dir === entry.path;
              const selected = model.state.selected === entry.path;
              const active = !isDir && activePath === entry.path;
              return (
                <div
                  key={entry.path}
                  role="treeitem"
                  aria-expanded={isDir ? row.expanded : undefined}
                  aria-selected={selected}
                  tabIndex={0}
                  draggable
                  data-tree-path={entry.path}
                  data-kind={entry.kind}
                  data-testid="tree-row"
                  title={entry.path}
                  className={cn(
                    styles.row,
                    (selected || active) && styles.rowSelected,
                    highlighted && [styles.dropTarget, styles.rowDropTarget],
                  )}
                  style={{ paddingLeft: 8 + row.depth * INDENT_PX }}
                  onClick={() => activateRow(row)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      activateRow(row);
                    } else if (
                      isDir &&
                      e.key === "ArrowRight" &&
                      !row.expanded
                    ) {
                      e.preventDefault();
                      void model.expand(entry.path);
                    } else if (isDir && e.key === "ArrowLeft" && row.expanded) {
                      e.preventDefault();
                      model.collapse(entry.path);
                    }
                  }}
                  onDragStart={(e) => {
                    draggingRef.current = entry.path;
                    startEntryDrag(
                      e.dataTransfer,
                      entry,
                      downloadUrl(workspaceId, view, entry.path),
                    );
                  }}
                  onDragEnd={() => {
                    draggingRef.current = null;
                    setDrop(null);
                  }}
                  onDragOver={(e) => onDragOverDir(e, dropDirOf(row))}
                  onDrop={(e) => onDropDir(e, dropDirOf(row))}
                >
                  <span className={styles.chevronSlot}>
                    {isDir &&
                      (row.loading ? (
                        <Loader2 className={cn(styles.loaderSm, styles.spin)} />
                      ) : row.expanded ? (
                        <ChevronDown className={styles.chevron} />
                      ) : (
                        <ChevronRight className={styles.chevron} />
                      ))}
                  </span>
                  <EntryIcon row={row} />
                  <span className={styles.name}>{entry.name}</span>
                </div>
              );
            })}
          </div>
        </ContextMenuPrimitive.Trigger>
        <ContextMenuPrimitive.Portal>
          <ContextMenuPrimitive.Content
            className={styles.menu}
            data-testid="tree-context-menu"
          >
            {menuEntry && (
              <ContextMenuPrimitive.Item
                className={styles.menuItem}
                onSelect={() =>
                  triggerDownload(
                    downloadUrl(workspaceId, view, menuEntry.path),
                  )
                }
                data-testid="tree-download"
              >
                <Download />
                Download
              </ContextMenuPrimitive.Item>
            )}
          </ContextMenuPrimitive.Content>
        </ContextMenuPrimitive.Portal>
      </ContextMenuPrimitive.Root>

      {drop && (
        <div className={styles.dropHint} data-testid="drop-hint">
          {drop.kind === "upload"
            ? `Drop to upload into ${dirLabel(drop.dir)}`
            : `Move into ${dirLabel(drop.dir)}`}
        </div>
      )}

      <OverwriteDialog
        open={pending !== null}
        paths={pending?.paths ?? []}
        busy={busy}
        onCancel={() => setPending(null)}
        onReplace={() => {
          if (!pending) return;
          if (pending.kind === "upload") {
            void runUpload(pending.dir, pending.items, true);
          } else {
            void runMove(pending.from, pending.toDir, true);
          }
        }}
      />
    </div>
  );
}
