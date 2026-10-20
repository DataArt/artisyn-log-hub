/** The npm dist-tags the server tracks for an AI tool. */
export interface ReleaseVersions {
  latest: string;
  stable: string;
}

/** One append-only history entry: the release versions in effect from `effectiveFrom` on. */
export interface AiToolVersionHistoryEntry {
  versions: ReleaseVersions;
  /** ISO timestamp. */
  effectiveFrom: string;
}

/** Response of `GET /api/v1/ai-tool-versions/:toolName`. */
export interface AiToolVersionsResponse {
  toolName: string;
  /** ISO; null before the first successful fetch or when the row is missing. */
  fetchedAt: string | null;
  /** Ordered by effective_from ASC, id ASC; empty before the first successful fetch. */
  history: AiToolVersionHistoryEntry[];
}
