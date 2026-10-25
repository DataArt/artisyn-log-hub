import * as fs from 'fs';
import * as path from 'path';

export interface BuildInfo {
  version: string;
  gitCommit: string;
}

const DEV_BUILD_INFO: BuildInfo = { version: 'dev', gitCommit: 'unknown' };

function pickString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

/**
 * In the ncc production bundle __dirname is dist/, so this resolves to
 * dist/public/static/build-info.json (written during the Docker build from the
 * `VERSION` / `GIT_COMMIT` build-args, Dockerfile runtime stage). In dev
 * (unbundled), __dirname is server/src/common/, where no such file exists — the
 * { version: 'dev', gitCommit: 'unknown' } fallback below is the correct,
 * expected behavior there.
 *
 * Only `version` and `gitCommit` are picked from the parsed file, each one a
 * non-empty string or else `'unknown'`, so an older image's file with extra
 * fields (e.g. the former release stamp) never leaks them into the response.
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
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { version: 'unknown', gitCommit: 'unknown' };
    }
    return {
      version: pickString('version' in parsed ? parsed.version : undefined),
      gitCommit: pickString(
        'gitCommit' in parsed ? parsed.gitCommit : undefined,
      ),
    };
  } catch {
    return { ...DEV_BUILD_INFO };
  }
}
