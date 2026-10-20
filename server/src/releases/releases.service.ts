import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import { resolveReleasesDir } from '../common/static-dir';
import { RELEASE_ZIP_NAME_RE } from './release-token';
import type { ReleaseArch, ReleaseZipEntry } from './releases.types';

/**
 * Read-only view of the release zips this instance ships with.
 *
 * The zips are never part of the image — a read-only bind mount drops the host
 * directory onto `/app/dist/releases` (see the compose files). This service
 * therefore has no write path of any kind: it lists and it resolves, it never
 * creates, moves or deletes a file. Pruning old stamps is CI's job.
 */
@Injectable()
export class ReleasesService {
  /**
   * Absolute releases directory. `RELEASES_DIR` wins when set (unit and e2e
   * tests point it at a temp dir; an operator can use it to relocate the
   * mount), otherwise the layout probe in `resolveReleasesDir` decides.
   *
   * Read per call rather than cached at module load so a test that sets the
   * env var after import still gets the directory it asked for.
   */
  private get releasesDir(): string {
    return process.env.RELEASES_DIR || resolveReleasesDir(__dirname);
  }

  /**
   * The release zips of the **newest stamp only**, sorted by architecture.
   *
   * Older-stamp files that are still on disk are silently omitted — they are
   * never listed and never deleted. A missing directory, an unreadable one, or
   * one holding nothing that matches `RELEASE_ZIP_NAME_RE` all yield `[]`
   * rather than an error: "no releases published here" is a normal state for a
   * locally-run instance, not a failure.
   */
  listReleases(): ReleaseZipEntry[] {
    const dir = this.releasesDir;

    let fileNames: string[];
    try {
      fileNames = fs.readdirSync(dir);
    } catch {
      return [];
    }

    const entries: ReleaseZipEntry[] = [];
    for (const fileName of fileNames) {
      const match = RELEASE_ZIP_NAME_RE.exec(fileName);
      if (!match) continue;

      let sizeBytes: number;
      try {
        sizeBytes = fs.statSync(join(dir, fileName)).size;
      } catch {
        // Vanished or unreadable between readdir and stat — skip it rather
        // than fail the whole inventory.
        continue;
      }

      entries.push({
        fileName,
        stamp: match[1],
        arch: match[2] as ReleaseArch,
        sizeBytes,
      });
    }

    // Newest stamp first; within a stamp, architectures in a stable order.
    entries.sort((a, b) =>
      a.stamp === b.stamp
        ? a.arch.localeCompare(b.arch)
        : b.stamp.localeCompare(a.stamp),
    );

    if (entries.length === 0) return [];
    const newestStamp = entries[0].stamp;
    return entries.filter((entry) => entry.stamp === newestStamp);
  }

  /**
   * Absolute path of a release zip, or `null` when the name is not a release
   * zip name or no such file exists.
   *
   * The caller supplies a bare **file name**, never a path: anything failing
   * `RELEASE_ZIP_NAME_RE` (traversal segments and separators included) is
   * refused before `join` ever runs, so no path outside the releases directory
   * can be produced here.
   *
   * Deliberately does not consult `listReleases()` — a link minted for what was
   * then the newest stamp keeps working for its whole window even after a newer
   * release supersedes it in the inventory.
   */
  resolveZipPath(fileName: string): string | null {
    if (!RELEASE_ZIP_NAME_RE.test(fileName)) return null;

    const zipPath = join(this.releasesDir, fileName);
    return fs.existsSync(zipPath) ? zipPath : null;
  }
}
