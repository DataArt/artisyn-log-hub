import { IsBoolean, IsEmail, IsOptional } from 'class-validator';

export class InviteMemberDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
