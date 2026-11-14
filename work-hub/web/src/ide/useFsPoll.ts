// The file poll (D12, AC-16, AC-23): every 2 s while the page is visible, one `POST …/poll` with
// the expanded directories and the open files. Listings are merged into the tree and the file
// versions handed to the open tabs, so the agent's changes show without a reload.

import { useCallback, useEffect, useRef } from "react";

import { pollFs, type PollResult } from "../api/fs";

export const POLL_INTERVAL_MS = 2000;

export interface FsPollOptions {
  workspaceId: string;
  view: string;
  /** Directories to list (the root `""` plus the expanded ones). */
  dirs: string[];
  /** Open files whose versions to report. */
  files: string[];
  /** Listings by directory, `null` when the directory is gone. */
  onDirs: (dirs: PollResult["dirs"]) => void;
  /** Versions by file, `null` when the file is gone. */
  onFiles: (files: PollResult["files"]) => void;
  enabled?: boolean;
}

export interface FsPoll {
  /**
   * Marks a local change (save, upload, move). An answer to a poll sent before it describes the
   * old state and is dropped, so a tab is not told its own save is "changed on disk".
   */
  invalidate: () => void;
  /** Polls now instead of at the next tick. */
  pollNow: () => void;
}

function isVisible(): boolean {
  return document.visibilityState === "visible";
}

export function useFsPoll({
  workspaceId,
  view,
  dirs,
  files,
  onDirs,
  onFiles,
  enabled = true,
}: FsPollOptions): FsPoll {
  const latest = useRef({ workspaceId, view, dirs, files, onDirs, onFiles });
  useEffect(() => {
    latest.current = { workspaceId, view, dirs, files, onDirs, onFiles };
  });

  /** Bumped by every local change; an answer is used only when no bump happened meanwhile. */
  const epochRef = useRef(0);
  const inFlightRef = useRef(false);

  const runOnce = useCallback(async () => {
    if (inFlightRef.current || !isVisible()) return;
    const req = latest.current;
    const epoch = epochRef.current;
    inFlightRef.current = true;
    try {
      const result = await pollFs(
        req.workspaceId,
        req.view,
        req.dirs,
        req.files,
      );
      const now = latest.current;
      if (
        epoch !== epochRef.current ||
        now.workspaceId !== req.workspaceId ||
        now.view !== req.view
      ) {
        return;
      }
      now.onDirs(result.dirs);
      now.onFiles(result.files);
    } catch {
      // A failed poll is retried at the next tick; the page keeps what it shows.
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const start = () => {
      if (timer !== undefined) return;
      timer = window.setInterval(() => void runOnce(), POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (isVisible()) {
        void runOnce();
        start();
      } else {
        stop();
      }
    };
    if (isVisible()) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, runOnce, workspaceId, view]);

  const invalidate = useCallback(() => {
    epochRef.current += 1;
  }, []);

  const pollNow = useCallback(() => {
    void runOnce();
  }, [runOnce]);

  return { invalidate, pollNow };
}
