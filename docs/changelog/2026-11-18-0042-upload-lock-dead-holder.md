# Sessions no longer wait two minutes to upload after a killed hook

The hook (2.32.3) frees an upload lock left by a process that is no longer running, so a session's logs no longer wait up to two minutes behind a killed hook (for example, a short `claude -p` session's `SessionEnd`), and `hook.log` now names the process holding the lock when an upload is skipped.
