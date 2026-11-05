/**
 * The Checks block of the OKF verdict card (2026-11-05): one line per structure rule from
 * `verdict.checks` — ✓ / ! / – icon, a short name, the counted value with its threshold, and for
 * a finding the "→ action" line. Always visible, also when every check is OK, so the card says
 * what was counted. The session variant ends with a pointer to the repository OKF tab, where the
 * rules that need many sessions run. Hidden on an older server (no `checks`).
 */
import { formatOkfCheck } from '@/lib/okf/okf-check-text';
import type { OkfAgentNamer } from '@/lib/okf/okf-verdict-text';
import type {
  OkfVerdictCheck,
  OkfVerdictCheckStatus,
} from '../../../../../models/repositories';

const ICON: Record<OkfVerdictCheckStatus, { mark: string; cls: string }> = {
  ok: { mark: '✓', cls: 'text-emerald-600 dark:text-emerald-400' },
  finding: { mark: '!', cls: 'text-amber-600 dark:text-amber-400' },
  na: { mark: '–', cls: 'text-muted-foreground' },
};

function iconOf(status: OkfVerdictCheckStatus) {
  return (
    (ICON as Record<string, (typeof ICON)['ok'] | undefined>)[status] ?? ICON.na
  );
}

export function OkfChecksBlock({
  checks,
  variant,
  agentName,
  onOpenRepoTab,
}: {
  checks: readonly OkfVerdictCheck[];
  variant: 'session' | 'repo';
  agentName?: OkfAgentNamer;
  /** Session variant: switches to the repository OKF tab. */
  onOpenRepoTab?: () => void;
}) {
  return (
    <div data-testid="okf-checks">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        How the agents navigated the KB — counted from tool calls
      </div>
      <ul className="space-y-1">
        {checks.map((c) => {
          const t = formatOkfCheck(c, agentName);
          const icon = iconOf(c.status);
          return (
            <li
              key={c.rule}
              data-testid="okf-check-line"
              data-rule={c.rule}
              data-status={c.status}
              className="flex gap-2 px-1 text-xs"
            >
              <span
                aria-hidden="true"
                className={`w-3 shrink-0 text-center font-bold ${icon.cls}`}
              >
                {icon.mark}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{t.name}</span>
                <span className="text-muted-foreground"> · </span>
                <span data-testid="okf-check-text">{t.text}</span>
                {t.action ? (
                  <span
                    data-testid="okf-check-action"
                    className="block text-[11px] text-muted-foreground"
                  >
                    → {t.action}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {variant === 'session' ? (
        <div
          data-testid="okf-checks-repo-note"
          className="mt-1 px-1 text-[11px] text-muted-foreground"
        >
          Repo-level checks (always read, KB flood, coarse article) run over
          many sessions on the repository OKF tab
          {onOpenRepoTab ? (
            <>
              {' '}
              <button
                type="button"
                data-testid="okf-checks-open-repo"
                onClick={onOpenRepoTab}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                → open
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
