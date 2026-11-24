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
  /** The remote a close can push to (origin, else the oldest); `null` when there is none. */
  pushRemote: PushRemote | null;
  /** The workstream's own branch, which "Close for now" pushes. Absent from an older server. */
  branch?: string;
}

/** `PushRemote` of {@link CloseCheck}. */
export interface PushRemote {
  name: string;
  connectionName: string;
  providerName: string | null;
  defaultBranch: string | null;
}

/** The outcome of the push a close was asked to make; a failed push never fails the close. */
export interface PushResult {
  remote: string;
  branch: string;
  ok: boolean;
  rejectedBy: "policy" | "credential" | "host" | null;
  message: string | null;
  prUrl: string | null;
  prLabel: string | null;
}

/** `POST …/close`: the closed workstream plus its push result. */
export type CloseResult = WorkstreamSummary & { push?: PushResult | null };

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
/** `push`: push the branch to {@link CloseCheck.pushRemote} as part of the close. */
export async function closeWorkstream(
  id: string,
  mode: CloseMode,
  force: boolean,
  commit = false,
  push = false,
): Promise<CloseResult> {
  const json: {
    mode: CloseMode;
    force: boolean;
    commit?: boolean;
    push?: boolean;
  } = { mode, force };
  if (commit) json.commit = true;
  if (push) json.push = true;
  return apiJson<CloseResult>(`${one(id)}/close`, { method: "POST", json });
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
