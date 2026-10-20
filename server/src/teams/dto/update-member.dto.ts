import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateMemberDto {
  @IsOptional()
  @IsBoolean()
  canInvite?: boolean;

  @IsOptional()
  @IsBoolean()
  isManager?: boolean;

  @IsOptional()
  @IsBoolean()
  isAdlcTrainer?: boolean;
}
