import {
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsISO8601({ strict: true })
  @Matches(/T/, {
    message:
      'expires_at must be a full datetime with timezone (e.g. 2025-12-31T00:00:00Z)',
  })
  @IsOptional()
  expires_at?: string;
}
