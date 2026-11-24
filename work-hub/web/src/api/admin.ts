// `/api/v1/admin/*` (FR-12, plan D15): the read-only resource overview. Admins only (the e-mails
// in `WORK_HUB_ADMIN_EMAILS`); everyone else gets 403 `forbidden`.

import { API, apiJson } from "./client";

/** Sizes in bytes; `null` = could not be measured (counts as 0 in the totals). */
export interface WorkspaceDisk {
  filesBytes: number | null;
  containersBytes: number | null;
  volumesBytes: number | null;
  imagesBytes: number | null;
  totalBytes: number;
}

export interface AdminWorkspace {
  id: string;
  name: string;
  workingBranch: string;
  createdAt: string;
  workstreamsOpen: number;
  workstreamsTotal: number;
  disk: WorkspaceDisk;
}

export interface AdminUser {
  id: number;
  email: string;
  createdAt: string;
  workspaces: AdminWorkspace[];
  totalBytes: number;
}

/** `GET /admin/overview`. `totalBytes` = every user's total plus the git cache. */
export interface AdminOverview {
  generatedAt: string;
  instance: { gitCacheBytes: number | null };
  users: AdminUser[];
  totalBytes: number;
}

export const adminKeys = {
  overview: ["admin", "overview"] as const,
};

export async function getAdminOverview(): Promise<AdminOverview> {
  return apiJson<AdminOverview>(`${API}/admin/overview`);
}
