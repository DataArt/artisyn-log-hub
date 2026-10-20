import type { SessionAttributionAttributeDef } from '../../models/repositories';
import type { RepoSettingsResponse } from '../api';

/**
 * AI Session Attribution UI constants and validation helpers.
 *
 * Mirrors the caps/regex declared in `server/src/logs/repositories.service.ts`
 * (`SESSION_ATTRIBUTION_KEY_REGEX` / `_MAX_ATTRIBUTES` / `_MAX_LABEL_LENGTH` /
 * `_MAX_PROMPT_LENGTH` / `_TYPES`) and `DEFAULT_ATTRIBUTES` in
 * `server/src/logs/session-attribution/session-attribution.service.ts`.
 * Client-only copies purely for the settings-tab editor's own client-side validation and its
 * "starting point" attribute list when a team has no saved override yet — the server remains
 * the source of truth and re-validates on save; keep these in sync by hand if the server-side
 * values ever change.
 */
export const SESSION_ATTRIBUTION_KEY_REGEX = /^[a-z][a-z0-9_]{0,31}$/;
export const SESSION_ATTRIBUTION_MAX_ATTRIBUTES = 12;
export const SESSION_ATTRIBUTION_MAX_LABEL_LENGTH = 60;
export const SESSION_ATTRIBUTION_MAX_PROMPT_LENGTH = 1000;

export const SESSION_ATTRIBUTION_TYPES: SessionAttributionAttributeDef['type'][] =
  ['string', 'string[]', 'boolean', 'number'];

export const SESSION_ATTRIBUTION_TYPE_LABELS: Record<
  SessionAttributionAttributeDef['type'],
  string
> = {
  string: 'Text',
  'string[]': 'Text list',
  boolean: 'Yes/No',
  number: 'Number',
};

/** Mirrors `DEFAULT_ATTRIBUTES` — the built-in starting point offered when a team hasn't
 * saved a `sessionAttribution` override yet (feature is on by default for team repos). */
export const DEFAULT_SESSION_ATTRIBUTION_ATTRIBUTES: SessionAttributionAttributeDef[] =
  [
    {
      key: 'jira_ticket',
      label: 'Jira Ticket',
      type: 'string',
      prompt: 'the ticket key the session works on, e.g. ABC-123, null if none',
    },
    {
      key: 'adlc_stages',
      label: 'Workflow Stages',
      type: 'string[]',
      prompt:
        'which stages of the development lifecycle the session covered — requirements, ' +
        'design, plan, implement, test, review, docs, devops',
    },
    {
      key: 'has_correction',
      label: 'Has Correction',
      type: 'boolean',
      prompt: "whether a user prompt corrects the agent's direction",
    },
  ];

/**
 * Resolves the effective attribute definitions for read-only
 * consumers (session list chips, `AttributeFilterPopover.tsx`) from the same
 * `GET :repoId/settings` payload `RepositorySettings.tsx` already fetches for the settings
 * tab, mirroring its own `effectiveSessionAttribution` derivation exactly: a team's saved override wins; absent one, a no-team repo has nothing (never the
 * built-in defaults — the feature has nothing to attach to); otherwise the built-in defaults.
 */
export function resolveSessionAttributionDefinitions(
  settings: Pick<RepoSettingsResponse, 'teamId' | 'teamConfig'> | undefined,
): SessionAttributionAttributeDef[] {
  if (!settings) return [];
  const saved = settings.teamConfig?.sessionAttribution;
  if (saved) return saved.attributes;
  return settings.teamId !== null ? DEFAULT_SESSION_ATTRIBUTION_ATTRIBUTES : [];
}

export function validateAttributeKey(key: string): string | null {
  if (!key.trim()) return 'Key is required';
  if (!SESSION_ATTRIBUTION_KEY_REGEX.test(key)) {
    return 'Lowercase letters, digits and underscores only, starting with a letter (max 32 chars)';
  }
  return null;
}

export function validateAttributeLabel(label: string): string | null {
  if (!label.trim()) return 'Label is required';
  if (label.length > SESSION_ATTRIBUTION_MAX_LABEL_LENGTH) {
    return `Label must be ${SESSION_ATTRIBUTION_MAX_LABEL_LENGTH} characters or fewer`;
  }
  return null;
}

export function validateAttributePrompt(prompt: string): string | null {
  if (!prompt.trim()) return 'Prompt is required';
  if (prompt.length > SESSION_ATTRIBUTION_MAX_PROMPT_LENGTH) {
    return `Prompt must be ${SESSION_ATTRIBUTION_MAX_PROMPT_LENGTH} characters or fewer`;
  }
  return null;
}
