---
type: "Reference"
title: "Bytes-per-Token Ratio"
description: "The BYTES_PER_TOKEN constant: rationale, usage locations in the UI, and change procedures."
tags:
  - tokens
timestamp: "2026-10-29T00:00:00+04:00"
---

# Bytes-per-Token Ratio

## Purpose

This constant is used throughout the client to estimate token counts from byte lengths when
the actual token count is not available from the API (e.g. for file reads, skill content,
rule injections, CLAUDE.md context). It is **not** used for actual API-reported usage numbers.

## The Constant

```ts
export const BYTES_PER_TOKEN = 3.5;
```

**Location:** `client/src/viewer/pages/repository/session-log/log-parser.ts` (top-level export)

**Consumers:** `prompt-turn-helpers.tsx`, `ToolCallDetailModal.tsx` and
`charts/context-usage/context-data.ts` import it from `log-parser.ts`, so the value is defined in
exactly one place. The System context anatomy tab (`sysctx-anatomy/sysctx-anatomy.ts`) uses the
per-model `resolveCharsPerToken(pricing, model)` from the same file, whose default is this
constant.

## Why 3.5

Claude (and GPT-family) tokenizers use Byte-Pair Encoding (BPE). The widely-cited rule of
thumb from Anthropic's own documentation is:

> "1 token is approximately 4 characters of text for common English text."

For pure English prose (ASCII), 1 character ≈ 1 byte → **4 bytes/token**.

Claude Code sessions are **not** pure prose. They contain:

| Content type | Bytes/token (typical) |
|---|---|
| English prose | ~4.0 |
| Python / TypeScript code | ~3.0–3.5 |
| JSON / structured tool results | ~3.0–3.5 |
| File paths, URLs | ~2.5–3.5 |
| Mixed (code + text + tool results) | ~3.5 |

For the mixed content typical in a Claude Code session, **3.5** is the empirically appropriate
midpoint. It slightly overestimates tokens (i.e. is conservative), which is preferable for
context-limit warnings: better to warn users slightly early than to mislead them into
thinking more context is available than there is.

## What This Constant Is NOT Used For

- **Actual usage tokens** — `message.usage.input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, and `cache_creation_input_tokens` come directly from the Claude
  API and are never approximated.
- **Context window size at start/end of turn** — computed from `message.usage` sums, not
  from byte estimates (see `contextTokensStart` / `contextTokensEnd` on `PromptTurn`).

## Where It Is Used

| File | Usage |
|---|---|
| `log-parser.ts` | `RuleInjection.estTokens` — bytes ÷ BYTES_PER_TOKEN for CLAUDE.md rule files |
| `log-parser.ts` | `SkillInvocation.estTokens` — bytes ÷ BYTES_PER_TOKEN for skill content |
| `log-parser.ts` | `FileAccess.estTokens` — bytes ÷ BYTES_PER_TOKEN for Read tool results |
| `log-parser.ts` | `ClaudeMdContext.estTokens` — bytes ÷ BYTES_PER_TOKEN for full CLAUDE.md context |
| `sysctx-anatomy/sysctx-anatomy.ts` | ≈ tokens of every startup-context partition and row in the System context anatomy tab (via `resolveCharsPerToken`, default this constant) |
| `ToolCallDetailModal.tsx` | Default `charsPerToken` of the tool-call modal |
| `prompt-turn-helpers.tsx` | Inline token estimates for other tool call results (display and tooltip cost rows) |
| `context-data.ts` | Token estimates for context slices (tool results, images, skills, rules, system files, conversation history) |

## Changing the Constant

If empirical evidence or updated Anthropic documentation suggests a different value:

1. Update `BYTES_PER_TOKEN` in `log-parser.ts`.
2. Verify its consumers (`prompt-turn-helpers.tsx`, `ToolCallDetailModal.tsx`, `context-data.ts`)
   still import it and `resolveCharsPerToken` still falls back to it (no local override).
3. Update the table in this file if the reasoning changes.
4. Run `npm run build` and `npx vitest run` — no test values hardcode the ratio.
