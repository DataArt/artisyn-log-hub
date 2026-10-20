import { IsString, MaxLength } from 'class-validator';

export class SetUserSettingDto {
  /** Opaque to the server — 64 KB cap, never parsed or validated for shape. */
  @IsString()
  @MaxLength(65536)
  value: string;
}
