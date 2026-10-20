/**
 * Team access-mode scope — the single shared vocabulary every team-scoped read path
 * uses to answer "whose sessions may this caller see, and may they see the prompts?".
 *
 * It replaces the old two-state `RepositoriesService.isTeamVisibilityEnabled(teamId)`
 * boolean (`allow_member_session_visibility`) with a three-state scope, because a
 * `restricted` team now has a middle role — `manager` — that sees every member's
 * sessions and their statistics but never their prompt text.
 *
 * Resolution lives in `RepositoriesService.resolveTeamScope()`; this module only owns
 * the types and the one pure helper both the controllers and the services share.
 */

/** The team's privacy contract. Mirrors the `team_access_mode` Postgres enum. */
export type TeamAccessMode = 'transparent' | 'restricted';

/**
 * How wide the caller's row visibility is, and whether prompts come with it.
 *
 * - `own-only` — only the caller's own sessions (plain member, non-member reaching in,
 *   and the personal, non-team view).
 * - `team-no-prompts` — every visible member's sessions, with `first_prompt` masked to
 *   `null` on rows the caller does not own (`manager` in a `restricted` team).
 * - `team-with-prompts` — every visible member's sessions with their prompts (team
 *   owner or `adlc trainer` in a `restricted` team; everyone in a `transparent` team).
 */
export type TeamVisibilityScope =
  | 'own-only'
  | 'team-no-prompts'
  | 'team-with-prompts';

export interface TeamScope {
  accessMode: TeamAccessMode;
  visibility: TeamVisibilityScope;
  /** Row filter on `logs.user_id`. `null` = emit no user predicate at all. */
  visibleUserIds: number[] | null;
  /** `false` ⇒ analytics/report routes throw 403 when `teamId` is present. */
  analyticsAllowed: boolean;
  isTeamOwner: boolean;
  isManager: boolean;
  isAdlcTrainer: boolean;
}

/**
 * Masks another member's prompt for a `team-no-prompts` caller (a `manager`).
 *
 * **Masking happens here, in the projection — never in a SQL `WHERE`.**
 * `l.first_prompt IS NOT NULL` is the root-session discriminator at 20+ query sites;
 * nulling the column in a filter instead of in the response row would silently delete
 * whole sessions from a manager's lists rather than merely hiding their text.
 *
 * The caller's own rows are never masked, and a row whose owner cannot be determined
 * (`null`/`undefined` `rowUserId`) is masked rather than leaked.
 *
 * @param scope the caller's resolved team scope
 * @param requesterUserId the calling user's `users.id`
 * @param rowUserId the `logs.user_id` that produced the row
 * @param value the row's `first_prompt`
 */
export function maskFirstPrompt(
  scope: TeamScope,
  requesterUserId: number,
  rowUserId: number | null | undefined,
  value: string | null,
): string | null {
  return scope.visibility === 'team-no-prompts' && rowUserId !== requesterUserId
    ? null
    : value;
}
