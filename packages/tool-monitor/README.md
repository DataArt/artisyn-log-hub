# @loghub/tool-monitor

Repo-local package with the CLI tool monitoring rules shared by the Log Hub server and client:
which tool names may be monitored (wrapped by the hook) and the capture limits. It is never
published; both sides consume its TypeScript sources directly.

| Export | Contents |
|---|---|
| `TOOL_DENYLIST` | Names that can never be monitored, each with its role (`shell`, `wrapper`, `agent`, `process`, `builtin`) — the role drives the validation message |
| `validateToolName` | `{ ok: true }` or `{ ok: false, code: 'empty' \| 'too_long' \| 'bad_chars' \| 'denylisted', message }`. Name rule `^[A-Za-z0-9._-]{1,64}$`, not `.` / `..`. The message is shown as is in the Monitored tools dialog and in the config PUT's 400 |
| `normalizeToolName` | The comparison key: trimmed, lower case, trailing `.exe` / `.cmd` / `.bat` / `.ps1` removed (denylist matching, case-insensitive uniqueness) |
| `denylistRole` | The denylist role of a name, or `null` |
| `TOOL_NAME_MAX`, `CAPTURE_LIMIT_BYTES`, `STDIN_CAPTURE_LIMIT_BYTES`, `MAX_MONITORED_TOOLS` | 64, 102400, 102400, 100 |

## The hook copy

The hook (`hook/`) does not use this package: it is plain CommonJS installed into user repos, so
it keeps its own copy, `hook/.claude/telemetry_tool/tool-wrap-names.js`. **Change both together.**
Both are checked against the same examples table,
`docs/knowledgebase/algorithms/tool-monitor-name-validation.md` (server `*.algo.spec.ts` runs this
package, hook `tool-wrap-names.algo.test.js` runs the copy).

## How it is wired

The same as `@loghub/pricing` (see `packages/pricing/README.md` and
`docs/knowledgebase/repo-local-packages.md`):

- **Server** — a `file:../packages/tool-monitor` dependency in `server/package.json`.
- **Client** — an alias in `client/vite.config.ts` and `client/tsconfig.json` (`paths`, `include`).

## Rules

- Pure TypeScript only: no dependencies, no Node or DOM APIs.
- Erasable syntax only (no `enum`, `namespace` or parameter properties).
- Relative imports end in `.ts`.
