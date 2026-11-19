// The terminal WebSocket client (D11 frames, D16 reconnect).
//
// | Direction       | Frame                                        |
// |-----------------|----------------------------------------------|
// | client → server | binary keystrokes                            |
// | client → server | text `{"type":"resize","cols":n,"rows":n}`   |
// | server → client | binary terminal output                       |
// | server → client | text `{"type":"taken_over"}`                 |
// | server → client | text `{"type":"ended","loggedIn"?:bool}`     |
// | server → client | text `{"type":"error","message":…}`          |
//
// A dropped connection is retried after 1, 2, 4 and 8 s, then every 10 s. There is no
// reconnect after `taken_over` or `ended`, nor after `close()`.

/** Delays before the first reconnect attempts; later ones use {@link RECONNECT_STEADY_MS}. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000] as const;
export const RECONNECT_STEADY_MS = 10000;

/** Delay before reconnect attempt `attempt` (0-based). */
export function reconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS_MS[attempt] ?? RECONNECT_STEADY_MS;
}

/** `ws(s)://<this host><path>` — the socket always goes to the page's own origin. */
export function socketUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

export interface TerminalSocketHandlers {
  /** Terminal output bytes. */
  onOutput: (data: Uint8Array) => void;
  /** The connection is open (first time or after a reconnect). */
  onOpen?: () => void;
  /** The connection dropped; the next attempt runs after `delayMs`. */
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Another tab took the session; this socket stays closed until {@link TerminalSocket.resume}. */
  onTakenOver?: () => void;
  /** The login / configure process finished. */
  onEnded?: (loggedIn: boolean | undefined) => void;
  /** A plain-language error from the server. */
  onError?: (message: string) => void;
}

type ServerFrame =
  | { type: "taken_over" }
  | { type: "ended"; loggedIn?: boolean }
  | { type: "error"; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses a server text frame; unknown frames give `null`. */
export function parseServerFrame(text: string): ServerFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "taken_over":
      return { type: "taken_over" };
    case "ended":
      return typeof raw.loggedIn === "boolean"
        ? { type: "ended", loggedIn: raw.loggedIn }
        : { type: "ended" };
    case "error":
      return {
        type: "error",
        message: typeof raw.message === "string" ? raw.message : "",
      };
    default:
      return null;
  }
}

const encoder = new TextEncoder();

/** One terminal connection with reconnect. Call {@link connect} to start. */
export class TerminalSocket {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** No reconnect: closed by the owner, taken over, or ended. */
  private stopped = false;
  private size: { cols: number; rows: number } | null = null;

  constructor(
    private readonly path: string,
    private readonly handlers: TerminalSocketHandlers,
  ) {}

  /** Opens the connection (no-op while one is open or connecting). */
  connect(): void {
    if (this.ws) return;
    this.stopped = false;
    this.clearTimer();
    const ws = new WebSocket(socketUrl(this.path));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      if (this.size) this.sendResize(this.size.cols, this.size.rows);
      this.handlers.onOpen?.();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      if (ev.data instanceof ArrayBuffer) {
        this.handlers.onOutput(new Uint8Array(ev.data));
        return;
      }
      if (typeof ev.data !== "string") return;
      const frame = parseServerFrame(ev.data);
      if (!frame) return;
      if (frame.type === "taken_over") {
        this.stopped = true;
        this.handlers.onTakenOver?.();
      } else if (frame.type === "ended") {
        this.stopped = true;
        this.handlers.onEnded?.(frame.loggedIn);
      } else {
        this.handlers.onError?.(frame.message);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      const delay = reconnectDelay(this.attempt);
      this.handlers.onReconnecting?.(this.attempt, delay);
      this.attempt += 1;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.stopped) this.connect();
      }, delay);
    };
  }

  /** Reconnects after `taken_over` ("Take it back"): the new connection takes the session. */
  resume(): void {
    this.attempt = 0;
    this.connect();
  }

  /** Keystrokes from xterm (`onData` text or `onBinary` byte string). */
  sendInput(data: string | Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(typeof data === "string" ? encoder.encode(data) : data);
  }

  /** Remembers the size and sends it now (and again on every reconnect). */
  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    if (this.size && this.size.cols === cols && this.size.rows === rows) {
      return;
    }
    this.size = { cols, rows };
    this.sendResize(cols, rows);
  }

  /** Closes for good: no reconnect, no more callbacks. */
  close(): void {
    this.stopped = true;
    this.clearTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
    }
  }

  private sendResize(cols: number, rows: number): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** xterm's `onBinary` gives a string of byte values; this turns it into bytes. */
export function binaryStringToBytes(data: string): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;
  return out;
}
