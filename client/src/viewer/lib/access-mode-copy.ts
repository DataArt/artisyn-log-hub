/**
 * Every user-facing literal and badge colour the team access-mode feature
 * introduces. Components render from here and the unit
 * tests assert against the same constants, so the copy assertions can
 * never drift from what is actually on screen.
 */
import type { TeamAccessMode } from '../../models/teams';

/**
 * Rendered wherever a `firstPrompt` comes back `null`. In a team-scoped view a
 * null prompt can only mean masking — every listed session passed the
 * `first_prompt IS NOT NULL` root-session discriminator server-side.
 */
export const PROMPT_HIDDEN_LABEL = 'Prompt hidden';

export const RESTRICTED_SESSIONS_NOTICE =
  'Restricted team — you see only your own sessions';

export const ACCESS_MODE_LABEL: Record<TeamAccessMode, string> = {
  restricted: 'Restricted',
  transparent: 'Transparent',
};

/**
 * Follows the `RepositoryHeader.tsx` precedent (a literal colour pair) rather
 * than a `Badge` cva variant — these two modes are not a reusable scale.
 */
export const ACCESS_MODE_BADGE_CLASS: Record<TeamAccessMode, string> = {
  restricted: 'bg-amber-600 text-white',
  transparent: 'bg-blue-600 text-white',
};

export const ACCESS_MODE_TOOLTIP_ANALYTICS =
  'Analytics and reports: owner and managers only';

export const AWAITING_DISCLOSURE_LABEL = 'awaiting disclosure';

export const OWNER_ROLES_NA_LABEL = 'sees everything — roles not applicable';

export const transparentLockNote = (n: number) =>
  `This team has ${n} member${n === 1 ? '' : 's'} besides you. They joined under the restricted privacy promise and it cannot be revoked.`;

export const DISCLOSURE_RESTRICTED_BULLETS = [
  'The team owner can read all of your sessions, including your prompts.',
  'Any member holding the ADLC trainer role can read all of your sessions, including your prompts — now and for everything you have already written.',
  'A member holding the manager role sees your sessions and their statistics, but never your prompt text.',
  'No other team member sees your sessions at all.',
  'Application administrators get no access through their admin role — only through a role they hold in this team.',
];

export const DISCLOSURE_TRANSPARENT_BULLETS = [
  'Every member of this team can read all of your sessions, including your prompts.',
  'You can read every other member’s sessions and prompts on the same terms.',
];

export const DISCLOSURE_ALWAYS_VISIBLE_LINE =
  'Your sessions stay visible to you at all times.';

export const DISCLOSURE_RESTRICTED_CHECKBOX =
  'I have read and understood who can see my prompts in this team';

export const DISCLOSURE_TRANSPARENT_CHECKBOX =
  'I have read and understood this.';

/** The four-row helper table under the member list. */
export const ROLE_HELP_ROWS: [string, string][] = [
  [
    'Team owner',
    'All members’ sessions and prompts, plus analytics and reports.',
  ],
  [
    'ADLC trainer',
    'All members’ sessions and prompts. No analytics or reports.',
  ],
  [
    'Manager',
    'Analytics and reports at full team scope, and all members’ sessions — never their prompts.',
  ],
  ['Member', 'Their own sessions only. No analytics or reports.'],
];

/** Heading of the owner-only mode control on the Members tab. */
export const ACCESS_MODE_SECTION_TITLE = 'Team access mode';

export const ACCESS_MODE_SECTION_HINT =
  'Controls what members can see of each other’s work.';

/** The body copy of the two selectable mode cards. */
export const ACCESS_MODE_DESCRIPTION: Record<TeamAccessMode, string> = {
  restricted:
    'Members see only their own sessions and prompts. Owner and ADLC trainers see everything; analytics and reports go to owner and managers only.',
  transparent:
    'Every member sees every other member’s sessions, prompts, analytics and reports — today’s behaviour.',
};

/** Shown inside the Transparent card while the members lock applies. */
export const TRANSPARENT_DISABLED_NOTE =
  'Not selectable while the team has members other than the owner.';

/** Heading of the role-explanation helper table under the member list. */
export const ROLE_HELP_TITLE = 'What each role grants in a restricted team';

/** Column headers of the owner-only role checkboxes on the member rows. */
export const ROLE_COLUMN_LABELS = {
  canInvite: 'CAN INVITE',
  manager: 'MANAGER',
  adlcTrainer: 'ADLC TRAINER',
} as const;
