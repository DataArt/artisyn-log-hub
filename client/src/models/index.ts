/**
 * Types the client expects from its HTTP API (`src/viewer/api.ts`).
 * The backend will be shaped to match these — not the other way around.
 *
 * @see client/README.md — Models
 */

export type { AuthConfig, AuthMode, UserProfile } from './auth';
export type { Team, TeamMember, TeamRepository, Invitation } from './teams';
export type { UserSetting, UserSettingsMap } from './user-settings';
export type { ModelPricingEntry, ModelPricingMap } from './pricing';
export type {
  AdminAuthConfig,
  AdminRepo,
  AdminTeam,
  AdminTeamMember,
  AdminUser,
  DataRetentionDailyBucket,
  DataRetentionStats,
  ErrorLogEntry,
  PendingRegistration,
  SystemInfo,
  SystemInfoWorkerProcess,
  UploadQueueEntry,
  UploadQueueStats,
  UploadQueueStatus,
  UploadQueueStatusBucket,
} from './admin';
export type {
  ExportImportJobStatus,
  ExportImportScope,
  ExportMetaJson,
  ExportScopeSummary,
  ImportUploadSummary,
} from './export-import';
