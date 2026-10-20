import { IsString, MaxLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  token: string;

  // Strength is policy-driven — see applyPasswordPolicy(), called from
  // AuthService.resetPassword.
  @IsString()
  @MaxLength(128)
  password: string;

  @IsString()
  passwordConfirm: string;
}
