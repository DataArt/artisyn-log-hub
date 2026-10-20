import * as fs from 'fs';
import * as path from 'path';

export interface BuildInfo {
  version: string;
  gitCommit: string;
  /**
   * UTC release stamp (`YYYYMMDD-HHMMSS`) written by the Docker build from the
   * `RELEASE_STAMP` build-arg. Images built before the stamp existed have no
   * such field in their `build-info.json`; those normalize to `'unknown'`.
   */
  releaseStamp: string;
}

/**
 * In the ncc production bundle __dirname is dist/, so this resolves to
 * dist/public/static/build-info.json (written during the Docker build,
 * Dockerfile runtime stage). In dev (unbundled), __dirname is
 * server/src/common/, where no such file exists — the { version: 'dev',
 * gitCommit: 'unknown', releaseStamp: 'dev' } fallback below is the correct,
 * expected behavior there.
 *
 * `releaseStamp` is normalized rather than trusted: an image built before the
 * field was introduced writes a two-field file, and the rest of the app treats
 * `BuildInfo.releaseStamp` as always present.
 */
export function readBuildInfo(): BuildInfo {
  const buildInfoPath = path.join(
    __dirname,
    'public',
    'static',
    'build-info.json',
  );

  try {
    const raw = fs.readFileSync(buildInfoPath, 'utf8');
    const parsed = JSON.parse(raw) as BuildInfo;
    return { ...parsed, releaseStamp: parsed.releaseStamp ?? 'unknown' };
  } catch {
    return { version: 'dev', gitCommit: 'unknown', releaseStamp: 'dev' };
  }
}
