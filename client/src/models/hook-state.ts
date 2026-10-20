export interface HookRepositorySummary {
  id: number;
  repoUrl: string;
  hookVersion: string;
  outdated: boolean;
  issueCount: number;
}

export interface HookRecommendation {
  rule: string;
  message: string;
  detectedAt: string;
}

export interface NonUploadableLog {
  file: string;
  reason: string;
}

export interface HookStateDetail {
  repoUrl: string;
  hookVersion: string;
  latestVersion: string | null;
  outdated: boolean;
  lastActivity: string | null;
  logTail: string[];
  nonUploadableLogs: NonUploadableLog[];
  recommendations: HookRecommendation[];
  errors: string[];
}
