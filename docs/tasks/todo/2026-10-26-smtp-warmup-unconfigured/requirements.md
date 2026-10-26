# 2026-10-26: Skip SMTP Warm-Up When SMTP Is Not Configured

**Status:** todo
**Priority:** low
**Type:** bug
**Module(s):** server
**Owner:** denis.tsyplakov
**Created:** 2026-10-26

## Description

On a fresh install with no SMTP configured (`AUTH_MODE=none` from the release installer,
`SMTP_HOST` unset) every cluster worker logs at startup
`WARN {MailService} SMTP connection warm-up failed (will retry lazily on first send): Error: connect ECONNREFUSED 127.0.0.1:587`
— 15 lines on a 15-worker host. Observed on the v1.0.1 GHCR image in an isolated install test.

Cause: `MailService.onModuleInit` (`server/src/mail/mail.service.ts`) always awaits
`transporter.verify()`, even though the same class has `isConfigured()` (non-empty `SMTP_HOST`)
that callers already use to skip sends; with `SMTP_HOST` unset nodemailer falls back to
`localhost:587`.

Fix direction: skip the warm-up when `!isConfigured()` (optionally log one debug/info line), keep
the warm-up and its warning when SMTP is configured (Modes 2/3 with a relay).

Noise only, no functional impact, but it makes the logs of a fresh install look broken.

## Functional Requirements

- FR-1: When SMTP is not configured (`isConfigured()` is false — `SMTP_HOST` empty or unset),
  `MailService` does not attempt the startup SMTP warm-up and logs no warning about it.
- FR-2: When SMTP is configured, the startup warm-up runs as today, and a failed warm-up still logs
  the existing warning.
- FR-3: The "configured" signal stays the single existing one (`isConfigured()`, mirroring
  `auth-startup-validation.ts`), not a new check.

## Acceptance Criteria

- [ ] Starting the app with `SMTP_HOST` unset (e.g. a fresh install from the release installer,
      `AUTH_MODE=none`) produces no `SMTP connection warm-up failed` line in any worker's log.
- [ ] Starting the app with `SMTP_HOST` pointing to an unreachable relay still logs
      `SMTP connection warm-up failed` once per worker.
- [ ] Starting the app with a reachable relay (e.g. Mailpit in mode B of the scenario suite) logs no
      warm-up warning, and the first email send still works.

## Steps to Reproduce

1. Install a release with the one-line installer on a clean Docker host (generated `.env` has
   `AUTH_MODE=none` and no `SMTP_*` settings).
2. `docker logs artisyn-log-hub`.

**Expected:** no SMTP-related warnings; nothing about mail is configured or needed.
**Actual:** one `SMTP connection warm-up failed ... ECONNREFUSED 127.0.0.1:587` warning per
cluster worker.

## Notes

<!-- Append timestamped notes here as work progresses -->
