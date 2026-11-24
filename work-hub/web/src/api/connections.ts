// `/api/v1/connection-providers` and `/api/v1/connections/*` (API changes → Connections).
// No provider name, colour or logo lives in the web code: everything comes from `ProviderInfo`.

import { API, apiJson, apiVoid, seg } from "./client";

export type AuthMethod = "ssh_generated" | "ssh_uploaded" | "pat";

export type ConnStatus = "untested" | "ok" | "rejected" | "host_key" | "failed";

/** `GET /connection-providers`. The page URLs keep their `{web}` placeholder. */
export interface ProviderInfo {
  id: string;
  displayName: string;
  shortLabel: string;
  kind: "git";
  authMethods: AuthMethod[];
  baseUrlFixed: string | null;
  baseUrlPlaceholder: string;
  /** Hosted instance offered next to "Self-managed" when `baseUrlFixed` is null. */
  baseUrlHosted: string | null;
  needsUsername: boolean;
  allowHttp: boolean;
  tokenPageUrl: string | null;
  tokenScopes: string | null;
  sshKeysPageUrl: string | null;
  prLabel: string | null;
  testNeedsUrl: boolean;
}

/** `Connection`. Dates are RFC 3339 strings; the secret itself never leaves the server. */
export interface Connection {
  id: string;
  name: string;
  kind: "git";
  provider: string;
  providerName: string;
  baseUrl: string;
  authMethod: AuthMethod;
  username: string | null;
  secretSet: boolean;
  secretHint: string | null;
  secretUpdatedAt: string;
  publicKey: string | null;
  keyFingerprint: string | null;
  hostKeyFingerprint: string | null;
  exposeEnv: string | null;
  status: ConnStatus;
  statusDetail: string | null;
  statusUser: string | null;
  statusAt: string | null;
  grants: { workspaceId: string; workspaceName: string }[];
  usedBy: { workspaceId: string; workspaceName: string; remoteName: string }[];
  createdAt: string;
}

/** `POST /connections` body. `secret` is required unless `authMethod` is `ssh_generated`. */
export interface CreateConnectionInput {
  name: string;
  provider: string;
  baseUrl?: string;
  authMethod: AuthMethod;
  username?: string;
  secret?: string;
  passphrase?: string;
  exposeEnv?: string;
}

/** `PATCH /connections/{id}` body; provider, base URL and auth method are fixed. */
export interface UpdateConnectionInput {
  name?: string;
  secret?: string;
  passphrase?: string;
  username?: string;
  /** `null` stops exposing the token to the agent. */
  exposeEnv?: string | null;
}

/** `POST /connections/{id}/test` body. */
export interface TestRequest {
  url?: string;
  /** The fingerprint ("SHA256:…") the user saw and chose to trust. */
  acceptHostKey?: string;
}

export interface TestResult {
  result:
    | "ok"
    | "host_key_unknown"
    | "host_key_changed"
    | "rejected"
    | "failed";
  user: string | null;
  message: string | null;
  hostKey: { fingerprint: string; keyType: string } | null;
}

/** `POST /connections/{id}/branches`. */
export interface Branches {
  defaultBranch: string | null;
  branches: string[];
}

/** react-query keys of this module. */
export const connectionKeys = {
  all: ["connections"] as const,
  providers: ["connection-providers"] as const,
  detail: (id: string) => ["connections", id] as const,
};

const CONNS = `${API}/connections`;
const one = (id: string) => `${CONNS}/${seg(id)}`;

export async function listProviders(): Promise<ProviderInfo[]> {
  return apiJson<ProviderInfo[]>(`${API}/connection-providers`);
}

/** The signed-in user's own connections. */
export async function listConnections(): Promise<Connection[]> {
  return apiJson<Connection[]>(CONNS);
}

export async function getConnection(id: string): Promise<Connection> {
  return apiJson<Connection>(one(id));
}

/** 201 · 400 `invalid_connection`/`duplicate_name`/`invalid_env_name`/`expose_not_allowed` · 503 `git_proxy_not_ready`. */
export async function createConnection(
  input: CreateConnectionInput,
): Promise<Connection> {
  return apiJson<Connection>(CONNS, { method: "POST", json: input });
}

/** Same errors as {@link createConnection}. */
export async function updateConnection(
  id: string,
  input: UpdateConnectionInput,
): Promise<Connection> {
  return apiJson<Connection>(one(id), { method: "PATCH", json: input });
}

/** 204 · 409 `connection_in_use {workspaces}` unless `force`. */
export async function deleteConnection(
  id: string,
  force = false,
): Promise<void> {
  await apiVoid(`${one(id)}${force ? "?force=true" : ""}`, {
    method: "DELETE",
  });
}

/** 400 `invalid_remote_url`/`host_key_mismatch` · 503 `git_proxy_not_ready`. */
export async function testConnection(
  id: string,
  req: TestRequest = {},
): Promise<TestResult> {
  return apiJson<TestResult>(`${one(id)}/test`, { method: "POST", json: req });
}

/** 400 `not_generated_key`. */
export async function regenerateKey(id: string): Promise<Connection> {
  return apiJson<Connection>(`${one(id)}/regenerate-key`, {
    method: "POST",
    json: {},
  });
}

/** Replaces the set of workspaces the connection is granted to · 400 `invalid_env_name`. */
export async function setGrants(
  id: string,
  workspaceIds: string[],
): Promise<Connection> {
  return apiJson<Connection>(`${one(id)}/grants`, {
    method: "PUT",
    json: { workspaceIds },
  });
}

/** 400 `invalid_remote_url`/`credential_rejected`/`remote_error` · 503 `git_proxy_not_ready`. */
export async function listBranches(id: string, url: string): Promise<Branches> {
  return apiJson<Branches>(`${one(id)}/branches`, {
    method: "POST",
    json: { url },
  });
}
