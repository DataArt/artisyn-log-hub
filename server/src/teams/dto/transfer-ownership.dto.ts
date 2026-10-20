import { IsInt } from 'class-validator';

export class TransferOwnershipDto {
  @IsInt()
  userId: number;
}
