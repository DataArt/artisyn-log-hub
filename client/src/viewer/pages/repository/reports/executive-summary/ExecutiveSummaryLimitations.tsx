interface Props {
  excludedSessionCount: number;
  excludedModels: string[];
}

// On-page "Data Source & Limitations" closing block (guide §9) — a
// muted footnote panel with 5 fixed caveats, plus a conditional notice
// when some sessions had no pricing row for their model. Mirrored in the PDF export by ExecutiveSummaryLimitationsPdf.
export function ExecutiveSummaryLimitations({
  excludedSessionCount,
  excludedModels,
}: Props) {
  return (
    <section className="mb-2">
      <h2 className="text-sm font-semibold text-foreground">
        Data Source &amp; Limitations
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        How these figures were produced, and what they do not include
      </p>
      <div className="rounded-md border border-border bg-muted/30 p-4">
        <ul className="space-y-2 text-xs text-muted-foreground">
          <li className="flex gap-2">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              aria-hidden="true"
            />
            <span>
              Figures come from Claude Code telemetry uploaded to the Artisyn
              Log Hub server — not from Anthropic billing APIs.
            </span>
          </li>
          <li className="flex gap-2">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              aria-hidden="true"
            />
            <span>
              Scope is a single repository; cross-repository totals are not part
              of this report.
            </span>
          </li>
          <li className="flex gap-2">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              aria-hidden="true"
            />
            <span>
              Sessions worked offline, or never uploaded, are not captured.
            </span>
          </li>
          <li className="flex gap-2">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              aria-hidden="true"
            />
            <span>
              Cost is calculated with{' '}
              <span className="font-semibold text-foreground">current</span>{' '}
              model pricing (rates effective on or before today), not the rate
              in effect when the session ran — historical figures move when
              pricing changes.
            </span>
          </li>
          <li className="flex gap-2">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              aria-hidden="true"
            />
            <span>
              Model mix attributes a session&rsquo;s whole cost to the first
              model observed in that session.
            </span>
          </li>
        </ul>

        {excludedSessionCount > 0 && (
          <>
            <hr className="my-3 border-border" />
            <p className="flex gap-2 text-xs text-muted-foreground">
              <span
                className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500"
                aria-hidden="true"
              />
              <span>
                <span className="font-semibold text-foreground">
                  {excludedSessionCount} sessions excluded from cost
                </span>{' '}
                (no pricing for model {excludedModels.join(', ')}). Total AI
                Cost understates spend by that much.
              </span>
            </p>
          </>
        )}
      </div>
    </section>
  );
}
