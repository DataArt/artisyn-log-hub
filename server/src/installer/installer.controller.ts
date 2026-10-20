import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import { join } from 'path';
import { compareSemver, isValidSemver } from '../common/semver';
import { resolveStaticDir } from '../common/static-dir';

// dev: server/src/installer -> server/src/public/static.
// ncc bundle: dist/ -> dist/public/static (a fixed '..' overshoots — see resolveStaticDir).
const STATIC_DIR = resolveStaticDir(__dirname);
const TGZ_PATH = join(STATIC_DIR, 'artisyn-hooks-installer.tgz');
const LATEST_VERSION_PATH = join(STATIC_DIR, 'latest-hook-version.json');

/**
 * Public, unauthenticated download endpoint for the hooks installer tarball. Not behind
 * ServeStaticModule so it can observe the `?v=` query param the client appends to the
 * download URL (see InstallTab.tsx) — this is the only place the server learns which hook
 * version is actually being installed "in the wild", used as the outdated-baseline for the
 * Hook State Panel.
 */
@Controller('static')
export class InstallerController {
  private readonly logger = new Logger(InstallerController.name);

  @Get('artisyn-hooks-installer.tgz')
  downloadInstaller(@Query('v') v: string | undefined, @Res() res: Response) {
    if (v !== undefined) {
      if (isValidSemver(v)) {
        this.recordVersion(v);
      } else {
        // Malformed ?v= must never break the actual file download — log and move on.
        this.logger.warn(`Ignoring malformed installer ?v= query param: ${v}`);
      }
    }

    res.sendFile(TGZ_PATH);
  }

  /** Max-wins upsert of latest-hook-version.json — never regresses the stored baseline. */
  private recordVersion(version: string): void {
    try {
      fs.mkdirSync(STATIC_DIR, { recursive: true });

      let existingVersion: string | null = null;
      try {
        const raw = fs.readFileSync(LATEST_VERSION_PATH, 'utf8');
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (typeof parsed.version === 'string') {
          existingVersion = parsed.version;
        }
      } catch {
        // missing/corrupt file — treat as no prior recorded version
      }

      const winner =
        existingVersion !== null && compareSemver(existingVersion, version) > 0
          ? existingVersion
          : version;

      fs.writeFileSync(
        LATEST_VERSION_PATH,
        JSON.stringify({
          version: winner,
          recordedAt: new Date().toISOString(),
        }) + '\n',
        'utf8',
      );
    } catch (err) {
      this.logger.warn(
        `Failed to record installer version ${version}: ${(err as Error).message}`,
      );
    }
  }
}
