import { IsIn, IsOptional } from 'class-validator';

export class UpdateInvitationDto {
  @IsIn(['accept', 'decline'])
  action: 'accept' | 'decline';

  /**
   * The access mode the invitee was actually shown when they ticked the
   * disclosure checkbox. Required on `action: 'accept'` and validated against
   * the team's live `access_mode`, so a stale invitation
   * card cannot consent to a contract that no longer applies.
   */
  @IsOptional()
  @IsIn(['transparent', 'restricted'])
  acknowledgedAccessMode?: 'transparent' | 'restricted';
}
