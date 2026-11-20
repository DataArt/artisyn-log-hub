# Background log uploads through the shared receiver (hook 3.0.0, installer 1.1.0, Log Hub 1.5.0)

- Turn-end and session-end uploads no longer make Claude Code wait: the hook queues a small job and
  the per-user shared receiver uploads it in the background with that repository's own hook and API
  key; without a receiver the hook uploads itself as before.
- A session end waits at most 800 ms for a busy upload (was 20 s); with no connection an upload gives
  up after 3 s and is retried with backoff; jobs that give up are kept in `~/.artisyn/upload/failed/`
  and are queued again once the server is reachable, so sessions recorded offline (e.g. without
  VPN, even across a laptop shutdown) upload on the first successful upload in any repository.
- The shared receiver now starts even with OTEL off, and runs uploads alone when an older receiver
  holds the OTEL port.
- The hook and the installer warn when Node.js is end-of-life or misses the November 2026 security
  fixes.
