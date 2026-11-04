/** Response of `GET /api/v1/admin/log-hub-release`. */
export interface LogHubReleaseState {
  /** True only on an eligible deployment whose stored latest release is newer than the running version. */
  updateAvailable: boolean;
  /** `build.origin.json` version when the deployment is eligible, else null. */
  currentVersion: string | null;
  /** Latest release version without the `v` prefix (e.g. `"1.3.0"`); only when `updateAvailable`. */
  latestVersion: string | null;
  /** The release's validated `html_url`; only when `updateAvailable`. */
  releaseUrl: string | null;
}

/** Outcome of one `LogHubReleaseService.runCheck()` call. */
export type RunCheckResult = 'fetched' | 'skipped' | 'failed';
