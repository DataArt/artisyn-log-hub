// `/api/v1/workspaces/*` (API changes → Workspaces) and `/api/v1/system/status`.

import { API, apiJson, apiVoid, publicJson, seg } from "./client";
import type { WorkstreamSummary } from "./workstreams";

export type LoginState = "ok" | "missing";

/** `Workspace`. Dates are ISO-8601 strings. */
export interface Workspace {
  id: string;
  name: string;
  workingBranch: string;
  openWorkstreams: number;
  /** Agent id (the server adapter's registry key). */
  agent: string;
  /** The adapter's display name; the UI never hard-codes the agent's name. */
  agentName: string;
  loginState: LoginState;
  loginAt: string | null;
  createdAt: string;
}

/** `GET /workspaces/{id}`: the workspace with its branches, configure flag and open workstreams. */
export interface WorkspaceDetail extends Workspace {
  branches: string[];
  configureActive: boolean;
  /** Open workstreams only. */
  workstreams: WorkstreamSummary[];
}

/** One entry of `GET …/login/sources`. */
export interface LoginSource {
  id: string;
  name: string;
  loginAt: string | null;
}

/** `GET /api/v1/system/status`. */
export interface SystemStatus {
  docker: "ok" | "unreachable";
  defaultImage: "ok" | "building" | "failed";
}

/** react-query keys of this module. */
export const workspaceKeys = {
  all: ["workspaces"] as const,
  detail: (id: string) => ["workspaces", id] as const,
  workstreams: (id: string) => ["workspaces", id, "workstreams"] as const,
  loginSources: (id: string) => ["workspaces", id, "login-sources"] as const,
  systemStatus: ["system-status"] as const,
};

const WS = `${API}/workspaces`;
const one = (id: string) => `${WS}/${seg(id)}`;

/** Public: `{docker, defaultImage}`. */
export async function fetchSystemStatus(): Promise<SystemStatus> {
  return publicJson<SystemStatus>(`${API}/system/status`);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return apiJson<Workspace[]>(WS);
}

/** 201 · 400 `invalid_name`/`duplicate_name` · 503 · 500 `create_failed`. */
export async function createWorkspace(name: string): Promise<Workspace> {
  return apiJson<Workspace>(WS, { method: "POST", json: { name } });
}

/** Runs the live login check. */
export async function getWorkspace(id: string): Promise<WorkspaceDetail> {
  return apiJson<WorkspaceDetail>(one(id));
}

/** 400 `unknown_branch` · 409 `working_tree_busy`. */
export async function setWorkingBranch(
  id: string,
  workingBranch: string,
): Promise<Workspace> {
  return apiJson<Workspace>(one(id), {
    method: "PATCH",
    json: { workingBranch },
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await apiVoid(one(id), { method: "DELETE" });
}

export async function listLoginSources(id: string): Promise<LoginSource[]> {
  return apiJson<LoginSource[]>(`${one(id)}/login/sources`);
}

/** 400 `invalid_login_source`. */
export async function copyLogin(
  id: string,
  fromWorkspaceId: string,
): Promise<{ loggedIn: boolean }> {
  return apiJson<{ loggedIn: boolean }>(`${one(id)}/login/copy`, {
    method: "POST",
    json: { fromWorkspaceId },
  });
}

/** Idempotent; the terminal then attaches to {@link loginSocketPath}. */
export async function startLogin(id: string): Promise<void> {
  await apiVoid(`${one(id)}/login/start`, { method: "POST" });
}

export async function cancelLogin(id: string): Promise<void> {
  await apiVoid(`${one(id)}/login/cancel`, { method: "POST" });
}

/** The sign-in link on the login terminal (wrapped lines joined), or `null` while there is none. */
export async function getLoginLink(
  id: string,
): Promise<{ url: string | null }> {
  return apiJson<{ url: string | null }>(`${one(id)}/login/link`);
}

/** Logs the workspace out of its agent; open workstreams keep their own copy until closed. */
export async function logoutAgent(id: string): Promise<{ loggedIn: boolean }> {
  return apiJson<{ loggedIn: boolean }>(`${one(id)}/login/logout`, {
    method: "POST",
  });
}

/** 409 `configure_running` / `login_required`. */
export async function startConfigure(id: string): Promise<void> {
  await apiVoid(`${one(id)}/configure`, { method: "POST" });
}

export async function finishConfigure(
  id: string,
): Promise<{ checkpointSeq: number }> {
  return apiJson<{ checkpointSeq: number }>(`${one(id)}/configure/finish`, {
    method: "POST",
  });
}

/** Every state. */
export async function listWorkstreams(
  id: string,
  opts: { disk?: boolean } = {},
): Promise<WorkstreamSummary[]> {
  return apiJson<WorkstreamSummary[]>(
    `${one(id)}/workstreams${opts.disk ? "?disk=1" : ""}`,
  );
}

/** 201 · 400 · 409 `login_required` · 500 `open_failed`. */
export async function openWorkstream(
  id: string,
  name: string,
): Promise<WorkstreamSummary> {
  return apiJson<WorkstreamSummary>(`${one(id)}/workstreams`, {
    method: "POST",
    json: { name },
  });
}

/** Path of the login terminal WebSocket (D11). */
export function loginSocketPath(id: string): string {
  return `${one(id)}/login/ws`;
}

/** Path of the configure terminal WebSocket (D11). */
export function configureSocketPath(id: string): string {
  return `${one(id)}/configure/ws`;
}
