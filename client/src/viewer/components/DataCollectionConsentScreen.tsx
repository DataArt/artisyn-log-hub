import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/ui/button';
import { saveUserSetting } from '../api';
import {
  USER_SETTINGS_KEY,
  consentNoticeQuery,
  retentionDaysQuery,
} from '../lib/consent-queries';
import {
  DATA_COLLECTION_NOTICE_SETTING,
  RETENTION_DAYS_PLACEHOLDER,
  SECRETS_SECTION_HEADING,
  encodeConsent,
  noticeHash,
} from '../lib/notice-hash';

const markdownClasses = 'prose prose-sm max-w-none';

/**
 * Splits the notice into the part before the secrets section, the secrets
 * section itself, and the part after it. The secrets warning lives in the same
 * markdown file (so the Help article stays complete) but is rendered here in
 * its own amber block.
 */
function splitNotice(text: string): {
  before: string;
  secrets: string | null;
  after: string;
} {
  const lines = text.split('\n');
  const startIdx = lines.findIndex(
    (line) => line.trim() === `## ${SECRETS_SECTION_HEADING}`,
  );
  if (startIdx === -1) return { before: text, secrets: null, after: '' };
  const rest = lines.slice(startIdx + 1);
  const relativeEnd = rest.findIndex((line) => line.startsWith('## '));
  const endIdx = relativeEnd === -1 ? lines.length : startIdx + 1 + relativeEnd;
  return {
    before: lines.slice(0, startIdx).join('\n').trim(),
    secrets: lines
      .slice(startIdx + 1, endIdx)
      .join('\n')
      .trim(),
    after: lines.slice(endIdx).join('\n').trim(),
  };
}

/**
 * The data-collection notice, shown *instead of* the application shell to any
 * user who has not accepted the current notice text. There is deliberately no
 * decline path and no way to dismiss it other than the accept button — the
 * whole app is behind it, so a close control would have nothing to reveal.
 */
export function DataCollectionConsentScreen() {
  const queryClient = useQueryClient();
  const { data: noticeText } = useQuery(consentNoticeQuery);
  const { data: retentionDays } = useQuery(retentionDaysQuery);

  const text = noticeText ?? '';
  const withRetention = text.split(RETENTION_DAYS_PLACEHOLDER).join(
    // The route is prefetched with the app; fall back to the server default.
    String(retentionDays ?? 30),
  );
  const { before, secrets, after } = splitNotice(withRetention);

  const accept = useMutation({
    mutationFn: () =>
      saveUserSetting(
        DATA_COLLECTION_NOTICE_SETTING,
        encodeConsent(noticeHash(text)),
      ),
    onSuccess: async () => {
      // Prefix match — the cache entry is keyed [USER_SETTINGS_KEY, userId].
      await queryClient.invalidateQueries({ queryKey: [USER_SETTINGS_KEY] });
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background p-4 font-sans text-foreground"
      data-testid="data-collection-consent-screen"
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-card">
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className={markdownClasses}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{before}</ReactMarkdown>
          </div>

          {secrets && (
            <div className="my-4 flex gap-3 rounded-md border border-amber-300 bg-amber-50 p-4">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="min-w-0">
                <h2 className="mb-1 text-sm font-semibold">
                  {SECRETS_SECTION_HEADING}
                </h2>
                <div className={markdownClasses}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {secrets}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          )}

          {after && (
            <div className={markdownClasses}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{after}</ReactMarkdown>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-border p-4">
          <Button
            className="self-start"
            disabled={accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending && (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            )}
            I understand and accept
          </Button>
          {accept.isError && (
            <p className="text-xs text-destructive">
              {accept.error instanceof Error
                ? accept.error.message
                : 'Failed to save. Please try again.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
