import { IsIn } from 'class-validator';

export class AcknowledgeDisclosureDto {
  /**
   * The access mode the member was shown in the access-mode disclosure modal.
   * Validated against the team's live `access_mode` so a stale modal cannot
   * acknowledge a contract that no longer applies.
   */
  @IsIn(['transparent', 'restricted'])
  acknowledgedAccessMode: 'transparent' | 'restricted';
}
