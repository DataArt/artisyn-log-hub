// Text selection and copying in the browser terminals (live chat and replay).

import type { IDisposable, Terminal } from "@xterm/xterm";

import { copyText } from "../lib/clipboard";

/** DEC private modes that switch to the alternate screen (47, 1047, 1049). */
export const ALT_SCREEN_MODES: ReadonlySet<number> = new Set([47, 1047, 1049]);

/** DEC private modes that turn on mouse reporting (X10, VT200, highlight, button, any-event) and
 * its encodings (UTF-8, SGR, urxvt, SGR-pixels). */
export const MOUSE_MODES: ReadonlySet<number> = new Set([
  9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016,
]);

/**
 * Makes xterm ignore the given DEC private modes (`CSI ? … h` / `CSI ? … l`); other modes in the
 * same sequence still apply. The agent CLI turns mouse reporting on, and with it on a plain drag
 * goes to the CLI as clicks instead of selecting text — blocking it keeps the selection working.
 */
export function blockPrivateModes(
  term: Terminal,
  blocked: ReadonlySet<number>,
): IDisposable {
  const handler =
    (final: "h" | "l") =>
    (params: (number | number[])[]): boolean => {
      const modes = params.map((p) => (typeof p === "number" ? p : p[0]));
      if (!modes.some((m) => m !== undefined && blocked.has(m))) return false;
      const rest = modes.filter((m) => m !== undefined && !blocked.has(m));
      if (rest.length > 0) term.write(`\x1b[?${rest.join(";")}${final}`);
      return true;
    };
  const on = term.parser.registerCsiHandler(
    { prefix: "?", final: "h" },
    handler("h"),
  );
  const off = term.parser.registerCsiHandler(
    { prefix: "?", final: "l" },
    handler("l"),
  );
  return {
    dispose: () => {
      on.dispose();
      off.dispose();
    },
  };
}

/**
 * Handles the copy keys for xterm's custom key handler. Returns `false` (xterm must not handle
 * the key) for a copy key, `undefined` for any other key.
 *
 * - Ctrl+C / ⌘C with a selection: left to the browser, whose native `copy` event xterm answers
 *   with the selection — works on http too. Without a selection Ctrl+C stays the interrupt key.
 * - Ctrl+Shift+C and Ctrl+Insert: copy the selection (Chrome's Ctrl+Shift+C inspector is
 *   suppressed).
 */
export function handleCopyKey(
  term: Terminal,
  e: KeyboardEvent,
): false | undefined {
  if (e.type !== "keydown" || e.altKey) return undefined;
  const primary = e.ctrlKey || e.metaKey;
  if (primary && !e.shiftKey && e.code === "KeyC" && term.hasSelection())
    return false;
  const shiftC = e.ctrlKey && e.shiftKey && e.code === "KeyC";
  const ctrlInsert = e.ctrlKey && !e.shiftKey && e.code === "Insert";
  if (shiftC || ctrlInsert) {
    const selected = term.getSelection();
    if (selected) void copyText(selected, () => term.focus());
    term.clearSelection();
    e.preventDefault();
    return false;
  }
  return undefined;
}

/**
 * Mouse and clipboard-event copying on the terminal's host element:
 * - right-click on a selection copies it (as in Windows Terminal) instead of opening the browser
 *   menu, which has no Copy for xterm's own selection; without a selection the menu opens;
 * - after any copy the selection is cleared, so the next Ctrl+C is the interrupt key again.
 * Returns the cleanup.
 */
export function installCopyHandlers(
  term: Terminal,
  host: HTMLElement,
): () => void {
  const onContextMenu = (e: MouseEvent) => {
    if (!term.hasSelection()) return;
    e.preventDefault();
    void copyText(term.getSelection(), () => term.focus());
    term.clearSelection();
  };
  // xterm's own copy listener on its textarea fills the clipboard first; this one runs after it.
  const onCopy = () => setTimeout(() => term.clearSelection(), 0);
  host.addEventListener("contextmenu", onContextMenu);
  host.addEventListener("copy", onCopy);
  return () => {
    host.removeEventListener("contextmenu", onContextMenu);
    host.removeEventListener("copy", onCopy);
  };
}
