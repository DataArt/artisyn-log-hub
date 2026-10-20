import { IsEmail } from 'class-validator';

export class RenameUserEmailDto {
  @IsEmail()
  email: string;
}
