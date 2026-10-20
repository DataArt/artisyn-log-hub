import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsIn(['transparent', 'restricted'])
  accessMode?: 'transparent' | 'restricted';
}
