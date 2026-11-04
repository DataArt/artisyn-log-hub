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
 * Where this build came from — the contents of `build.origin.json`. Its writers are
 * `scripts/build-origin.js` (local `npm run build`, `build:serial`, the scenario stand)
 * and the Dockerfile runtime stage (`printf`). Only the release workflow's image sets
 * `officialRelease: true` (plus the scenario stand, so its release check is eligible).
 */
export interface BuildOrigin {
  branch: string;
  version: string;
  /** ISO 8601 UTC timestamp taken when the file was written. */
  builtAt: string;
  officialRelease: boolean;
}

/**
 * Reads `build.origin.json` next to the server bundle. In the ncc production bundle
 * __dirname is dist/, so this resolves to dist/build.origin.json (outside dist/public/,
 * never served). In dev (unbundled) __dirname is server/src/common/, where no such file
 * exists, so the result is `null` there.
 *
 * Returns `null` when the file is missing, unparseable or not an object; never throws and
 * is not cached (same as `readBuildInfo`). `branch`, `version` and `builtAt` are each a
 * non-empty string or else `'unknown'`; `officialRelease` is true only for a literal
 * `true` — an older image without the file, or with extra fields, never leaks anything else.
 */
export function readBuildOrigin(): BuildOrigin | null {
  const originPath = path.join(__dirname, 'build.origin.json');
  try {
    const raw = fs.readFileSync(originPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return {
      branch: pickString('branch' in parsed ? parsed.branch : undefined),
      version: pickString('version' in parsed ? parsed.version : undefined),
      builtAt: pickString('builtAt' in parsed ? parsed.builtAt : undefined),
      officialRelease:
        'officialRelease' in parsed && parsed.officialRelease === true,
    };
  } catch {
    return null;
  }
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
