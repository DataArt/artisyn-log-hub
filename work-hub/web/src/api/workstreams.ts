// `/api/v1/workstreams/*` (API changes → Workstreams).

import { API, apiCall, apiJson, seg } from "./client";

export type WorkstreamState = "open" | "closed" | "done" | "discarded";

/** `WorkstreamSummary`. Dates are ISO-8601 strings. */
export interface WorkstreamSummary {
  id: string;
  name: string;
  state: WorkstreamState;
  baseBranch: string;
  openedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  discardedAt: string | null;
  /** `false` while its container could not be started ("Unavailable"). */
  available: boolean;
  /** Bytes its folder takes on disk; only in `listWorkstreams(id, { disk: true })` (History). */
  diskBytes?: number;
}

/** `POST …/close/check`. */
export interface CloseCheck {
  uncommitted: string[];
  agentBusy: boolean;
}

export type CloseMode = "bring_into_main" | "merged_elsewhere" | "for_now";

export interface TermSize {
  cols: number;
  rows: number;
}

/** `GET …/recording/meta`. */
export interface RecordingMeta {
  totalBytes: number;
  initial: TermSize;
  resizes: { offset: number; cols: number; rows: number }[];
}

const STREAMS = `${API}/workstreams`;
const one = (id: string) => `${STREAMS}/${seg(id)}`;

export async function closeCheck(id: string): Promise<CloseCheck> {
  return apiJson<CloseCheck>(`${one(id)}/close/check`, { method: "POST" });
}

/** 409 `uncommitted {paths}` / `merge_conflict`. */
/** `commit`: commit every uncommitted file in the workstream first ("Commit all and …"). */
export async function closeWorkstream(
  id: string,
  mode: CloseMode,
  force: boolean,
  commit = false,
): Promise<WorkstreamSummary> {
  return apiJson<WorkstreamSummary>(`${one(id)}/close`, {
    method: "POST",
    json: commit ? { mode, force, commit } : { mode, force },
  });
}

/** 409 `cannot_discard`. */
export async function discardWorkstream(
  id: string,
): Promise<WorkstreamSummary> {
  return apiJson<WorkstreamSummary>(`${one(id)}/discard`, { method: "POST" });
}

/** 409 `not_closed`. */
export async function reopenWorkstream(id: string): Promise<WorkstreamSummary> {
  return apiJson<WorkstreamSummary>(`${one(id)}/reopen`, { method: "POST" });
}

/** 503 `unavailable`. */
export async function retryWorkstream(id: string): Promise<WorkstreamSummary> {
  return apiJson<WorkstreamSummary>(`${one(id)}/retry`, { method: "POST" });
}

/** The chat recording bytes (synced first while the workstream runs). */
export async function fetchRecording(id: string): Promise<Uint8Array> {
  const res = await apiCall(`${one(id)}/recording`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchRecordingMeta(id: string): Promise<RecordingMeta> {
  return apiJson<RecordingMeta>(`${one(id)}/recording/meta`);
}

/** Path of the chat terminal WebSocket (D11). */
export function chatSocketPath(id: string): string {
  return `${one(id)}/chat/ws`;
}
