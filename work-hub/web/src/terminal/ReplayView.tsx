// Read-only replay of a workstream's stored chat (D17, FR-33): no WebSocket.

import "@xterm/xterm/css/xterm.css";

import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { errorMessage } from "../api/client";
import { fetchRecording, fetchRecordingMeta } from "../api/workstreams";
import { cn } from "../lib/cn";
import { playRecording } from "./replay";
import styles from "./ReplayView.module.css";
import { openTerminalLink, XTERM_BASE_OPTIONS } from "./xterm-theme";

type Status = "loading" | "ready" | "empty" | "error";

export interface ReplayViewProps {
  workstreamId: string;
  className?: string;
}

/** xterm fed segment by segment from `…/recording` and `…/recording/meta`. */
export function ReplayView({ workstreamId, className }: ReplayViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    setStatus("loading");

    const term = new Terminal({
      ...XTERM_BASE_OPTIONS,
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      linkHandler: {
        activate: (_event, text) => openTerminalLink(text),
      },
    });
    term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri)));
    term.open(host);

    void (async () => {
      try {
        const [bytes, meta] = await Promise.all([
          fetchRecording(workstreamId),
          fetchRecordingMeta(workstreamId),
        ]);
        if (disposed) return;
        if (bytes.length === 0 || meta.totalBytes === 0) {
          setStatus("empty");
          return;
        }
        await playRecording(term, bytes, meta, () => disposed);
        if (!disposed) {
          term.scrollToBottom();
          setStatus("ready");
        }
      } catch (err) {
        if (disposed) return;
        setMessage(
          errorMessage(err, "The chat recording could not be loaded."),
        );
        setStatus("error");
      }
    })();

    return () => {
      disposed = true;
      term.dispose();
    };
  }, [workstreamId]);

  return (
    <div
      className={cn(styles.root, className)}
      data-testid="replay-view"
      data-status={status}
    >
      <div ref={hostRef} className={styles.host} />
      {status === "loading" && (
        <div className={cn(styles.overlay, styles.loading)}>
          <Loader2 className={styles.spinner} />
          Loading the chat…
        </div>
      )}
      {status === "empty" && (
        <div className={cn(styles.overlay, styles.empty)}>
          Nothing was recorded in this chat.
        </div>
      )}
      {status === "error" && (
        <div role="alert" className={cn(styles.overlay, styles.error)}>
          {message}
        </div>
      )}
    </div>
  );
}
