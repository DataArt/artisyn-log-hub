import { IsEmail, IsString, MaxLength } from 'class-validator';

export class SignupDto {
  @IsEmail()
  email: string;

  // Strength is policy-driven — see applyPasswordPolicy(), called from
  // AuthService.signup. @MaxLength stays as a hard sanity cap regardless of
  // the active PASSWORD_POLICY.
  @IsString()
  @MaxLength(128)
  password: string;

  @IsString()
  passwordConfirm: string;
}
