import {
  IsISO8601,
  IsOptional,
  IsString,
  IsNotEmpty,
  Matches,
} from 'class-validator';

export class UpdateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  name?: string;

  @IsISO8601({ strict: true })
  @Matches(/T/, {
    message:
      'expires_at must be a full datetime with timezone (e.g. 2025-12-31T00:00:00Z)',
  })
  @IsOptional()
  expires_at?: string | null;
}
