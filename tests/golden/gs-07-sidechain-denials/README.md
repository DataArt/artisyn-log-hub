# GS-07 errors

One root session on `fix/windows` (claude-sonnet-4-6), W2 Tuesday; prompts P1 20 s, P2 30 s, P3 10 s.

| Call | Result | Outcome |
|---|---|---|
| `Bash npm test` | `is_error`, missing script | failure |
| `Bash ls /root` | `is_error`, "Permission denied" as command output | failure |
| `Bash rm -rf build` | `is_error`, "The user doesn't want to proceed with this tool use" | unresolved |
| `Bash echo ok` | ok | success |
| `Read src/ok.ts` | content | success |
| `Read src/other.ts` | no `tool_result` | unresolved |

Distractors that must not reach any total: one `isSidechain` user + assistant pair (50 000 / 10 000
tokens), an `isMeta` user line, a `<task-notification>` five minutes after P3, and the last answer
split over two lines with the same `message.id` and usage.

- Tokens after dedup 3000 / 1200 / 12000 / 4000 (5m) → **$0.0456**; 3 prompts; work time **60 s**.
- Bash 4 calls = 1 success / 2 failures / 1 unresolved (failure rate 66.7 %); Read 2 = 1 / 0 / 1.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
