# Data Collection Notice

LogHub records how you work with your AI coding assistant so it can show you cost, context and
productivity analytics. Please read this before you start.

## What LogHub stores

LogHub stores your Claude Code sessions in its own database:

- **Your prompts** — the full text of every message you send to the assistant.
- **Session transcripts** — the assistant's replies, the tools it ran and the files it touched.
- **Sub-agent and workflow transcripts** — everything spawned from your session.
- **Session metadata** — repository URL, branch, git user name, timings, token counts and costs.

This is not a summary or a sample. It is the session content itself, kept so the analytics can be
recomputed later.

## Who can see it

- **Your own repositories are private to you.** In LogHub, their sessions, prompts and
  transcripts are visible only to you, whatever role anyone else holds in LogHub.
- **In a team, what others see depends on the team's access mode.**
  - **`transparent` team:** every member sees your sessions, including your prompts.
  - **`restricted` team:**
    - the team owner and ADLC trainers see your sessions, including your prompts;
    - managers see your sessions and their statistics, but your prompts are hidden from them;
    - all other members do not see your sessions at all.
- **Administrators get no access to session data through their admin role.** The admin panel
  covers users, retention and system settings and shows only counts and totals (sessions,
  tokens, cost). An administrator sees your team sessions only through a role they hold in
  that team, like anyone else.
- **Anyone with access to the LogHub database can read everything.** The rules above describe
  what the LogHub application shows. Whoever has direct access to the LogHub database or
  server — typically the people who operate it — can read all stored sessions of all users,
  including every prompt and transcript, regardless of these rules. Debugging data is not
  covered by these rules either: administrators can download the raw file of an upload that is
  queued or failed to process, and server logs may contain fragments of session data.
- **Administrators can reset your password.** An admin can issue a password-reset link for any
  account; whoever uses that link can sign in as you.
- **Identify-only sign-in does not verify identity.** If this server runs without passwords
  (identify-only sign-in), whoever signs in with your email address acts as you and sees what
  you see.

## If the assistant handles secrets

If you paste a credential into a prompt, or the assistant prints one while running a command, that
credential is part of the transcript — and it is stored in the LogHub database like the rest of the
session. Stored session data is purged after {{RETENTION_DAYS}} days, so until then the secret
lives here too.

**The advice is not "trust LogHub" — it is: do not give credentials to the AI at all.** A secret
that reached this database already passed through your terminal, your shell history and the model
provider. If a secret sitting in the LogHub database worries you, LogHub is not the biggest problem
in that setup.

## Alternatives to handing credentials to the assistant

Set things up so the assistant never needs a secret in the first place:

- **Host-level authentication** — log the machine in once (`gcloud auth login`, `az login`,
  `docker login`) and let the tooling read the ambient session.
- **SSH certificates or agent forwarding** — the assistant uses the key without ever seeing it.
- **Short-lived tokens** — minutes-long, narrowly scoped credentials that are useless once the
  session ends.
- **A secret manager** — keep secrets in Vault, 1Password, AWS Secrets Manager or the like and
  have your scripts fetch them at run time, outside the transcript.
