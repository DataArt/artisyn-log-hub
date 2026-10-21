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
