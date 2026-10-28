import type {
  AuthConfig,
  ChangePasswordResult,
  UserProfile,
} from '../models/auth';
import type { AdminAuthConfig, PendingRegistration } from '../models/admin';
import type { UserSetting } from '../models/user-settings';
import type {
  Team,
  TeamAccessMode,
  TeamMember,
  TeamRepository,
  Invitation,
  PendingDisclosure,
} from '../models/teams';
import type {
  AttributionBreakdownReportData,
  AttributionUsageReportData,
  BranchSummary,
  CacheReadRatioReportData,
  ChangeSurfaceAggregate,
  ChangeSurfaceFilesResponse,
  ChangeSurfaceReportData,
  ChangeSurfaceTimeline,
  ChangeSurfaceTimelineBucket,
  ExecutiveSummaryReportData,
  RepoConfig,
  RepositoryContext,
  RepositoryDetail,
  RepositorySession,
  RepositorySummary,
  SessionAttributionAttributeDef,
  SessionAttributionLastRun,
  SessionAttributionRunOutcome,
  SessionAttributionValueBucket,
  SessionAttributionValues,
  TimelineSession,
  WorkTimeBucket,
  ActiveSessionsResponse,
  ProductivityAnalyticsResponse,
  RepoOkfUsageResponse,
  SessionOkfUsageResponse,
  TokenAnalyticsResponse,
  ToolAnalyticsResponse,
} from '../models/repositories';
import type {
  AdminModelPricingResponse,
  AdminModelPricingRow,
  AnthropicFetchNowResult,
  ModelPriceInput,
  ModelPricingMap,
  OpenRouterImportResult,
} from '../models/pricing';
import type { AiToolVersionsResponse } from '../models/ai-tool-versions';
import type { HarnessUsageReportData } from '../models/harness-usage';
import type {
  AdminRepo,
  AdminTeam,
  AdminTeamMember,
  AdminUser,
  DataRetentionStats,
  ErrorLogEntry,
  SystemInfo,
  UploadQueueEntry,
  UploadQueueStats,
} from '../models';
import type { WorkflowRun } from '../models/workflows';
import type {
  HookRepositorySummary,
  HookStateDetail,
} from '../models/hook-state';
import type {
  BootstrapImportJobStatus,
  ExportImportJobStatus,
  ExportImportScope,
  ExportScopeSummary,
  ImportUploadSummary,
} from '../models/export-import';
// Called by main.tsx once on startup so api.ts can clear React auth state on 401.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

let logoutInProgress = false;

export function clearLogoutGuard(): void {
  logoutInProgress = false;
}

function navigateToLogin() {
  if (logoutInProgress) return;
  logoutInProgress = true;
  if (onUnauthorized) {
    onUnauthorized();
  }
}

export class ApiError extends Error {
  statusCode: number;
  code?: string;
  retryAfterSeconds?: number;
  constructor(
    statusCode: number,
    message = '',
    code?: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function readApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
  };
  const retryAfterHeader = res.headers.get('Retry-After');
  return new ApiError(
    res.status,
    body.message ?? '',
    body.error,
    retryAfterHeader ? Number(retryAfterHeader) : undefined,
  );
}

async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: 'include' });
  if (res.status === 401) {
    navigateToLogin();
    throw new ApiError(401, 'Unauthorized');
  }
  return res;
}

export async function fetchMe(): Promise<UserProfile> {
  const res = await fetch('/api/v1/auth/me', { credentials: 'include' });
  if (res.ok) return res.json() as Promise<UserProfile>;
  throw new ApiError(res.status);
}

export async function login(
  email: string,
  password: string,
): Promise<UserProfile> {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) return res.json() as Promise<UserProfile>;
  throw await readApiError(res);
}

export async function identify(email: string): Promise<UserProfile> {
  const res = await fetch('/api/v1/auth/identify', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (res.ok) return res.json() as Promise<UserProfile>;
  throw await readApiError(res);
}

export async function signup(
  email: string,
  password: string,
  passwordConfirm: string,
): Promise<UserProfile> {
  const res = await fetch('/api/v1/auth/signup', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, passwordConfirm }),
  });
  if (res.status === 201) return res.json() as Promise<UserProfile>;
  throw await readApiError(res);
}

export async function confirmEmail(token: string): Promise<UserProfile> {
  const res = await fetch('/api/v1/auth/confirm-email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.ok) return res.json() as Promise<UserProfile>;
  throw await readApiError(res);
}

export async function resendConfirmation(
  email: string,
): Promise<{ email_delivery: 'sent' | 'failed' }> {
  const res = await fetch('/api/v1/auth/resend-confirmation', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (res.ok)
    return res.json() as Promise<{ email_delivery: 'sent' | 'failed' }>;
  throw await readApiError(res);
}

export async function forgotPassword(
  email: string,
): Promise<{ email_delivery: 'sent' | 'failed' }> {
  const res = await fetch('/api/v1/auth/forgot-password', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (res.ok)
    return res.json() as Promise<{ email_delivery: 'sent' | 'failed' }>;
  throw await readApiError(res);
}

export async function resetPassword(
  token: string,
  password: string,
  passwordConfirm: string,
): Promise<UserProfile> {
  const res = await fetch('/api/v1/auth/reset-password', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password, passwordConfirm }),
  });
  if (res.ok) return res.json() as Promise<UserProfile>;
  throw await readApiError(res);
}

/**
 * Deliberately uses bare `fetch` instead of `apiFetch`: `apiFetch` force-navigates
 * to the login page on any 401, and this call is made by an already-logged-in user
 * from inside a dialog. (The server answers a wrong current password with 403
 * `invalid_current_password` for the same reason.)
 */
export async function changePassword(
  currentPassword: string,
  password: string,
  passwordConfirm: string,
): Promise<ChangePasswordResult> {
  const res = await fetch('/api/v1/auth/change-password', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, password, passwordConfirm }),
  });
  if (res.ok) return res.json() as Promise<ChangePasswordResult>;
  throw await readApiError(res);
}

/**
 * Self-service account deletion. The confirmation word is
 * re-validated server-side, which is why it travels in a POST body rather than
 * as a bodyless DELETE. Answers 204 with no body on success.
 */
export async function deleteMyAccount(): Promise<void> {
  const res = await apiFetch('/api/v1/auth/delete-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'delete' }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch('/api/v1/auth/config', {
    credentials: 'include',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<AuthConfig>;
}

export async function logout(): Promise<void> {
  await fetch('/api/v1/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });
}

export async function pingSession(): Promise<void> {
  const res = await apiFetch('/api/v1/ping');
  if (res.status !== 204) throw new ApiError(res.status);
}

/**
 * `asOf` (`YYYY-MM-DD`) returns the rates in effect on that date (D2.6); omitted means today.
 */
export async function fetchModelPricing(
  asOf?: string,
): Promise<ModelPricingMap> {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : '';
  const res = await apiFetch(`/api/v1/model-pricing${query}`);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<ModelPricingMap>;
}

export async function fetchAiToolVersions(
  toolName: string,
): Promise<AiToolVersionsResponse> {
  const res = await apiFetch(
    `/api/v1/ai-tool-versions/${encodeURIComponent(toolName)}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<AiToolVersionsResponse>;
}

// API Keys

export interface ApiKey {
  id: number;
  name: string;
  slug: string;
  created_at: string;
  expires_at: string | null;
}

export interface CreatedApiKey extends ApiKey {
  key: string; // shown once on creation
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const res = await apiFetch('/api/v1/api-keys');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<ApiKey[]>;
}

export async function createApiKey(
  name: string,
  expiresAt?: string,
): Promise<CreatedApiKey> {
  const body: Record<string, string> = { name };
  if (expiresAt) body['expires_at'] = expiresAt;
  const res = await apiFetch('/api/v1/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 201) return res.json() as Promise<CreatedApiKey>;
  const err = (await res.json().catch(() => ({}))) as { message?: string };
  throw new ApiError(res.status, err.message ?? '');
}

export async function updateApiKey(
  id: number,
  updates: { expires_at?: string | null },
): Promise<ApiKey> {
  const res = await apiFetch(`/api/v1/api-keys/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (res.ok) return res.json() as Promise<ApiKey>;
  const err = (await res.json().catch(() => ({}))) as { message?: string };
  throw new ApiError(res.status, err.message ?? '');
}

export async function deleteApiKey(id: number): Promise<void> {
  const res = await apiFetch(`/api/v1/api-keys/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new ApiError(res.status);
}

// Repositories (from logs)

export interface UserRepository {
  id: number;
  repoUrl: string;
}

export async function fetchMyRepositories(): Promise<UserRepository[]> {
  const res = await apiFetch('/api/v1/repositories');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<UserRepository[]>;
}

export async function fetchRepositorySessions(
  repoId: number,
  teamId?: number,
  branch?: string | null,
): Promise<RepositorySession[]> {
  const params = new URLSearchParams();
  if (teamId != null) params.set('teamId', String(teamId));
  if (branch !== undefined) params.set('branch', branch ?? '');
  const qs = params.toString();
  const url = qs
    ? `/api/v1/repositories/${repoId}/sessions?${qs}`
    : `/api/v1/repositories/${repoId}/sessions`;
  const res = await apiFetch(url);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<RepositorySession[]>;
}

export async function fetchRepositorySessionIds(
  repoId: number,
  teamId?: number,
  branch?: string | null,
  opts?: { hideHookSessions?: boolean; filterByUserEmail?: string },
): Promise<string[]> {
  const params = new URLSearchParams();
  if (teamId != null) params.set('teamId', String(teamId));
  if (branch !== undefined) params.set('branch', branch ?? '');
  if (opts?.hideHookSessions) params.set('hideHookSessions', 'true');
  if (opts?.filterByUserEmail) {
    params.set('filterByUserEmail', opts.filterByUserEmail);
  }
  // Cache-busting: this is polled on an interval, and an unchanged URL can be
  // served from the browser's HTTP cache instead of hitting the network.
  params.set('_ts', String(Date.now()));
  const url = `/api/v1/repositories/${repoId}/sessions/ids?${params.toString()}`;
  const res = await apiFetch(url, { cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<string[]>;
}

export async function fetchRepositoryBranches(
  repoId: number,
  teamId?: number,
  dateRange?: { startDate: string; endDate: string },
): Promise<BranchSummary[]> {
  const params = new URLSearchParams();
  if (teamId != null) params.set('teamId', String(teamId));
  if (dateRange) {
    params.set('startDate', dateRange.startDate);
    params.set('endDate', dateRange.endDate);
  }
  const qs = params.toString();
  const url = `/api/v1/repositories/${repoId}/sessions/branches${qs ? `?${qs}` : ''}`;
  const res = await apiFetch(url);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<BranchSummary[]>;
}

/**
 * Feeds `AttributeFilterPopover.tsx`'s per-attribute value lists.
 * Keyed by attribute `key`; an attribute with no session yet carrying a concrete (non-null)
 * value for it is simply absent from the record rather than mapping to `[]`.
 */
export async function fetchSessionAttributionValues(
  repoId: number,
  teamId?: number,
  dateRange?: { startDate: string; endDate: string },
): Promise<Record<string, SessionAttributionValueBucket[]>> {
  const params = new URLSearchParams();
  if (teamId != null) params.set('teamId', String(teamId));
  if (dateRange) {
    params.set('startDate', dateRange.startDate);
    params.set('endDate', dateRange.endDate);
  }
  const qs = params.toString();
  const url = `/api/v1/repositories/${repoId}/session-attribution/values${qs ? `?${qs}` : ''}`;
  const res = await apiFetch(url);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<Record<string, SessionAttributionValueBucket[]>>;
}

export async function fetchRepositorySummary(
  repoId: number,
  teamId?: number,
): Promise<RepositorySummary> {
  const url = teamId
    ? `/api/v1/repositories/${repoId}/summary?teamId=${teamId}`
    : `/api/v1/repositories/${repoId}/summary`;
  const res = await apiFetch(url);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<RepositorySummary>;
}

export async function fetchRepositoryContexts(
  repoId: number,
  teamId?: number,
): Promise<RepositoryContext[]> {
  const url = teamId
    ? `/api/v1/repositories/${repoId}/contexts?teamId=${teamId}`
    : `/api/v1/repositories/${repoId}/contexts`;
  const res = await apiFetch(url);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<RepositoryContext[]>;
}

// Hook state

export async function fetchHookRepositories(): Promise<
  HookRepositorySummary[]
> {
  const res = await apiFetch('/api/v1/repositories/hooks');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<HookRepositorySummary[]>;
}

export async function fetchHookState(
  repoId: number,
  teamId?: number,
): Promise<HookStateDetail> {
  const url = teamId
    ? `/api/v1/repositories/${repoId}/hook-state?teamId=${teamId}`
    : `/api/v1/repositories/${repoId}/hook-state`;
  const res = await apiFetch(url);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<HookStateDetail>;
}

export interface AnalyticsQueryParams {
  teamId?: number;
  startDate: string;
  endDate: string;
  // Widened to accept `attr:<key>` for
  // `analytics/timeline`/`analytics/work-time`, both of which now validate that form
  // server-side.
  groupBy?: 'branch' | 'user' | `attr:${string}`;
  branches?: string[];
  users?: string[];
}

export async function fetchAnalyticsTimeline(
  repoId: number,
  params: AnalyticsQueryParams,
): Promise<TimelineSession[]> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.groupBy) url.set('groupBy', params.groupBy);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/analytics/timeline?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  const raw = (await res.json()) as TimelineSession[];
  return raw.map((s) => {
    if (s.mcpCallsByServer == null) {
      console.error(
        `[analytics] session ${s.sessionId} is missing mcpCallsByServer — defaulting to {}`,
      );
    }
    return {
      ...s,
      mcpCallsTotal: s.mcpCallsTotal ?? 0,
      mcpCallsByServer: s.mcpCallsByServer ?? {},
    };
  });
}

export async function fetchAnalyticsWorkTime(
  repoId: number,
  params: AnalyticsQueryParams,
): Promise<WorkTimeBucket[]> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.groupBy) url.set('groupBy', params.groupBy);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/analytics/work-time?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<WorkTimeBucket[]>;
}

export interface ExecutiveSummaryQueryParams {
  teamId?: number;
  startDate: string;
  endDate: string;
  branches?: string[];
  users?: string[];
}

export async function fetchExecutiveSummaryReport(
  repoId: number,
  params: ExecutiveSummaryQueryParams,
): Promise<ExecutiveSummaryReportData> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/reports/executive-summary?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<ExecutiveSummaryReportData>;
}

export interface CacheReadRatioQueryParams {
  teamId?: number;
  startDate: string;
  endDate: string;
  // Widened to accept `attr:<key>`.
  groupBy?: 'branch' | 'user' | `attr:${string}`;
  branches?: string[];
  users?: string[];
}

export async function fetchCacheReadRatioReport(
  repoId: number,
  params: CacheReadRatioQueryParams,
): Promise<CacheReadRatioReportData> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.groupBy) url.set('groupBy', params.groupBy);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/reports/cache-read-ratio?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<CacheReadRatioReportData>;
}

export interface HarnessUsageQueryParams {
  teamId?: number;
  startDate: string;
  endDate: string;
  // Widened to accept `attr:<key>`.
  groupBy?: 'branch' | 'user' | `attr:${string}`;
  branches?: string[];
  users?: string[];
}

export async function fetchHarnessUsageReport(
  repoId: number,
  params: HarnessUsageQueryParams,
): Promise<HarnessUsageReportData> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.groupBy) url.set('groupBy', params.groupBy);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/reports/harness-usage?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<HarnessUsageReportData>;
}

// --- Change surface --------------------------------------------------------------
//
// Four fetchers, mirroring the four routes. The two session-scoped ones are split on purpose:
// the Summary tab needs only the aggregate on every session open, while
// the file rows are fetched once the Change surface tab is actually opened.

/**
 * One session tree's change-surface aggregate — the Summary tile, the three CS detectors and
 * the tab's headline all read this. An inaccessible or never-recomputed session comes back as
 * `computed: false`, which every surface renders as "no data".
 */
export async function fetchSessionChangeSurface(
  repoId: number,
  sessionId: string,
  teamId?: number,
): Promise<ChangeSurfaceAggregate> {
  const base = `/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sessionId)}/change-surface`;
  const res = await apiFetch(teamId ? `${base}?teamId=${teamId}` : base);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<ChangeSurfaceAggregate>;
}

/**
 * The per-path rows behind the tab's file tree. Capped server-side — when `truncated` is
 * `true` the tree must say "showing first N of `total` paths" rather than silently cutting.
 */
export async function fetchSessionChangeSurfaceFiles(
  repoId: number,
  sessionId: string,
  teamId?: number,
): Promise<ChangeSurfaceFilesResponse> {
  const base = `/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sessionId)}/change-surface/files`;
  const res = await apiFetch(teamId ? `${base}?teamId=${teamId}` : base);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<ChangeSurfaceFilesResponse>;
}

export interface ChangeSurfaceAnalyticsQueryParams extends AnalyticsQueryParams {
  /** `'none'` is accepted too; absent means "no grouping". */
  groupBy?: 'branch' | 'user' | `attr:${string}`;
  /** Absent -> the server derives it from the range span. */
  bucket?: ChangeSurfaceTimelineBucket;
}

export async function fetchAnalyticsChangeSurface(
  repoId: number,
  params: ChangeSurfaceAnalyticsQueryParams,
): Promise<ChangeSurfaceTimeline> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.groupBy) url.set('groupBy', params.groupBy);
  if (params.bucket) url.set('bucket', params.bucket);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/analytics/change-surface?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<ChangeSurfaceTimeline>;
}

export interface ChangeSurfaceReportQueryParams {
  teamId?: number;
  startDate: string;
  endDate: string;
  groupBy?: 'branch' | 'user' | `attr:${string}`;
  branches?: string[];
  users?: string[];
}

export async function fetchChangeSurfaceReport(
  repoId: number,
  params: ChangeSurfaceReportQueryParams,
): Promise<ChangeSurfaceReportData> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.groupBy) url.set('groupBy', params.groupBy);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/reports/change-surface?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<ChangeSurfaceReportData>;
}

// --- OKF usage -------------------------------------------------------------------

/**
 * How one session tree read the repo's OKF knowledge bases (session OKF tab). With `teamId`
 * the server applies the team view filter (gitignored KB paths are never returned).
 */
export async function fetchSessionOkfUsage(
  repoId: number,
  sessionId: string,
  teamId?: number,
): Promise<SessionOkfUsageResponse> {
  const base = `/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sessionId)}/okf-usage`;
  const res = await apiFetch(teamId ? `${base}?teamId=${teamId}` : base);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<SessionOkfUsageResponse>;
}

export interface RepoOkfUsageQueryParams {
  teamId?: number;
  startDate: string;
  endDate: string;
  branches?: string[];
  users?: string[];
  /** Raw `<key>:<op>[:<value>]` attribute filters, one `attr=` param each. */
  attr?: string[];
  /** Bundle root to narrow to; absent or unknown means all bundles. */
  bundle?: string;
}

/** How the repo's OKF knowledge bases were read over a period (repo OKF tab). */
export async function fetchRepoOkfUsage(
  repoId: number,
  params: RepoOkfUsageQueryParams,
): Promise<RepoOkfUsageResponse> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  for (const a of params.attr ?? []) url.append('attr', a);
  if (params.bundle) url.set('bundle', params.bundle);
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/reports/okf-usage?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<RepoOkfUsageResponse>;
}

export interface AttributionBreakdownQueryParams {
  teamId?: number;
  startDate: string;
  endDate: string;
  branches?: string[];
  users?: string[];
}

export async function fetchAttributionBreakdownReport(
  repoId: number,
  params: AttributionBreakdownQueryParams,
): Promise<AttributionBreakdownReportData> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/reports/attribution-breakdown?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<AttributionBreakdownReportData>;
}

export interface AttributionUsageQueryParams {
  teamId?: number;
  startDate: string;
  endDate: string;
  branches?: string[];
  users?: string[];
  /** `supportsAttributeFilter: false` — this report has no `attr=`
   * param; its own scope-narrowing control is this repeatable `outcome=` instead. */
  outcomes?: SessionAttributionRunOutcome[];
}

export async function fetchAttributionUsageReport(
  repoId: number,
  params: AttributionUsageQueryParams,
): Promise<AttributionUsageReportData> {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  for (const outcome of params.outcomes ?? []) {
    url.append('outcome', outcome);
  }
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/reports/attribution-usage?${url.toString()}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<AttributionUsageReportData>;
}

// --- Usage analytics ----------------------------------------------------------------

export interface UsageAnalyticsQueryParams {
  teamId?: number;
  startDate: string;
  endDate: string;
  branches?: string[];
  users?: string[];
  /** `active-sessions` only — default 100, max 500. */
  limit?: number;
}

/**
 * Shared query-string builder for the eight usage endpoints. Each filter value is
 * individually `encodeURIComponent`d before joining on `,`, matching what the server's
 * `parseCsvParam` expects — so a branch name containing a comma survives the round trip.
 */
function usageAnalyticsQuery(params: UsageAnalyticsQueryParams): string {
  const url = new URLSearchParams();
  if (params.teamId != null) url.set('teamId', String(params.teamId));
  url.set('startDate', params.startDate);
  url.set('endDate', params.endDate);
  if (params.branches && params.branches.length > 0) {
    url.set(
      'branches',
      params.branches.map((b) => encodeURIComponent(b)).join(','),
    );
  }
  if (params.users && params.users.length > 0) {
    url.set('users', params.users.map((u) => encodeURIComponent(u)).join(','));
  }
  if (params.limit != null) url.set('limit', String(params.limit));
  return url.toString();
}

async function fetchUsageAnalytics<T>(
  repoId: number,
  path: string,
  params: UsageAnalyticsQueryParams,
): Promise<T> {
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/${path}?${usageAnalyticsQuery(params)}`,
  );
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<T>;
}

export function fetchToolAnalytics(
  repoId: number,
  params: UsageAnalyticsQueryParams,
): Promise<ToolAnalyticsResponse> {
  return fetchUsageAnalytics(repoId, 'analytics/tools', params);
}

export function fetchTokenAnalytics(
  repoId: number,
  params: UsageAnalyticsQueryParams,
): Promise<TokenAnalyticsResponse> {
  return fetchUsageAnalytics(repoId, 'analytics/tokens', params);
}

export function fetchProductivityAnalytics(
  repoId: number,
  params: UsageAnalyticsQueryParams,
): Promise<ProductivityAnalyticsResponse> {
  return fetchUsageAnalytics(repoId, 'analytics/productivity', params);
}

export function fetchActiveSessions(
  repoId: number,
  params: UsageAnalyticsQueryParams,
): Promise<ActiveSessionsResponse> {
  return fetchUsageAnalytics(repoId, 'analytics/active-sessions', params);
}

// The report routes delegate to the same services and return the same DTOs; they exist
// separately so a report keeps its own catalog entry, URL params and PDF export.

export function fetchToolAnalyticsReport(
  repoId: number,
  params: UsageAnalyticsQueryParams,
): Promise<ToolAnalyticsResponse> {
  return fetchUsageAnalytics(repoId, 'reports/tool-analytics', params);
}

export function fetchTokenUsageReport(
  repoId: number,
  params: UsageAnalyticsQueryParams,
): Promise<TokenAnalyticsResponse> {
  return fetchUsageAnalytics(repoId, 'reports/token-usage', params);
}

export function fetchProductivityCountersReport(
  repoId: number,
  params: UsageAnalyticsQueryParams,
): Promise<ProductivityAnalyticsResponse> {
  return fetchUsageAnalytics(repoId, 'reports/productivity-counters', params);
}

export function fetchActiveSessionsReport(
  repoId: number,
  params: UsageAnalyticsQueryParams,
): Promise<ActiveSessionsResponse> {
  return fetchUsageAnalytics(repoId, 'reports/active-sessions', params);
}

/** One user's row in the Claude Code Version Usage report. */
export interface ClaudeVersionUsageRow {
  userId: number;
  userEmail: string;
  /** Root sessions in range with a known version and known reference versions. */
  sessionsChecked: number;
  /** Checked sessions whose version was below the stable release at session start. */
  outdatedSessions: number;
}

export interface ClaudeVersionUsageResponse {
  rows: ClaudeVersionUsageRow[];
}

export function fetchClaudeVersionUsageReport(
  repoId: number,
  params: UsageAnalyticsQueryParams,
): Promise<ClaudeVersionUsageResponse> {
  return fetchUsageAnalytics(repoId, 'reports/claude-versions', params);
}

export interface RepoSettingsResponse {
  effectiveConfig: RepoConfig;
  teamConfig: RepoConfig | null;
  userConfig: RepoConfig | null;
  teamId: number | null;
  canEditTeamConfig: boolean;
}

/** `teamId` lets a team member read a teammate's repo through the team's access (D4.8). */
export async function fetchRepositoryDetail(
  repoId: number,
  teamId?: number,
): Promise<RepositoryDetail> {
  const query = teamId != null ? `?teamId=${teamId}` : '';
  const res = await apiFetch(`/api/v1/repositories/${repoId}${query}`);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<RepositoryDetail>;
}

/** `teamId` (team view) resolves the settings for that team; omit it in personal view. */
export async function getRepoSettings(
  repoId: number,
  teamId?: number,
): Promise<RepoSettingsResponse> {
  const query = teamId != null ? `?teamId=${teamId}` : '';
  const res = await apiFetch(`/api/v1/repositories/${repoId}/settings${query}`);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<RepoSettingsResponse>;
}

/** `teamId` (team view) writes exactly that team's config; omit it in personal view. */
export async function putTeamConfig(
  repoId: number,
  config: RepoConfig | null,
  teamId?: number,
): Promise<RepoSettingsResponse> {
  const query = teamId != null ? `?teamId=${teamId}` : '';
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/settings/team${query}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<RepoSettingsResponse>;
}

export async function putUserConfig(
  repoId: number,
  config: RepoConfig | null,
): Promise<RepoSettingsResponse> {
  const res = await apiFetch(`/api/v1/repositories/${repoId}/settings/user`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<RepoSettingsResponse>;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
}

export async function setSessionFavorite(
  repoId: number,
  sessionId: string,
  favorite: boolean,
  teamId?: number,
): Promise<{ isFavorite: boolean }> {
  const params = new URLSearchParams();
  if (teamId != null) params.set('teamId', String(teamId));
  const qs = params.toString();
  const url = qs
    ? `/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sessionId)}/favorite?${qs}`
    : `/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sessionId)}/favorite`;
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<{ isFavorite: boolean }>;
}

export interface SubagentStats {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Billed web-search requests of this child session — priced **per request**, so
   * never divided by a million and never added into a token total.
   */
  webSearchRequests: number;
  /** Fast-mode **subset** of `inputTokens`, not additional tokens. */
  inputTokensFast: number;
  /** Fast-mode **subset** of `outputTokens`, not additional tokens. */
  outputTokensFast: number;
  /**
   * Lines written by `Edit`/`Write`/`MultiEdit` in **this child's own transcript
   * only**, never including its own descendants. Summing the whole `subagentStats` map plus
   * the root's own figure therefore yields the tree total exactly once, because the map is
   * keyed by every recursive descendant (not just depth-1 children).
   *
   * Optional: absent when the client is served against a server predating tree-scoped code impact.
   */
  linesChanged?: number;
  /**
   * `Edit`/`Write`/`MultiEdit` calls in **this child's own transcript only**, never
   * including its own descendants. A count of calls, not of distinct files. Optional for the
   * same reason as {@link SubagentStats.linesChanged}.
   */
  filesEditedWritten?: number;
  /**
   * Diff-derived added lines from **this child's own transcript only**, never
   * including its own descendants. Only meaningful for the calls the transcript carried a
   * `structuredPatch` for; see {@link SubagentStats.diffLinesCoveredCalls}. Optional for the
   * same reason as {@link SubagentStats.linesChanged}.
   */
  linesAdded?: number;
  /**
   * Diff-derived removed lines from **this child's own transcript only**, never
   * including its own descendants. Optional for the same reason as
   * {@link SubagentStats.linesChanged}.
   */
  linesRemoved?: number;
  /**
   * Of this child's own `Edit`/`Write`/`MultiEdit` calls, how many carried a
   * `structuredPatch` and so contributed to `linesAdded`/`linesRemoved`. Own transcript only.
   * Optional for the same reason as {@link SubagentStats.linesChanged}.
   */
  diffLinesCoveredCalls?: number;
  /**
   * This child's own `Edit`/`Write`/`MultiEdit` call count, the denominator for
   * {@link SubagentStats.diffLinesCoveredCalls}. Own transcript only. Optional for the same
   * reason as {@link SubagentStats.linesChanged}.
   */
  diffLinesTotalCalls?: number;
}

/**
 * D1 — the root session's **own** `session_stats` productivity counters (never its
 * descendants'). The tree total is this plus the sum of every `subagentStats` entry, matching
 * the server's tree rollup.
 */
export interface SessionRootStats {
  linesChanged: number;
  filesEditedWritten: number;
  linesAdded: number;
  linesRemoved: number;
  diffLinesCoveredCalls: number;
  diffLinesTotalCalls: number;
}

/**
 * DD-1 (`docs/tasks/todo/2026-10-16-sysctx-skill-source/impl-plan.md`): the hook's self-reported
 * skill/agent/MCP/system-context inventory, read back verbatim from `harness_snapshots.body`
 * (minus its `type` discriminant). Mirrors the server's `HarnessSnapshotBody`
 * (`server/src/logs/harness-snapshot.ts`) and the hook's JSDoc `@typedef HarnessSnapshot`
 * (`harness-snapshot.js`). Kept in sync by convention — the three packages are isolated (see
 * `client.md`), so nothing imports across them.
 */
export interface HarnessSnapshotPlugin {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  gitCommitSha?: string;
}

export interface HarnessSnapshotSkill {
  /** Plugin entries are `<pluginName>:<name>` (DD-1). */
  name: string;
  kind: 'skill' | 'workflow' | 'command';
  source: 'project' | 'user' | 'plugin';
  description: string;
  argumentHint?: string;
  /** File text after frontmatter; a workflow's `body` is the whole `.js` text. */
  body: string;
  /** DD-3 path, shaped per the entry's `source`. */
  path: string;
  bytes: number;
  contentHash: string;
  plugin?: HarnessSnapshotPlugin;
}

export interface HarnessSnapshotAgent {
  name: string;
  description: string;
  body: string;
  path: string;
  bytes: number;
  contentHash: string;
  source: 'project';
}

export interface HarnessSnapshotMcpTool {
  name: string;
  schemaSizeTokens: number;
}

export interface HarnessSnapshotMcpServer {
  name: string;
  command: string;
  args: string;
  url?: string;
  configSource?: 'project' | 'user';
  /** `undefined` — the probe never ran for this snapshot (a ref-only resend). */
  connected?: boolean;
  tools?: HarnessSnapshotMcpTool[];
}

export interface HarnessSnapshotFile {
  path: string;
  bytes: number;
  contentHash: string;
  /** Rule file contents only (DD-13's `claudeMd`); other files carry no `content`. */
  content?: string;
}

export interface HarnessSnapshot {
  snapshotId: string;
  schemaVersion: number;
  /** Capability flag — explicitly NOT part of the DD-2 id. */
  perToolDetailSupported: boolean;
  skills: HarnessSnapshotSkill[];
  agents: HarnessSnapshotAgent[];
  mcpServers: HarnessSnapshotMcpServer[];
  systemContext: { totalBytes: number; files: HarnessSnapshotFile[] } | null;
}

export interface SessionLogsData {
  main: Record<string, unknown>[];
  subagents: {
    sessionId: string;
    /**
     * The true immediate parent session/agent's `session_id` (e.g. "agent-abc123" or the root
     * session id), or null for a depth-1 agent whose parent row predates parent linkage. This is
     * DB-authoritative (from `sessions.parent_session_id`) — a sub-agent spawned in the
     * background by another sub-agent may never write a completion event with its own agentId
     * back into its parent's own transcript once the parent session ends, so transcript content
     * (agent_progress / tool_use+toolUseResult) cannot reliably reconstruct nesting beyond depth
     * 1. Use this field, not transcript heuristics, to build the real descendant tree.
     */
    parentSessionId: string | null;
    logs: Record<string, unknown>[];
  }[];
  /** Token totals from session_stats for each child session, keyed by sessionId (e.g. "agent-abc123"). */
  subagentStats?: Record<string, SubagentStats>;
  /**
   * D1 — the root session's own diff/productivity counters; `null` when the root has no
   * qualifying `session_stats` row (rendered as "no diff data").
   */
  rootStats: SessionRootStats | null;
  /** Workflow runs extracted from the claude log on the server. */
  workflows?: WorkflowRun[];
  /**
   * The latest submitted Turn-End Cost Advisor result for this session, read
   * straight off `getSessionLogs()` (no separate session-detail cost/advisor
   * endpoint). `null` when the session has never had a successful evaluation (feature off,
   * below the cost threshold, still pending, or every attempt so far failed) — the Advisor tab
   * itself is hidden in that case rather than rendered empty.
   */
  turnEndAdvisor?: {
    generatedAt: string;
    summaryGeneral: string;
    costFactors: string[];
    harnessAdvice: string[];
    model: string | null;
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } | null;
  /**
   * Everything the session detail attribution row needs to derive
   * its state (feature off -> failed -> unevaluated -> stale -> evaluated, in that priority
   * order) without an extra fetch. `values` is already orphan-stripped server-side.
   * `evaluatedWatermark` is the watermark `values` was last written at (`null`
   * if never evaluated); `currentWatermark` is the latest prompt watermark the server has
   * observed for this session (`null` if the combined config GET has never run for it yet) —
   * `currentWatermark > evaluatedWatermark` is the client-side "stale" signal.
   */
  sessionAttribution?: {
    enabled: boolean;
    attributes: SessionAttributionAttributeDef[];
    values: SessionAttributionValues | null;
    evaluatedWatermark: number | null;
    currentWatermark: number | null;
    lastRun: SessionAttributionLastRun | null;
  };
  /**
   * DD-12: the root session's bound harness snapshot, loaded server-side from
   * `harness_snapshots.body`. `null` when the session has no bound snapshot (old hook, or never
   * uploaded) or the owning user's row is gone — there is no fallback or backfill (DD-17).
   */
  harnessSnapshot?: HarnessSnapshot | null;
}

export async function fetchSessionLogs(
  repoId: number,
  sessionId: string,
  teamId?: number,
): Promise<SessionLogsData> {
  const url = teamId
    ? `/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sessionId)}/logs?teamId=${teamId}`
    : `/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sessionId)}/logs`;
  const res = await apiFetch(url);
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as SessionLogsData;
}

export interface ExportScopeFilters {
  teamId?: number;
  /** ISO 8601 date-time, inclusive lower bound on session start time. */
  from: string;
  /** ISO 8601 date-time, inclusive upper bound on session start time. */
  to: string;
  userId?: number;
}

export interface ExportScopeSession {
  sessionId: string;
  firstPrompt: string | null;
  startTime: string;
  endTime: string;
  userId: number;
  userEmail: string;
}

/**
 * Lists sessions in scope for the "Session Statistics Export" feature. Privileged —
 * only the repo's owner (personal view) or the team owner (team view) may call
 * this; the result bypasses the per-team access-mode restriction that the ordinary session-list
 * endpoint enforces, though it still excludes members who have not acknowledged the disclosure.
 */
export async function fetchSessionsExportScope(
  repoId: number,
  filters: ExportScopeFilters,
): Promise<ExportScopeSession[]> {
  const params = new URLSearchParams();
  if (filters.teamId != null) params.set('teamId', String(filters.teamId));
  params.set('from', filters.from);
  params.set('to', filters.to);
  if (filters.userId != null) params.set('userId', String(filters.userId));
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/sessions/export-scope?${params.toString()}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<ExportScopeSession[]>;
}

export interface RecomputeAllSessionsResult {
  recomputed: number;
}

/**
 * Recomputes `session_file_stats` (scoped) and `session_stats` (unscoped) for every
 * session in this repo. Privileged — same authorization shape as
 * {@link fetchSessionsExportScope}: the repo's owner (personal view) or the team
 * owner (team view).
 */
export async function recomputeAllSessions(
  repoId: number,
  teamId?: number,
): Promise<RecomputeAllSessionsResult> {
  const url = teamId
    ? `/api/v1/repositories/${repoId}/recompute-all-sessions?teamId=${teamId}`
    : `/api/v1/repositories/${repoId}/recompute-all-sessions`;
  const res = await apiFetch(url, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<RecomputeAllSessionsResult>;
}

// Repository Export/Import

export interface ExportImportScopeFilters {
  from?: string;
  to?: string;
  sessionIds?: string[];
}

function buildExportImportScopeQuery(
  teamId: number | undefined,
  scope: ExportImportScope,
  filters: ExportImportScopeFilters,
): string {
  const params = new URLSearchParams();
  if (teamId != null) params.set('teamId', String(teamId));
  params.set('scope', scope);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.sessionIds && filters.sessionIds.length > 0) {
    params.set('sessionIds', filters.sessionIds.join(','));
  }
  return params.toString();
}

/** `GET :repoId/export-import/scope` — session count + approximate
 * uncompressed size preview for a scope, without creating a job row. */
export async function getExportScopeSummary(
  repoId: number,
  teamId: number | undefined,
  scope: ExportImportScope,
  filters: ExportImportScopeFilters = {},
): Promise<ExportScopeSummary> {
  const qs = buildExportImportScopeQuery(teamId, scope, filters);
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/export-import/scope?${qs}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<ExportScopeSummary>;
}

/** `POST :repoId/export` — starts a background export job; returns
 * immediately (202) with the job id to poll. */
export async function startExport(
  repoId: number,
  params: {
    teamId?: number;
    scope: ExportImportScope;
    from?: string;
    to?: string;
    sessionIds?: string[];
    description?: string;
  },
): Promise<{ jobId: string }> {
  const res = await apiFetch(`/api/v1/repositories/${repoId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<{ jobId: string }>;
}

/** `GET :repoId/export/:jobId/status` — polls an in-progress/finished export
 * job (see {@link useExportImportJobPoll}). */
export async function getExportJobStatus(
  repoId: number,
  jobId: string,
  teamId?: number,
): Promise<ExportImportJobStatus> {
  const qs = teamId != null ? `?teamId=${teamId}` : '';
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/export/${jobId}/status${qs}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<ExportImportJobStatus>;
}

/** `GET :repoId/export/:jobId/download` — streams the finished export zip
 * and triggers a browser download (blob-download pattern, mirrors
 * {@link downloadLogsArchive}). Server-side, this also unlinks the zip and
 * removes the job row once the stream completes. */
export async function downloadExportZip(
  repoId: number,
  jobId: string,
  teamId?: number,
): Promise<void> {
  const qs = teamId != null ? `?teamId=${teamId}` : '';
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/export/${jobId}/download${qs}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const fileName =
    /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? 'export.zip';

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** `POST :repoId/import/upload` — multipart upload of an export zip; returns
 * the staged upload's preview summary (session count/size/meta.json) for
 * confirmation before {@link confirmImport} actually writes anything. Throws
 * `ApiError` with status 422 on a malformed/unsupported zip. */
export async function uploadImportZip(
  repoId: number,
  file: File,
  teamId?: number,
): Promise<ImportUploadSummary> {
  const qs = teamId != null ? `?teamId=${teamId}` : '';
  const formData = new FormData();
  formData.append('file', file);
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/import/upload${qs}`,
    { method: 'POST', body: formData },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<ImportUploadSummary>;
}

/** `POST :repoId/import/:uploadToken/confirm` — confirms a previously staged
 * upload; starts the background import job and returns immediately (202)
 * with the job id to poll. */
export async function confirmImport(
  repoId: number,
  uploadToken: string,
  teamId?: number,
): Promise<{ jobId: string }> {
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/import/${uploadToken}/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(teamId != null ? { teamId } : {}),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<{ jobId: string }>;
}

/** `GET :repoId/import/:jobId/status` — polls an in-progress/finished import
 * job (see {@link useExportImportJobPoll}). */
export async function getImportJobStatus(
  repoId: number,
  jobId: string,
  teamId?: number,
): Promise<ExportImportJobStatus> {
  const qs = teamId != null ? `?teamId=${teamId}` : '';
  const res = await apiFetch(
    `/api/v1/repositories/${repoId}/import/${jobId}/status${qs}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<ExportImportJobStatus>;
}

/** `POST bootstrap-import/upload` — like {@link uploadImportZip}, but with no
 * existing target repoId: the zip's own `meta.sourceRepoUrl` is what
 * ultimately decides the target repo (resolved/created at confirm time).
 * Lets a session archive be imported onto an empty server or into a
 * brand-new personal repo. Throws `ApiError` with status 422 on a
 * malformed/unsupported zip. */
export async function uploadBootstrapImportZip(
  file: File,
): Promise<ImportUploadSummary> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await apiFetch('/api/v1/repositories/bootstrap-import/upload', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<ImportUploadSummary>;
}

/** `POST bootstrap-import/:uploadToken/confirm` — confirms a previously
 * staged bootstrap upload; resolves/creates the target personal repo from the
 * zip's `meta.sourceRepoUrl`, starts the background import job, and returns
 * immediately (202) with the job id to poll plus the (possibly newly
 * created) target repoId and the (possibly newly created/reused) owning
 * teamId. */
export async function confirmBootstrapImport(
  uploadToken: string,
): Promise<{ jobId: string; repoId: number; teamId: number }> {
  const res = await apiFetch(
    `/api/v1/repositories/bootstrap-import/${uploadToken}/confirm`,
    { method: 'POST' },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<{
    jobId: string;
    repoId: number;
    teamId: number;
  }>;
}

/** `GET bootstrap-import/:jobId/status` — polls an in-progress/finished
 * bootstrap import job (see {@link useExportImportJobPoll}). */
export async function getBootstrapImportJobStatus(
  jobId: string,
): Promise<BootstrapImportJobStatus> {
  const res = await apiFetch(
    `/api/v1/repositories/bootstrap-import/${jobId}/status`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<BootstrapImportJobStatus>;
}

// Teams

export async function fetchTeams(): Promise<Team[]> {
  const res = await apiFetch('/api/v1/teams');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<Team[]>;
}

export async function createTeam(name: string): Promise<Team> {
  const res = await apiFetch('/api/v1/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.status === 201) return res.json() as Promise<Team>;
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new ApiError(res.status, body.message ?? '');
}

export async function deleteTeam(teamId: number): Promise<void> {
  const res = await apiFetch(`/api/v1/teams/${teamId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new ApiError(res.status);
}

export async function fetchTeamMembers(teamId: number): Promise<TeamMember[]> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/members`);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<TeamMember[]>;
}

/**
 * Partial update of one member's role flags. Every field is optional — the
 * server rejects an empty body with 400 — so a caller toggling `isManager`
 * never has to restate `canInvite`.
 */
export async function updateTeamMember(
  teamId: number,
  userId: number,
  flags: {
    canInvite?: boolean;
    isManager?: boolean;
    isAdlcTrainer?: boolean;
  },
): Promise<void> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flags),
  });
  if (!res.ok) throw new ApiError(res.status);
}

/**
 * Switches the team's access mode. Throws `ApiError(409)` carrying the server's
 * message when the team still has members besides the owner and the caller is
 * asking for `transparent` — the privacy promise those members joined under
 * cannot be revoked.
 */
export async function updateTeamAccessMode(
  teamId: number,
  accessMode: TeamAccessMode,
): Promise<Team> {
  const res = await apiFetch(`/api/v1/teams/${teamId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessMode }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<Team>;
}

/**
 * Teams the caller was added to without an Accept step and has never
 * acknowledged the access-mode disclosure for. Drives the login-time
 * disclosure gate.
 */
export async function fetchPendingDisclosures(): Promise<PendingDisclosure[]> {
  const res = await apiFetch('/api/v1/teams/pending-disclosures');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<PendingDisclosure[]>;
}

/**
 * Records that the caller read the disclosure for `teamId`.
 * `acknowledgedAccessMode` is the mode the modal actually described; the server
 * answers 400 when it no longer matches the team's live mode, so a stale modal
 * can never consent to the wrong contract.
 */
export async function acknowledgeTeamDisclosure(
  teamId: number,
  acknowledgedAccessMode: TeamAccessMode,
): Promise<void> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/acknowledge-disclosure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acknowledgedAccessMode }),
  });
  if (!res.ok) throw await readApiError(res);
}

export async function removeTeamMember(
  teamId: number,
  userId: number,
): Promise<void> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/members/${userId}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) throw new ApiError(res.status);
}

export async function leaveTeam(teamId: number): Promise<void> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/leave`, {
    method: 'POST',
  });
  if (!res.ok && res.status !== 204) throw new ApiError(res.status);
}

export async function transferTeamOwnership(
  teamId: number,
  userId: number,
): Promise<void> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new ApiError(res.status);
}

export async function fetchTeamRepositories(
  teamId: number,
): Promise<TeamRepository[]> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/repositories`);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<TeamRepository[]>;
}

export async function addTeamRepository(
  teamId: number,
  repoUrl: string,
): Promise<TeamRepository> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<TeamRepository>;
}

export async function removeTeamRepository(
  teamId: number,
  repoId: number,
): Promise<void> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/repositories/${repoId}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
}

export async function unlinkTeamRepository(
  teamId: number,
  repoId: number,
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/teams/${teamId}/repositories/${repoId}/link`,
    {
      method: 'DELETE',
    },
  );
  if (!res.ok && res.status !== 204) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
}

export async function sendInvitation(
  teamId: number,
  email: string,
  force?: boolean,
): Promise<Invitation> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, force: force ?? false }),
  });
  if (!res.ok) {
    throw await readApiError(res);
  }
  return res.json() as Promise<Invitation>;
}

export async function cancelInvitation(
  teamId: number,
  invId: number,
): Promise<void> {
  const res = await apiFetch(`/api/v1/teams/${teamId}/invitations/${invId}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) throw new ApiError(res.status);
}

export async function fetchMyInvitations(): Promise<Invitation[]> {
  const res = await apiFetch('/api/v1/invitations');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<Invitation[]>;
}

/**
 * `acknowledgedAccessMode` is required by the server on `action: 'accept'` (400
 * when absent) and must still match the team's live mode — the invitee consents
 * to the contract the disclosure modal showed them, not to whatever the team
 * has drifted to since. It is ignored on `action: 'decline'`.
 */
export async function respondToInvitation(
  invId: number,
  action: 'accept' | 'decline',
  acknowledgedAccessMode?: TeamAccessMode,
): Promise<void> {
  const res = await apiFetch(`/api/v1/invitations/${invId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      acknowledgedAccessMode === undefined
        ? { action }
        : { action, acknowledgedAccessMode },
    ),
  });
  // readApiError (not a bare ApiError) so the caller can show the server's
  // reason — "Invitation is no longer pending", "Not your invitation".
  if (!res.ok) throw await readApiError(res);
}

// Admin

export async function fetchAdminRepos(): Promise<AdminRepo[]> {
  const res = await apiFetch('/api/v1/admin/repos');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<AdminRepo[]>;
}

export async function removeAdminRepo(repoId: number): Promise<void> {
  const res = await apiFetch(`/api/v1/admin/repos/${repoId}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
}

/** Deletes an orphan team link (no `repositories` row for its URL); 404 otherwise. */
export async function removeAdminOrphanTeamRepo(
  teamRepoId: number,
): Promise<void> {
  const res = await apiFetch(`/api/v1/admin/team-repos/${teamRepoId}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
}

export async function fetchAdminTeams(): Promise<AdminTeam[]> {
  const res = await apiFetch('/api/v1/admin/teams');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<AdminTeam[]>;
}

export async function fetchAdminTeamMembers(
  teamId: number,
): Promise<AdminTeamMember[]> {
  const res = await apiFetch(`/api/v1/admin/teams/${teamId}/members`);
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<AdminTeamMember[]>;
}

/** FR-8 "Set new owner" — the new owner must already be a team member (400 otherwise). */
export async function setAdminTeamOwner(
  teamId: number,
  userId: number,
): Promise<void> {
  const res = await apiFetch(`/api/v1/admin/teams/${teamId}/owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const res = await apiFetch('/api/v1/admin/users');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<AdminUser[]>;
}

export async function fetchSystemInfo(): Promise<SystemInfo> {
  const res = await apiFetch('/api/v1/admin/system');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<SystemInfo>;
}

export async function fetchDataRetention(): Promise<DataRetentionStats> {
  const res = await apiFetch('/api/v1/admin/retention');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<DataRetentionStats>;
}

export async function fetchErrorLogs(): Promise<{
  entries: ErrorLogEntry[];
}> {
  const res = await apiFetch('/api/v1/admin/error-logs');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<{ entries: ErrorLogEntry[] }>;
}

export async function downloadLogsArchive(): Promise<void> {
  const res = await apiFetch('/api/v1/admin/logs-archive');
  if (!res.ok) throw new ApiError(res.status);

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const fileName = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? 'logs.zip';

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function fetchAdminUploadQueue(): Promise<UploadQueueEntry[]> {
  const res = await apiFetch('/api/v1/admin/upload-queue');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<UploadQueueEntry[]>;
}

export async function fetchAdminUploadQueueStats(): Promise<UploadQueueStats> {
  const res = await apiFetch('/api/v1/admin/upload-queue/stats');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<UploadQueueStats>;
}

export async function downloadUploadQueueFile(
  id: number,
  fallbackFileName: string,
): Promise<void> {
  const res = await apiFetch(`/api/v1/admin/upload-queue/${id}/file`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const fileName =
    /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? fallbackFileName;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function clearBrokenUploadQueueEntries(): Promise<{
  deletedCount: number;
}> {
  const res = await apiFetch('/api/v1/admin/upload-queue/failed', {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<{ deletedCount: number }>;
}

export async function reprocessFailedUploadQueueEntries(): Promise<{
  updatedCount: number;
}> {
  const res = await apiFetch('/api/v1/admin/upload-queue/reprocess-failed', {
    method: 'POST',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<{ updatedCount: number }>;
}

export async function updateAdminUserRole(
  userId: number,
  role: 'admin' | 'user',
): Promise<AdminUser> {
  const res = await apiFetch(`/api/v1/admin/users/${userId}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<AdminUser>;
}

/**
 * Throws an `ApiError` carrying the server's `message` for a non-2xx admin model-pricing
 * response — the same error shape `updateAdminUserRole` produces.
 */
async function throwAdminModelPricingError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new ApiError(res.status, body.message ?? '');
}

/** Admin model-pricing table: every known model with its resolved source and both fetch statuses. */
export async function fetchAdminModelPricing(): Promise<AdminModelPricingResponse> {
  const res = await apiFetch('/api/v1/admin/model-pricing');
  if (!res.ok) return throwAdminModelPricingError(res);
  return res.json() as Promise<AdminModelPricingResponse>;
}

/** Sets a manual price for an unpriced or manually priced model (409 for any other state). */
export async function setAdminModelPrice(
  input: ModelPriceInput,
): Promise<AdminModelPricingRow> {
  const res = await apiFetch('/api/v1/admin/model-pricing/price', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return throwAdminModelPricingError(res);
  return res.json() as Promise<AdminModelPricingRow>;
}

/** Sets or edits the override on a fetched/imported model (409 for manual or unpriced models). */
export async function setAdminModelOverride(
  input: ModelPriceInput,
): Promise<AdminModelPricingRow> {
  const res = await apiFetch('/api/v1/admin/model-pricing/override', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return throwAdminModelPricingError(res);
  return res.json() as Promise<AdminModelPricingRow>;
}

/**
 * Clears an active override, restoring the fetched/imported base price. The model id goes
 * in the body because ids can contain `/`.
 */
export async function clearAdminModelOverride(
  modelId: string,
): Promise<AdminModelPricingRow> {
  const res = await apiFetch('/api/v1/admin/model-pricing/override/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId }),
  });
  if (!res.ok) return throwAdminModelPricingError(res);
  return res.json() as Promise<AdminModelPricingRow>;
}

/** Runs the Anthropic pricing fetch now, outside its daily schedule. */
export async function fetchAnthropicPricingNow(): Promise<AnthropicFetchNowResult> {
  const res = await apiFetch('/api/v1/admin/model-pricing/fetch-anthropic', {
    method: 'POST',
  });
  if (!res.ok) return throwAdminModelPricingError(res);
  return res.json() as Promise<AnthropicFetchNowResult>;
}

/** Imports non-Anthropic prices from OpenRouter (502 with a message when the fetch fails). */
export async function importOpenRouterPricing(): Promise<OpenRouterImportResult> {
  const res = await apiFetch('/api/v1/admin/model-pricing/import-openrouter', {
    method: 'POST',
  });
  if (!res.ok) return throwAdminModelPricingError(res);
  return res.json() as Promise<OpenRouterImportResult>;
}

export async function renameAdminUserEmail(
  userId: number,
  email: string,
): Promise<AdminUser> {
  const res = await apiFetch(`/api/v1/admin/users/${userId}/email`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<AdminUser>;
}

/**
 * Admin-side hard delete of another user. `confirmEmail` must match
 * the target's email — the server compares it case-insensitively and rejects a
 * mismatch with 400. Answers 204 with no body on success.
 */
export async function adminDeleteUser(
  userId: number,
  confirmEmail: string,
): Promise<void> {
  const res = await apiFetch(`/api/v1/admin/users/${userId}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmEmail }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
}

export async function adminGenerateResetLink(
  userId: number,
): Promise<{ resetUrl: string }> {
  const res = await apiFetch(`/api/v1/users/${userId}/reset-password-link`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? '');
  }
  return res.json() as Promise<{ resetUrl: string }>;
}

export async function fetchAdminAuthConfig(): Promise<AdminAuthConfig> {
  const res = await apiFetch('/api/v1/admin/auth');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<AdminAuthConfig>;
}

export async function fetchPendingRegistrations(): Promise<
  PendingRegistration[]
> {
  const res = await apiFetch('/api/v1/admin/auth/pending-registrations');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<PendingRegistration[]>;
}

export async function resendPendingRegistration(
  id: number,
): Promise<{ email_delivery: 'sent' | 'failed' }> {
  const res = await apiFetch(
    `/api/v1/admin/auth/pending-registrations/${id}/resend`,
    { method: 'POST' },
  );
  if (!res.ok) throw await readApiError(res);
  return res.json() as Promise<{ email_delivery: 'sent' | 'failed' }>;
}

export async function revokePendingRegistration(id: number): Promise<void> {
  const res = await apiFetch(`/api/v1/admin/auth/pending-registrations/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) throw await readApiError(res);
}

// User settings — generic per-user key/value store, always scoped to the
// current session user. The server never interprets a name or a value.

export async function fetchUserSettings(): Promise<UserSetting[]> {
  const res = await apiFetch('/api/v1/user-settings');
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<UserSetting[]>;
}

export async function saveUserSetting(
  name: string,
  value: string,
): Promise<UserSetting> {
  const res = await apiFetch(
    `/api/v1/user-settings/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    },
  );
  if (!res.ok) throw await readApiError(res);
  return res.json() as Promise<UserSetting>;
}

export async function fetchRetentionDays(): Promise<number> {
  const res = await apiFetch('/api/v1/sessions/retention-days');
  if (!res.ok) throw new ApiError(res.status);
  const body = (await res.json()) as { retentionDays: number };
  return body.retentionDays;
}
