import { IsEmail } from 'class-validator';

export class DeleteUserDto {
  // The admin confirms by typing the *target* user's email, so a misclicked row
  // cannot delete the wrong account. Compared
  // case-insensitively against the target in the controller.
  @IsEmail()
  confirmEmail: string;
}
