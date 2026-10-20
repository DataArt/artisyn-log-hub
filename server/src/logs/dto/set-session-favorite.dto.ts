import { IsBoolean } from 'class-validator';

export class SetSessionFavoriteDto {
  @IsBoolean()
  favorite: boolean;
}
