import type { TeamMember } from '../../../../../models/teams';
import {
  AWAITING_DISCLOSURE_LABEL,
  OWNER_ROLES_NA_LABEL,
  ROLE_COLUMN_LABELS,
} from '../../../../lib/access-mode-copy';
import { Button } from '../../../../ui/button';

/** Flags `PATCH /teams/:teamId/members/:userId` accepts — all optional. */
export interface MemberRoleFlags {
  canInvite?: boolean;
  isManager?: boolean;
  isAdlcTrainer?: boolean;
}

interface TeamMemberRowProps {
  member: TeamMember;
  /** Only the team owner may assign roles (no admin bypass). */
  canEditRoles: boolean;
  canRemove: boolean;
  /**
   * `disclosureAcknowledgedAt` is only meaningful for the team owner; every
   * other caller gets `null` regardless,
   * so the marker must not be rendered for them.
   */
  showDisclosureState: boolean;
  onToggleRole: (userId: number, flags: MemberRoleFlags) => void;
  onRemove: (member: TeamMember) => void;
}

/** The three owner-only checkbox columns, in wireframe order. */
const ROLE_COLUMNS: {
  key: keyof MemberRoleFlags;
  label: string;
  width: string;
}[] = [
  { key: 'canInvite', label: ROLE_COLUMN_LABELS.canInvite, width: 'w-24' },
  { key: 'isManager', label: ROLE_COLUMN_LABELS.manager, width: 'w-24' },
  {
    key: 'isAdlcTrainer',
    label: ROLE_COLUMN_LABELS.adlcTrainer,
    width: 'w-28',
  },
];

/** Header strip aligning the owner-only role columns above the member rows. */
export function TeamMemberRolesHeader() {
  return (
    <li className="flex items-center gap-2 px-3 text-[10px] font-medium tracking-wide text-muted-foreground">
      <span className="flex-1" />
      {ROLE_COLUMNS.map((col) => (
        <span key={col.key} className={`${col.width} shrink-0 text-center`}>
          {col.label}
        </span>
      ))}
      <span className="w-20 shrink-0" />
    </li>
  );
}

export function TeamMemberRow({
  member,
  canEditRoles,
  canRemove,
  showDisclosureState,
  onToggleRole,
  onRemove,
}: TeamMemberRowProps) {
  const roleWords = [
    member.canInvite && !member.isOwner ? 'Can invite' : null,
    member.isManager ? 'Manager' : null,
    member.isAdlcTrainer ? 'ADLC trainer' : null,
  ].filter((w): w is string => w !== null);

  const awaitingDisclosure =
    showDisclosureState &&
    !member.isOwner &&
    member.disclosureAcknowledgedAt === null;

  return (
    <li className="flex items-center gap-2 p-3 border border-border rounded-md bg-card">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{member.email}</p>
        <p className="text-xs text-muted-foreground">
          {[member.isOwner ? 'Owner' : 'Member', ...roleWords].join(' · ')}
          {awaitingDisclosure && (
            <span className="ml-2 text-amber-700">
              {AWAITING_DISCLOSURE_LABEL}
            </span>
          )}
        </p>
      </div>

      {canEditRoles &&
        (member.isOwner ? (
          <span className="w-[19rem] shrink-0 text-center text-xs text-muted-foreground">
            {OWNER_ROLES_NA_LABEL}
          </span>
        ) : (
          ROLE_COLUMNS.map((col) => (
            <span
              key={col.key}
              className={`${col.width} shrink-0 text-center leading-none`}
            >
              <input
                type="checkbox"
                className="cursor-pointer"
                aria-label={`${col.label} — ${member.email}`}
                checked={member[col.key]}
                onChange={(e) => {
                  // Send only the flag that actually changed: the PATCH body is
                  // fully optional, so an untouched role is never restated.
                  const flags: MemberRoleFlags = {};
                  flags[col.key] = e.target.checked;
                  onToggleRole(member.userId, flags);
                }}
              />
            </span>
          ))
        ))}

      <span className="w-20 shrink-0 text-right">
        {canRemove && !member.isOwner && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive text-xs"
            onClick={() => onRemove(member)}
          >
            Remove
          </Button>
        )}
      </span>
    </li>
  );
}
