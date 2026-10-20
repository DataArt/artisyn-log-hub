import { parseVersion } from '../common/semver';
import type { ReleaseVersions } from './ai-tool-versions.types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Extracts `{ latest, stable }` from an npm dist-tags payload. Returns `null` unless the
 * payload is a plain object whose `latest` and `stable` are strings accepted by
 * `parseVersion`. Other tags (e.g. `next`) are dropped; `stable > latest` is kept as-is.
 */
export function parseDistTags(json: unknown): ReleaseVersions | null {
  if (!isPlainObject(json)) return null;
  const { latest, stable } = json;
  if (typeof latest !== 'string' || typeof stable !== 'string') return null;
  if (!parseVersion(latest) || !parseVersion(stable)) return null;
  return { latest: latest.trim(), stable: stable.trim() };
}
