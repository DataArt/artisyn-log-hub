/**
 * Zip import limits. Values are read from env at call time; a value
 * that is not a positive integer falls back to the default.
 */

export interface ImportLimits {
  /** Max size of the uploaded zip file, bytes (`IMPORT_MAX_UPLOAD_BYTES`). */
  maxUploadBytes: number;
  /** Max number of entries in the zip (`IMPORT_MAX_ENTRIES`). */
  maxEntries: number;
  /** Max total uncompressed size of all entries, bytes (`IMPORT_MAX_UNCOMPRESSED_BYTES`). */
  maxUncompressedBytes: number;
  /** Max uncompressed size of a single entry, bytes (`IMPORT_MAX_ENTRY_BYTES`). */
  maxEntryBytes: number;
}

export const IMPORT_LIMIT_ENV = {
  maxUploadBytes: 'IMPORT_MAX_UPLOAD_BYTES',
  maxEntries: 'IMPORT_MAX_ENTRIES',
  maxUncompressedBytes: 'IMPORT_MAX_UNCOMPRESSED_BYTES',
  maxEntryBytes: 'IMPORT_MAX_ENTRY_BYTES',
} as const satisfies Record<keyof ImportLimits, string>;

export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = {
  maxUploadBytes: 5 * 1024 * 1024 * 1024, // 5 GiB
  maxEntries: 20_000,
  maxUncompressedBytes: 20 * 1024 * 1024 * 1024, // 20 GiB
  // 400 MiB — below the V8 max string length (536,870,888), since an entry is read
  // into a single string.
  maxEntryBytes: 400 * 1024 * 1024,
};

/** Human-readable limit names used in the rejection message. */
const LIMIT_LABELS: Record<keyof ImportLimits, string> = {
  maxUploadBytes: 'upload size',
  maxEntries: 'entry count',
  maxUncompressedBytes: 'total uncompressed size',
  maxEntryBytes: 'entry size',
};

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function getImportLimits(): ImportLimits {
  return {
    maxUploadBytes: readPositiveInt(
      IMPORT_LIMIT_ENV.maxUploadBytes,
      DEFAULT_IMPORT_LIMITS.maxUploadBytes,
    ),
    maxEntries: readPositiveInt(
      IMPORT_LIMIT_ENV.maxEntries,
      DEFAULT_IMPORT_LIMITS.maxEntries,
    ),
    maxUncompressedBytes: readPositiveInt(
      IMPORT_LIMIT_ENV.maxUncompressedBytes,
      DEFAULT_IMPORT_LIMITS.maxUncompressedBytes,
    ),
    maxEntryBytes: readPositiveInt(
      IMPORT_LIMIT_ENV.maxEntryBytes,
      DEFAULT_IMPORT_LIMITS.maxEntryBytes,
    ),
  };
}

/** Thrown when an import breaks one of the {@link ImportLimits}, or is not a zip. */
export class ImportLimitError extends Error {
  constructor(
    message: string,
    readonly limit: keyof ImportLimits | 'not-zip',
  ) {
    super(message);
    this.name = 'ImportLimitError';
  }

  static exceeded(
    limit: keyof ImportLimits,
    actual: number,
    max: number,
  ): ImportLimitError {
    return new ImportLimitError(
      `Import rejected: ${LIMIT_LABELS[limit]} exceeded (${actual} > ${max}). ` +
        `Raise ${IMPORT_LIMIT_ENV[limit]} to allow larger imports.`,
      limit,
    );
  }

  static notZip(): ImportLimitError {
    return new ImportLimitError(
      'Import rejected: file is not a zip archive',
      'not-zip',
    );
  }
}
