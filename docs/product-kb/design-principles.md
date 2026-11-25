---
type: "Reference"
title: "Product Design Principles"
description: "Cross-cutting product rules every feature follows; first one: show, don't limit — non-breaking anti-patterns are surfaced to the user, not silently capped."
tags: ["principles", "product", "ux", "limits"]
generated:
  by: "claude-opus-5-5"
  at: "2026-11-25T12:00:00Z"
---

# Product Design Principles

Rules that apply to every feature. Read before designing limits, caps, validation or filtering of
user-provided data.

## 1. Show, don't limit

If the user does something that is an anti-pattern but does not break Log Hub — too many tags, a
volatile value used as a label, a noisy config, an unusually large session — Log Hub **does not
silently cap, drop or hide it. It shows it**, with a warning that says what is wrong and how to fix
it at the source.

Why: Log Hub exists to make what happens in AI sessions visible. A tight cap hides exactly the
misconfiguration the user needs to see; the data just looks "a bit short" and nobody learns why.
A warning turns the anti-pattern into something the user can act on.

How to apply:

- **Hard limits only as breakage guards.** A limit is legitimate when exceeding it would break
  storage, an index, a request or the UI (a btree row-size limit, a runaway writer). Set it far
  above any honest use (orders of magnitude, not "a comfortable number"), and say in the code /
  requirements that it is a guard, not a cleanliness rule.
- **When a guard does trigger, say so.** Hitting a limit is itself shown to the user ("only the
  first N stored"), never silent.
- **Detect the anti-pattern, don't prevent it.** Add a cheap read-time check (e.g. "this key has
  > 10 values in one session — looks like a changing value") and surface it where the user looks
  at the data.
- **The warning names the fix**, in the user's terms (which setting / file / env var to change).

Example: session tags (task `2026-11-24-otel-session-tags`) — the per-session cap is 500 pairs as a
runaway guard; a key with many values in one session is flagged as noisy in the session header and
the pickers, instead of the originally proposed cap of 20.
