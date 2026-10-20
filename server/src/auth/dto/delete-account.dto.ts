import { Equals } from 'class-validator';

export class DeleteAccountDto {
  // Deliberately a fixed literal rather than the caller's email: the
  // self-service dialog makes the user type the word `delete` before the
  // confirm button unlocks, and the server re-checks it.
  @Equals('delete')
  confirm: string;
}
