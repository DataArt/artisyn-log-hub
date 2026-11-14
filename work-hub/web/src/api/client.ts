// HTTP client of the Work Hub SPA (D16), modelled on client/src/viewer/api.ts:122-184.
// Every call is relative to the page (`/api/v1/...`) and sends the session cookie.

/** Base path of the JSON API. */
export const API = "/api/v1";

/**
 * A failed API call. `code` and `message` come from the server's error body
 * `{error, message, ...details}` (D4); the remaining body fields are kept in `details`
 * (e.g. `version` of `changed_on_disk`, `paths` of `target_exists` / `uncommitted`).
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    message = "",
    code?: string,
    retryAfterSeconds?: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
  }

  /** `details.paths` when it is a string list (`target_exists`, `uncommitted`). */
  get paths(): string[] {
    const p = this.details.paths;
    return Array.isArray(p)
      ? p.filter((x): x is string => typeof x === "string")
      : [];
  }
}

/** The plain-English text to show for an error: the server's message, else `fallback`. */
export function errorMessage(
  err: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  if (err instanceof ApiError && err.message) return err.message;
  return fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads a non-2xx response into an {@link ApiError}. */
export async function readApiError(res: Response): Promise<ApiError> {
  const raw: unknown = await res.json().catch(() => ({}));
  const body = isRecord(raw) ? raw : {};
  const { error, message, ...details } = body;
  const retryAfterHeader = res.headers.get("Retry-After");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  return new ApiError(
    res.status,
    typeof message === "string" ? message : "",
    typeof error === "string" ? error : undefined,
    retryAfter !== undefined && Number.isFinite(retryAfter)
      ? retryAfter
      : undefined,
    details,
  );
}

// ---- 401 handling ------------------------------------------------------------------------------

function defaultUnauthorized() {
  if (!window.location.hash.startsWith("#/login")) {
    window.location.hash = "#/login";
  }
}

let onUnauthorized: () => void = defaultUnauthorized;
let unauthorizedInProgress = false;

/** Installed once by the auth provider so a 401 can clear the signed-in user first. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn ?? defaultUnauthorized;
}

/** Re-arms the one-shot 401 guard (after a login, logout or a handled 401). */
export function clearUnauthorizedGuard(): void {
  unauthorizedInProgress = false;
}

function handleUnauthorized() {
  if (unauthorizedInProgress) return;
  unauthorizedInProgress = true;
  onUnauthorized();
}

/**
 * `fetch` with the session cookie. A 401 sends the user to `#/login` (through the installed
 * handler) and throws; any other status is returned as is.
 */
export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (res.status === 401) {
    const err = await readApiError(res);
    handleUnauthorized();
    throw err;
  }
  return res;
}

/** Request options plus `json`: a body sent as JSON with its content type. */
export type JsonInit = RequestInit & { json?: unknown };

function withJson(init: JsonInit | undefined): RequestInit {
  const { json, headers, ...rest } = init ?? {};
  if (json === undefined) return { ...rest, headers };
  return {
    ...rest,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(json),
  };
}

/** `apiFetch` that throws {@link ApiError} on a non-2xx status. */
export async function apiCall(
  input: string,
  init?: JsonInit,
): Promise<Response> {
  const res = await apiFetch(input, withJson(init));
  if (!res.ok) throw await readApiError(res);
  return res;
}

/** JSON answer. */
export async function apiJson<T>(input: string, init?: JsonInit): Promise<T> {
  const res = await apiCall(input, init);
  return (await res.json()) as T;
}

/** A request whose answer has no body (204). */
export async function apiVoid(input: string, init?: JsonInit): Promise<void> {
  await apiCall(input, init);
}

/**
 * Bare `fetch` with the session cookie and no 401 redirect, for the auth calls whose 401 is an
 * answer (wrong password) rather than an expired session. Throws {@link ApiError} on non-2xx.
 */
export async function publicCall(
  input: string,
  init?: JsonInit,
): Promise<Response> {
  const res = await fetch(input, { ...withJson(init), credentials: "include" });
  if (!res.ok) throw await readApiError(res);
  return res;
}

/** {@link publicCall} with a JSON answer. */
export async function publicJson<T>(
  input: string,
  init?: JsonInit,
): Promise<T> {
  const res = await publicCall(input, init);
  return (await res.json()) as T;
}

/** Encodes a path segment (ids are uuids, but the helpers never trust that). */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
