import { IsIn } from 'class-validator';

export class UpdateUserRoleDto {
  @IsIn(['admin', 'user'])
  role: 'admin' | 'user';
}
