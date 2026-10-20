/** Architecture of a release bundle, taken from capture 2 of `RELEASE_ZIP_NAME_RE`. */
export type ReleaseArch = 'amd64' | 'arm64';

/** One release zip present in the releases directory of this instance. */
export interface ReleaseZipEntry {
  /** Full file name, e.g. `artisyn-log-hub-20260918-142233-amd64.zip`. */
  fileName: string;
  arch: ReleaseArch;
  /** UTC release stamp `YYYYMMDD-HHMMSS`, capture 1 of `RELEASE_ZIP_NAME_RE`. */
  stamp: string;
  sizeBytes: number;
}

/** `GET /api/v1/admin/releases` — only the newest stamp is ever listed. */
export interface ReleaseInventoryResponse {
  entries: ReleaseZipEntry[];
}

/** `POST /api/v1/admin/releases/download-link`. */
export interface ReleaseDownloadLinkResponse {
  /** Absolute, signed, unauthenticated download URL. */
  url: string;
  /** ISO-8601 UTC instant the link stops working. */
  expiresAt: string;
}
