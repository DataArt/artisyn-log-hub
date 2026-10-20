import { ApiError } from '../../../api';

/**
 * Maps a session-logs fetch error to the user-facing message. Shared by `SessionLogView`,
 * `CallTreeView` and the Summary tab so all three agree on wording.
 */
export function getSessionLogsErrorMessage(error: Error): string {
  if (error instanceof ApiError) {
    if (error.statusCode === 403) return 'No access';
    if (error.statusCode === 422)
      return 'Log data is unavailable for this session.';
    return 'Failed to load session logs. Please try again.';
  }
  return 'Failed to load session logs. Please try again.';
}
