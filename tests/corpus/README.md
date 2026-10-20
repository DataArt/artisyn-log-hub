# Session corpus

Real Claude Code sessions, recorded with `claude -p` on synthetic fixture repositories, one
**set** per month and Claude Code version. The server must keep parsing every set it ever
supported (log formats change silently and users do not upgrade), and each new set shows what is
new in the logs. Design: `docs/qaa-overview/scenarios/08-session-corpus.md`; impl-plan DD I1–I3.

## Layout

```
tests/corpus/
  README.md
  known-format.json                approved line types, keys, content blocks, attachments (S-CORPUS-03)
  scenarios/scenarios.json         session scenarios: fixture repo, model, prompt, structural `expect`
  sets/
    <YYYY-MM>_cc-<ver>/            one set: one month, one Claude Code version
      manifest.json                Claude Code + hook versions, models, OS, date, generator commit,
                                   sessions, sha256 of every generated file
      <repo>__<scenario>/
        session.jsonl.gz           root transcript
        subagents/*.jsonl.gz       sub-agent transcripts (+ their .meta.json)
        hook/artisyn.jsonl.gz      telemetry of the real hook for this session
        prompts.md                 what was asked
        expected.json              approved snapshot of the stand's API answers
```

The fixture repositories are `.claude/skills/big-prod-e2e-test/fixtures/<repo>` (small, public,
no secrets). `expected.json` is not in the manifest's hashes: it is the server's answer, approved
separately (below).

## Storage (DD I3)

- `sets/` is **gitignored**: every machine records its own sets. The transcripts carry Claude
  Code's own system prompt (`prompt_snapshot` attachments), which is not ours to publish. Only
  `README.md`, `known-format.json` and `scenarios/` are in the repository.
- Without a set, S-CORPUS-01…05 are skipped (not failed). To get one:

  ```sh
  docker compose -f tests/scenarios/docker-compose.yml up -d   # Postgres for the approval run
  npm run corpus:bootstrap                                     # generate + approve format + approve expected.json
  ```

  `scripts/corpus/bootstrap.js` runs `corpus:generate` (only when no set exists, or with
  `-- --force-generate`), then the two approval steps of "Approving a new set" below.
- Keep one set per **format epoch** (a set whose "what's new" report found a change) plus the two
  latest months; delete the rest.
- The sets are still generated only on the fixture repositories and scrubbed before they are
  written: run/home paths in every spelling, the host name, e-mails outside
  `example.com`/`example.test`/`arrakis.test`, API tokens and the account-provisioned
  `anthropic-skills:*` skill listing. The generator refuses to write a file that still leaks any of
  them. Do not add sessions recorded anywhere else.

## Monthly generation (S-LIVE-01)

Needs Claude Code installed and logged in on this machine; it spends real tokens.

```sh
npm run corpus:generate                       # every scenario of scenarios/scenarios.json
npm run corpus:generate -- --scenarios fan-out --month 2026-11 --keep
```

`scripts/corpus/generate.mjs` copies each fixture repo into a fresh dir under the OS temp dir,
wires the real hook (`hook/.claude/telemetry_tool`, recording only), runs `claude -p` with an
isolated `CLAUDE_CONFIG_DIR`, then collects, scrubs and gzips the session into
`sets/<YYYY-MM>_cc-<ver>/` and writes `manifest.json`. Exit codes: 0 written, 1 a session failed
or leaked (nothing kept), 2 usage error or the set already exists, 3 Claude Code is not installed
or not logged in.

At the end it writes the report `tmp/corpus/<set>/whats-new.md` ("what's new in the Claude Code
logs") with `scripts/corpus/diff-format.mjs`: line types, keys per line type, content-block and
attachment types of the new set against the previous set and against `known-format.json`. It can
be re-run on its own: `node scripts/corpus/diff-format.mjs [<set>] [--against <set>]`.

## Approving a new set

1. Read `tmp/corpus/<set>/whats-new.md`. Update `docs/knowledgebase/log-schema/` with what is new.
2. Approve the format: `node scripts/corpus/diff-format.mjs <set> --approve` merges the set into
   `known-format.json`.
3. Approve the snapshot: `CORPUS_APPROVE=1 npm run test:scenarios -- --mode a --only corpus` writes
   `expected.json` of every session from the mode-A stand's answers. Review the diff like code:
   on an existing set, any change is either a bug or a deliberate change of the server.
4. Run `npm run test:scenarios -- --mode a --only corpus` without the variable. The set stays local
   (gitignored); commit only `known-format.json` and the `docs/knowledgebase/log-schema/` changes.

## Tests

`tests/scenarios/corpus/corpus.spec.ts`, Playwright project `corpus`, always on the mode-A stand
(`npm run test:scenarios -- --mode a --only scenarios,corpus`, check `scenarios-a`):

| ID | What |
|---|---|
| S-CORPUS-01 | Replay: every session of every set is uploaded through `POST /api/v2/logs`; repository `summary`, the session-list row (`stats`) and `change-surface` equal `expected.json`; sessions with sub-agents are opened in the UI |
| S-CORPUS-02 | Invariants: an independent oracle over the raw lines (usage non-negative, no duplicate tool calls, every sub-agent has a parent) and over the API (tree cost = root + sub-agents + utility, tokens >= 0) |
| S-CORPUS-03 | Format drift: nothing in the sets is missing from `known-format.json` |
| S-CORPUS-04 | Every set satisfies the structural `expect` of its scenario (sub-agents, tools, changed files) |
| S-CORPUS-05 | The recorded hook telemetry goes through the hook's gzip upload path against the current server |
