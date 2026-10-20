import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sendReleaseErrorPage } from './release-error-page';
import { getReleaseLinkKey, verifyReleaseToken } from './release-token';
import { ReleasesService } from './releases.service';

/**
 * Only a string query value can be a token field. Express hands back an array
 * for a repeated param (`?file=a&file=b`) and an object for a bracketed one,
 * both of which are collapsed to `''` here so the pattern check refuses them
 * instead of something downstream stringifying them into a path.
 */
function queryString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Public, unauthenticated redeem route for a signed release download link
 * (`GET /api/v1/releases/download?file=&exp=&sig=`).
 *
 * Deliberately guard-free: the recipient of a link is typically not a log-hub
 * user at all, and the HMAC token *is* the authorization (see the release-token
 * module). The `/api` prefix already keeps this path out of
 * `ServeStaticModule`'s reach, so no exclude-list change is needed.
 *
 * Nothing here throws an `HttpException`: the global `HttpExceptionFilter`
 * renders JSON, and the caller is a human in a browser — every refusal is an
 * HTML page written by `sendReleaseErrorPage`.
 */
@Controller('api/v1/releases')
export class ReleaseDownloadController {
  private readonly logger = new Logger(ReleaseDownloadController.name);

  constructor(private readonly releasesService: ReleasesService) {}

  @Get('download')
  download(
    @Query('file') file: unknown,
    @Query('exp') exp: unknown,
    @Query('sig') sig: unknown,
    @Res() res: Response,
  ): void {
    const fileName = queryString(file);

    const verdict = verifyReleaseToken(
      fileName,
      queryString(exp),
      queryString(sig),
      getReleaseLinkKey(),
    );

    if (verdict === 'invalid') {
      sendReleaseErrorPage(
        res,
        403,
        'Invalid download link',
        'This download link is not valid. Ask the administrator who sent it for a new one.',
      );
      return;
    }

    if (verdict === 'expired') {
      sendReleaseErrorPage(
        res,
        410,
        'Link expired',
        'This download link has expired. Download links are valid for 24 hours. Ask the administrator who sent it for a new one.',
      );
      return;
    }

    // Token is genuine and live — the file may still have been pruned since it
    // was minted, which is the one remaining refusal.
    const zipPath = this.releasesService.resolveZipPath(fileName);
    if (zipPath == null) {
      this.sendGonePage(res);
      return;
    }

    res.sendFile(
      zipPath,
      {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${fileName}"`,
        },
      },
      (err) => {
        if (!err) return;

        this.logger.warn(
          `Release download of ${fileName} failed: ${err.message}`,
        );

        // A client that aborted mid-stream, or a file that vanished between the
        // existence check and the read. Only the latter can still be answered —
        // once bytes are on the wire the response must be left alone rather
        // than appended to with an error page.
        if (!res.headersSent) {
          this.sendGonePage(res);
        }
      },
    );
  }

  private sendGonePage(res: Response): void {
    sendReleaseErrorPage(
      res,
      404,
      'File no longer available',
      'The release this link points to is no longer on this server. Ask the administrator who sent it for a current link.',
    );
  }
}
