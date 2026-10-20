/**
 * Generic per-user key/value settings. The server stores `value` verbatim and
 * never interprets it — any structure inside it belongs to the client feature
 * that owns the setting name.
 */
export interface UserSetting {
  name: string;
  value: string | null;
}

export type UserSettingsMap = Record<string, string | null>;
