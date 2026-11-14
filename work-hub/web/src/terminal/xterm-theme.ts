// xterm light theme and settings (D16, NFR-1a).

import type { ITerminalOptions, ITheme } from "@xterm/xterm";

/** The light palette of every Work Hub terminal. */
export const XTERM_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1f2937",
  cursor: "#1f2937",
  cursorAccent: "#ffffff",
  selectionBackground: "#bfdbfe",
  // ANSI 0–7
  black: "#1f2937",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#a21caf",
  cyan: "#0e7490",
  white: "#6b7280",
  // ANSI 8–15
  brightBlack: "#4b5563",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#c026d3",
  brightCyan: "#0891b2",
  brightWhite: "#9ca3af",
};

/** Scrollback kept in the browser (D16). */
export const XTERM_SCROLLBACK = 10000;

/** Options shared by the live terminal and the read-only replay. */
export const XTERM_BASE_OPTIONS: ITerminalOptions = {
  theme: XTERM_THEME,
  scrollback: XTERM_SCROLLBACK,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  lineHeight: 1.15,
};

/** Opens a link from the terminal (plain URL or OSC 8) in a new tab, never in this one. */
export function openTerminalLink(uri: string): void {
  window.open(uri, "_blank", "noopener,noreferrer");
}
