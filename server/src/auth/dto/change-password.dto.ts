import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;

  // Strength is policy-driven — see applyPasswordPolicy(), called from
  // AuthService.changePassword.
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  @IsString()
  @IsNotEmpty()
  passwordConfirm: string;
}
