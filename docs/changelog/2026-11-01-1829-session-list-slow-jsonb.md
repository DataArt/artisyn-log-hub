# Fast session list and analytics timeline on large transcripts

- The repository session list and the analytics timeline no longer read stored transcripts per
  request: on a real instance they went from 13–29 s to well under a second.
- Adding a repository to a team returns at once; the team statistics are recalculated in the
  background and the team page shows «Adding…» until they are done.
- OTEL tabs: the trace waterfall no longer scrolls inside the page, and percentages in the OTEL
  tables no longer wrap.
- `npm run perf` now measures every read endpoint against multi-megabyte transcripts, checks p95
  budgets and can run read-only against an existing instance.
