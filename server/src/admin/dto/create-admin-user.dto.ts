import { IsEmail, IsIn, IsInt, IsOptional } from 'class-validator';

/** `POST /api/v1/admin/users` (auth mode `strict-managed` only). */
export class CreateAdminUserDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @IsOptional()
  @IsIn(['admin', 'user'])
  role?: 'admin' | 'user' = 'user';

  /** Optional team the new account joins as a plain member. */
  @IsOptional()
  @IsInt()
  teamId?: number | null;
}
