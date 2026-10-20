---
type: "Reference"
title: "Product Purpose and Full Data Capture (privacy is analysed, not hidden)"
description: "Why the hook and server capture session data in full (tool inputs, prompts, raw transcripts) by design: the product is a tool for analysing the Claude Code harness, including the privacy of the data that flows through it. Read before proposing redaction, minimisation or 'privacy fixes' to capture, and before reviewing tests or code for data exposure."
tags:
  - product
  - privacy
  - hook
timestamp: "2026-10-13T17:40:19+04:00"
---

# Product Purpose and Full Data Capture

## Purpose of the product

Artisyn Log Hub exists to **analyse the Claude Code harness**: what goes into the model's context, what the
agent does (tools, sub-agents, skills, rules, MCP, workflows), what it costs and how long it takes. One of the
questions the product is built to answer is **what data is exposed to the model and to tools** — i.e. the
privacy of the data that flows through the harness is itself a subject of analysis, not an afterthought.

## Consequence: capture is deliberately broad

The hook records session data in full (user prompts, tool calls with their `tool_input`, raw transcript lines,
attachments, system context). Without the complete record there is nothing to analyse: a redacted log cannot
show what the harness actually sent or what leaked into the context.

Therefore:

- **Do not treat full capture as a defect.** A review finding such as "`tool_input` is written to telemetry in
  full" or "raw logs contain file paths / prompts / secrets from the user's project" describes the intended
  behaviour, not a vulnerability in the product.
- **Do not add redaction, truncation or field-dropping to the capture path as a "privacy fix"** without an
  explicit decision from the owner. Capture-side minimisation would defeat the purpose of the tool.
- Privacy of the *collected* data is handled by **access control and consent**, not by capture minimisation:
  raw logs are owner-only, team visibility is governed by the team access modes (`transparent` /
  `restricted`), and the data-collection notice must be accepted in the UI. See
  `authorization-and-authentificaiton.md` and `api-reference.md` for the rules. These are the privacy
  behaviours worth protecting with tests.

## Known narrowing (for accuracy, not a policy change)

Capture is not literally unlimited. Example: from hook `2.16.0` the `PostToolUse` event carries the call's
identity (`tool_name`, `tool_input`, ids) and only a small derived `edit_result` for edits; the tool's own
output (`tool_response`) is not shipped, because the metric needs four derived numbers rather than file
contents or command output (see `hook-system-overview.md`, "`PostToolUse` payload change"). That narrowing is a
product/metric decision, not a privacy measure.

## Implications for testing and review

- Tests about privacy should verify **who can see the data** (owner-only raw logs, restricted team mode,
  consent gate, API-key scope), not that sensitive fields were stripped from the capture.
- Sanitisation that does exist (for example removing NUL bytes from NDJSON on upload) is for database
  compatibility, not for privacy.
- When a security or privacy audit lists "the tool stores sensitive data", check this article first: it is the
  documented purpose; only access-control, transport and retention aspects are in scope. Retention is
  documented in `data-retention.md`.

## Other deliberate behaviours (not defects)

Decisions recorded by the owner on 2026-10-13; tests, reviews and audits must not flag them:

- **Data-collection consent gates only the UI.** The server API does not refuse requests from a user who has not accepted the notice; whoever calls the API without the UI bypasses the notice knowingly. Do not add a server-side consent check as a "fix" without an explicit decision.
- **Mode 2 (`AUTH_MODE=password`) signup logs the new user in immediately.** The mode is meant for closed networks, so no email confirmation is required.
- **Mode 3 (`AUTH_MODE=password-confirm`): an unconfirmed user must NOT get a session.** After signup they only see a "check your email" page; login is refused (403 `email_not_confirmed`) until the address is confirmed. **Known defect (found 2026-10-13 by code reading, not yet reproduced at runtime):** `AuthController.signup` calls `req.logIn` for every mode and no guard re-checks `emailConfirmedAt` on an existing session, so an unconfirmed user holds a live session cookie right after signup. Not intended; tests (scenario `S-AUTH-01`) must expect no session in mode 3.
