import { IsEmail } from 'class-validator';

export class IdentifyDto {
  @IsEmail()
  email: string;
}
