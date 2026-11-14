// A live terminal on one of the D11 WebSockets (chat, login, configure).

import "@xterm/xterm/css/xterm.css";

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Loader2, MonitorUp, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { fetchRecording, fetchRecordingMeta } from "../api/workstreams";
import { cn } from "../lib/cn";
import { Button } from "../ui/button";
import { playRecording } from "./replay";
import { binaryStringToBytes, TerminalSocket } from "./terminal-socket";
import styles from "./TerminalView.module.css";
import { openTerminalLink, XTERM_BASE_OPTIONS } from "./xterm-theme";

export interface TerminalViewProps {
  /** WebSocket path, e.g. `chatSocketPath(id)`. */
  wsPath: string;
  /** Workstream whose stored chat recording is written first, so it is in scrollback (D17). */
  replayFrom?: string;
  /** The login / configure process finished (`ended` frame). */
  onEnded?: (info: { loggedIn?: boolean }) => void;
  /** Overlay text on `taken_over`. */
  takenOverText?: string;
  /**
   * Draws one `*` per pasted character at the cursor. For a prompt that echoes nothing (the
   * agent's login code): the pasted text itself goes to the program unchanged.
   */
  maskPastes?: boolean;
  className?: string;
}

/** DEC private modes that switch to the alternate screen (47, 1047, 1049). */
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

type Phase =
  | "loading"
  | "connecting"
  | "live"
  | "reconnecting"
  | "taken_over"
  | "ended";

/**
 * xterm with the fit, clipboard (OSC 52) and web-links addons. Its size follows the container
 * (ResizeObserver → fit → `resize` frame). On `taken_over` it shows an overlay with
 * "Take it back"; a dropped connection shows "Reconnecting…" while it retries.
 */
export function TerminalView({
  wsPath,
  replayFrom,
  onEnded,
  takenOverText = "This chat was opened in another tab",
  maskPastes = false,
  className,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  const onEndedRef = useRef(onEnded);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    setPhase(replayFrom ? "loading" : "connecting");
    setError(null);

    const term = new Terminal({
      ...XTERM_BASE_OPTIONS,
      cursorBlink: true,
      linkHandler: {
        activate: (_event, text) => openTerminalLink(text),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new ClipboardAddon());
    term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri)));
    term.open(host);

    // Ctrl+V (and Ctrl+Shift+V) is the browser's paste: xterm would turn it into ^V, which the
    // agent reads as "paste an image" and the clipboard text never arrives. Let the browser
    // fire its paste event instead; xterm sends the pasted text from it.
    term.attachCustomKeyEventHandler(
      (e) =>
        !(
          e.type === "keydown" &&
          e.ctrlKey &&
          !e.altKey &&
          !e.metaKey &&
          e.code === "KeyV"
        ),
    );

    // tmux switches to the alternate screen, which has no scrollback: the stored recording
    // written first (D17) would be out of reach while the chat is live. Keep tmux on the normal
    // screen so the earlier output stays in scrollback (AC-26).
    const isAltScreen = (params: (number | number[])[]) =>
      params.length > 0 &&
      params.every((p) => typeof p === "number" && ALT_SCREEN_MODES.has(p));
    const altOn = term.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      isAltScreen,
    );
    const altOff = term.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      isAltScreen,
    );

    const socket = new TerminalSocket(wsPath, {
      onOutput: (data) => term.write(data),
      onOpen: () => {
        setPhase("live");
        setError(null);
      },
      onReconnecting: () => setPhase("reconnecting"),
      onTakenOver: () => setPhase("taken_over"),
      onEnded: (loggedIn) => {
        setPhase("ended");
        onEndedRef.current?.(loggedIn === undefined ? {} : { loggedIn });
      },
      onError: (message) => setError(message || null),
    });
    socketRef.current = socket;

    const dataSub = term.onData((d) => socket.sendInput(d));
    const binarySub = term.onBinary((d) =>
      socket.sendInput(binaryStringToBytes(d)),
    );
    const resizeSub = term.onResize(({ cols, rows }) =>
      socket.resize(cols, rows),
    );

    // A prompt that echoes nothing still shows that the paste arrived (D11, login tab).
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const visible = text.replace(/[\r\n]/g, "");
      if (visible.length > 0) term.write("*".repeat(visible.length));
    };
    if (maskPastes) host.addEventListener("paste", onPaste);

    let live = false;
    const refit = () => {
      if (disposed || !live) return;
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // The host is detached or hidden; the next observation fits again.
      }
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);

    const attachLive = () => {
      if (disposed) return;
      live = true;
      refit();
      socket.resize(term.cols, term.rows);
      setPhase("connecting");
      socket.connect();
      term.focus();
    };

    if (replayFrom) {
      void (async () => {
        try {
          const [bytes, meta] = await Promise.all([
            fetchRecording(replayFrom),
            fetchRecordingMeta(replayFrom),
          ]);
          if (disposed) return;
          await playRecording(term, bytes, meta, () => disposed);
          // Push the last recorded screen into scrollback before the live screen redraws.
          if (!disposed && bytes.length > 0)
            term.write("\r\n".repeat(term.rows));
        } catch {
          // No recording yet or it could not be read: the live chat still works.
        }
        attachLive();
      })();
    } else {
      attachLive();
    }

    return () => {
      disposed = true;
      observer.disconnect();
      host.removeEventListener("paste", onPaste);
      dataSub.dispose();
      binarySub.dispose();
      resizeSub.dispose();
      altOn.dispose();
      altOff.dispose();
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
      term.dispose();
    };
  }, [wsPath, replayFrom, maskPastes]);

  const takeBack = () => {
    setPhase("connecting");
    socketRef.current?.resume();
  };

  return (
    <div
      className={cn(styles.root, className)}
      data-testid="terminal-view"
      data-phase={phase}
    >
      <div ref={hostRef} className={styles.host} />

      {error && phase !== "taken_over" && (
        <div role="alert" className={styles.alert}>
          <TriangleAlert className={styles.alertIcon} />
          <span className={styles.alertText}>{error}</span>
        </div>
      )}

      {(phase === "loading" || phase === "reconnecting") && (
        <div className={styles.status}>
          <Loader2 className={styles.statusSpinner} />
          {phase === "loading" ? "Loading the earlier chat…" : "Reconnecting…"}
        </div>
      )}

      {phase === "taken_over" && (
        <div className={styles.takenOver} data-testid="terminal-taken-over">
          <div className={styles.takenOverPanel}>
            <MonitorUp className={styles.takenOverIcon} />
            <p className={styles.takenOverText}>{takenOverText}</p>
            <Button onClick={takeBack}>Take it back</Button>
          </div>
        </div>
      )}
    </div>
  );
}
