import { Matches } from 'class-validator';
import { RELEASE_ZIP_NAME_RE } from '../../releases/release-token';

export class ReleaseDownloadLinkDto {
  /**
   * Bare file name of the zip to mint a link for — never a path. The same
   * pattern the redeem route enforces, applied here by the global
   * `ValidationPipe` so a malformed name is a 400 before any handler code or
   * filesystem lookup runs. The controller additionally requires the name to
   * be in the *current* inventory.
   */
  @Matches(RELEASE_ZIP_NAME_RE, {
    message: 'file must be a release zip file name',
  })
  file: string;
}
