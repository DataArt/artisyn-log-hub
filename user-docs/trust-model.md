# Trust model

Who and what you trust when you run Log Hub and install its hook.

- **The server sees everything the hook collects** — see
  [What is collected](data-collection.md#what-is-collected). Point the hook only at a server you
  trust, and use `https://` for anything that is not on your own machine. Plain `http://` is
  accepted.
- **The API key identifies you.** Uploads are attributed to the key's owner. Keep the key in the
  gitignored `log-hub.local.json`, never in the tracked `log-hub.json`.
- **The server can make the hook run `claude -p`**, with your Claude Code account and usage.
- **The hook runs with your user rights**, like any Claude Code plugin.
- **The installer is fetched with `npx` from the server** with no checksum or signature, so it is
  only as trustworthy as that server and the connection to it.
- **Inside the server,** you see your own sessions. Teams can share sessions between members: a
  member becomes visible to the team only after accepting a disclosure notice, and the team's
  access mode and roles decide who sees prompts and reports. The admin role grants no access to
  session data in the app; admins see sessions only through their own repositories or a team role
  (server operators can still reach the database and logs directly).
- **The OTEL receiver listens on `127.0.0.1` only** and has no token, so another local process
  running as you could post to it.

The known limitations and accepted risks are listed in
[Security Hardening & Configuration](security-hardening.md#11-known-limitations-and-accepted-risks).
