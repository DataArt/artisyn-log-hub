import { IsString, Length } from 'class-validator';

/**
 * Body of `POST /api/v1/admin/model-pricing/override/clear`. The model id travels in
 * the body, never the path, because ids can contain `/`.
 */
export class ModelIdDto {
  @IsString()
  @Length(1, 255)
  modelId: string;
}
