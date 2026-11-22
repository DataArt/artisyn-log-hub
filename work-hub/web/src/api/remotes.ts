// `/api/v1/workspaces/{id}/remotes`, `/api/v1/remotes/*` and `/api/v1/clone-ops/*`
// (API changes → Remotes).

import { API, apiJson, apiVoid, seg } from "./client";
import type { ConnStatus, TestResult } from "./connections";

/** `Remote`: a git remote of a workspace, bound to one of the owner's connections. */
export interface Remote {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  connectionId: string | null;
  connectionName: string;
  provider: string | null;
  providerName: string | null;
  blockDefaultRewrite: boolean;
  onlyWsBranches: boolean;
  defaultBranch: string | null;
  status: ConnStatus;
  statusDetail: string | null;
}

/** `GET /clone-ops/{id}`: progress of a clone started by `createWorkspace(…, source, opId)`. */
export interface CloneOp {
  state: "running" | "done" | "failed" | "cancelled";
  line: string;
  percent: number | null;
}

/** `POST …/remotes` body. */
export interface AttachRemoteInput {
  name: string;
  connectionId: string;
  url: string;
  /** Default `true`. */
  blockDefaultRewrite?: boolean;
  /** Default `false`. */
  onlyWsBranches?: boolean;
}

/** `PATCH /remotes/{id}` body. */
export interface UpdateRemoteInput {
  connectionId?: string;
  blockDefaultRewrite?: boolean;
  onlyWsBranches?: boolean;
}

/** react-query keys of this module. */
export const remoteKeys = {
  ofWorkspace: (workspaceId: string) =>
    ["workspaces", workspaceId, "remotes"] as const,
  cloneOp: (opId: string) => ["clone-ops", opId] as const,
};

const one = (id: string) => `${API}/remotes/${seg(id)}`;
const cloneOp = (id: string) => `${API}/clone-ops/${seg(id)}`;

export async function listRemotes(workspaceId: string): Promise<Remote[]> {
  return apiJson<Remote[]>(`${API}/workspaces/${seg(workspaceId)}/remotes`);
}

/** 201 · 400 `invalid_remote_name`/`duplicate_name`/`connection_not_granted`/`invalid_remote_url`. */
export async function attachRemote(
  workspaceId: string,
  input: AttachRemoteInput,
): Promise<Remote> {
  return apiJson<Remote>(`${API}/workspaces/${seg(workspaceId)}/remotes`, {
    method: "POST",
    json: input,
  });
}

/** 400 `connection_not_granted`/`invalid_remote_url`. */
export async function updateRemote(
  id: string,
  input: UpdateRemoteInput,
): Promise<Remote> {
  return apiJson<Remote>(one(id), { method: "PATCH", json: input });
}

/** Removes the git remote from running containers and drops its mirror. */
export async function detachRemote(id: string): Promise<void> {
  await apiVoid(one(id), { method: "DELETE" });
}

/** `ls-remote` of its upstream. */
export async function testRemote(id: string): Promise<TestResult> {
  return apiJson<TestResult>(`${one(id)}/test`, { method: "POST", json: {} });
}

export async function getCloneOp(opId: string): Promise<CloneOp> {
  return apiJson<CloneOp>(cloneOp(opId));
}

export async function cancelCloneOp(opId: string): Promise<void> {
  await apiVoid(`${cloneOp(opId)}/cancel`, { method: "POST", json: {} });
}
