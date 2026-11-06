/**
 * Always-visible legend under the session OKF tab's VALUE SIGNALS strip: what each signal means
 * in plain words and how to check it by hand in the agent trail / tree / article drill-down. Text
 * only — no numbers are computed here.
 */

const ITEMS: readonly { term: string; meaning: string; check: string }[] = [
  {
    term: 'Paths followed',
    meaning:
      'new code paths an article showed that an agent then actually opened.',
    check:
      'select the agent: its trail lists the paths each read showed and where it opened them.',
  },
  {
    term: 'Routing misses',
    meaning:
      'an agent searched the code area of article X N times and never opened X.',
    check:
      'select the agent and read its trail: the searches of X’s area come with no read of X before them. Fix: make X easy to find, e.g. a pointer in the catalog or index.',
  },
  {
    term: 'Searched after reading',
    meaning:
      'an agent read article X and then still searched the code area of X N times — X likely lacked the fact.',
    check:
      'select the agent: in its trail the highlighted searches after the read of X are the ones counted. Fix: add the missing fact to X.',
  },
  {
    term: 'Dead pointers',
    meaning:
      'paths an article shows that no agent ever followed, or that exist in no session.',
    check: 'check that each path still exists; drop or fix stale ones.',
  },
];

export function OkfValueSignalsLegend() {
  return (
    <dl
      data-testid="okf-value-signals-legend"
      className="max-w-4xl space-y-0.5 text-[11px] text-muted-foreground"
    >
      {ITEMS.map((it) => (
        <div key={it.term}>
          <dt className="inline font-medium text-foreground">{it.term}</dt>
          <dd className="inline">
            {' '}
            — {it.meaning} Check: {it.check}
          </dd>
        </div>
      ))}
    </dl>
  );
}
