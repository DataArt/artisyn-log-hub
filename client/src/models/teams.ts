import type {
  OtelCallsFilter,
  OtelCoverage,
  OtelInterval,
  OtelRepoKpis,
  RepoOtelFactsResponse,
} from './repositories';

/**
 * How much of each other's work the members of a team can see.
 *
 * - `transparent` — every member reads every other member's sessions and
 *   prompts (the old `allowMemberSessionVisibility = true`).
 * - `restricted` — the default; only the owner, an ADLC trainer (prompts
 *   included) and a manager (prompts excluded) reach beyond their own sessions.
 */
export type TeamAccessMode = 'transparent' | 'restricted';

export interface Team {
  id: number;
  name: string;
  ownerId: number;
  createdAt: string;
  isMember: boolean;
  accessMode: TeamAccessMode;
  /** The *caller's* role flags on this team — false when not a member. */
  myIsManager: boolean;
  myIsAdlcTrainer: boolean;
}

export interface TeamMember {
  userId: number;
  email: string;
  canInvite: boolean;
  joinedAt: string;
  isOwner: boolean;
  isManager: boolean;
  isAdlcTrainer: boolean;
  /**
   * When this member acknowledged the access-mode disclosure. Returned
   * verbatim only to the team owner; `null` for every other
   * caller, so a null here is "unknown" as often as it is
   * "not yet acknowledged".
   */
  disclosureAcknowledgedAt: string | null;
}

export interface TeamRepository {
  id: number;
  teamId: number;
  repositoryId: number | null;
  repoUrl: string;
  addedAt: string;
  sessionCount: number;
}

export interface Invitation {
  id: number;
  teamId: number;
  /**
   * Only GET /api/v1/invitations joins the team in; the row returned by
   * POST /api/v1/teams/:teamId/invitations carries the invitations columns
   * alone (same reason `inviteeEmail` can be missing there).
   */
  teamName?: string;
  inviterId: number;
  inviteeId: number;
  inviteeEmail: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  createdAt: string;
  /**
   * The team's live access mode, joined in by GET /api/v1/invitations so the
   * invitee reads the right disclosure before accepting. Absent on the row
   * returned by POST /teams/:teamId/invitations, for the reason above.
   */
  accessMode?: TeamAccessMode;
  /** True when at least one member of the team holds the ADLC trainer role. */
  hasTrainer?: boolean;
}

/**
 * A team the caller was added to without an "Accept" step (force-invite or
 * `addMemberIfRealUser`) and has never acknowledged the disclosure for.
 * Returned by GET /api/v1/teams/pending-disclosures and shown as a modal at
 * login time.
 */
export interface PendingDisclosure {
  teamId: number;
  teamName: string;
  accessMode: TeamAccessMode;
  hasTrainer: boolean;
}

// --- Team OTEL tab (2026-10-30 otel-tabs-traces, DD-29) ---------------------------

/** `stackBy` of the team facts route: person = user id keys, repository = repository id keys. */
export type TeamOtelStackBy =
  | 'person'
  | 'repository'
  | 'structure'
  | 'model'
  | 'querySource';

export interface OtelTeamKpis extends OtelRepoKpis {
  /** Total / active people; null without people. */
  perActivePersonCostUsdMicros: string | null;
  repositories: number;
  repositoriesLive: number;
}

export interface OtelTeamPersonRow {
  userId: number;
  email: string;
  sessions: number;
  costUsdMicros: string;
  hiddenCostUsdMicros: string;
  inputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  models: string[];
  /** How many of the team's repositories the person has sessions in. */
  repositories: number;
  live: boolean;
  /** Cost per bucket start, in USD, oldest first. */
  trend: number[];
}

export interface OtelTeamRepositoryRow {
  /** The team repository id (`routes.teamRepo`). */
  repoId: number;
  repoUrl: string;
  people: number;
  /** A session linked to two team repositories counts in each. */
  sessions: number;
  costUsdMicros: string;
  hiddenCostUsdMicros: string;
  liveSessions: number;
}

/** `GET /api/v1/teams/:teamId/otel/facts` (DD-29). */
export interface TeamOtelFactsResponse extends Omit<
  RepoOtelFactsResponse,
  'sessions' | 'filterOptions' | 'kpis' | 'kpisPrev'
> {
  kpis: OtelTeamKpis;
  kpisPrev: OtelTeamKpis | null;
  /** The caller's whole visible scope, without the person / repository filters. */
  filterOptions: {
    models: string[];
    ccVersions: string[];
    people: { userId: number; email: string }[];
    repositories: { repoId: number; repoUrl: string }[];
  };
  people: OtelTeamPersonRow[];
  repositories: OtelTeamRepositoryRow[];
  /**
   * OTEL coverage of the team's roots active in the period, summed across the team's repositories
   * (2026-10-30 otel-shared-receiver, DD-29).
   */
  coverage: OtelCoverage;
}

/** Query of the team facts route. */
export interface TeamOtelFactsParams {
  teamId: number;
  /** ISO bounds, `to > from`. */
  from: string;
  to: string;
  repoIds?: number[];
  userIds?: number[];
  models?: string[];
  ccVersions?: string[];
  calls?: OtelCallsFilter;
  interval?: 'auto' | OtelInterval;
  stackBy?: TeamOtelStackBy;
  /** IANA name; the server defaults to `UTC`. */
  tz?: string;
}
