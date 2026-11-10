# PoC: capture the real subscription quota from the Claude Code status line

Task: [Budgets, Spend Forecasts and Cost Slices](../../tasks/todo/2026-11-05-budgets-threshold-alerts/requirements.md)
(later increment "real subscription quota").

## Question

Can Log Hub get the real Claude Code subscription quota — percent of the 5-hour and 7-day windows
used and their reset times (`rate_limits` in the status-line input) — and where from?

## How to run

From this folder:

```
node make-settings.js
```

It writes `claude-config/settings.json` with a `statusLine` that runs `capture-statusline.js`
(the path is derived at runtime). Then start an **interactive** session in any scratch folder and
send one prompt:

```
claude --settings <this folder>/claude-config/settings.json --model haiku "reply with the single word ok"
```

Every status-line refresh appends a snapshot to `out/quota.jsonl` (ignored) and the status line shows
`5h <pct>% (resets …) | 7d <pct>% (resets …)`. Quit the session when done.

## Result

**Yes, but only through the status line, and only in interactive sessions of subscribers.**

Captured on Claude Code 2.1.314, Claude Team plan (snapshot from `out/quota.jsonl`, session id omitted):

```json
{"hasRateLimits":false,"rateLimits":null}                       // session start, before any API response
{"hasRateLimits":true,"rateLimits":{
  "five_hour":{"used_percentage":12,"resets_at":1794246600},     // 2026-11-09T17:50Z
  "seven_day":{"used_percentage":7,"resets_at":1794787200}}}     // 2026-11-16T00:00Z
```

Findings:

1. `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at` in epoch seconds) arrive in the
   status-line input after the first API response, as documented. They match what the user's account
   shows; `spend_limit` appears only behind a Claude apps gateway and was absent here.
2. **`claude -p` (headless) never runs the status line** — the same prompt with the same settings
   produced no snapshot. CI, SDK and other headless sessions give no quota.
3. **No hook receives it.** Hook inputs and OTel carry no quota percentages (docs: only `StopFailure`
   matcher `rate_limit` and `quota_auto_resume_*` notifications, i.e. events, not numbers). The status
   line is the only source.
4. Present only for claude.ai Pro / Max / Team / Ultra subscribers (or a gateway spend limit); API-key
   users get nothing.
5. The status line is a single setting. For Log Hub to read it, the hook installer would have to own the
   `statusLine` command — and when the user already has one, wrap it: record the snapshot, then pass
   stdin to the user's original command and print its output. It runs after every assistant message
   (300 ms debounce, in-flight runs cancelled), so the recorder must be fast and fail-open, and should
   write only when a value changes.

**Decision (2026-11-09): not adopted** — a status-line wrapper in the hook is too complex and fragile
for the value. Log Hub does not capture the subscription quota.

Implications had it been adopted: the quota is a per-account number (shared by all repos and sessions of that
account), so it belongs to the user, not to a session or repository. It can be shown as "5-hour window:
N % used, resets at …" and "7-day: N %", with history from the snapshots. Cost: a status-line wrapper in
the hook (install / uninstall / upgrade must keep the user's own status line intact, and older hooks
simply send nothing).
