---
type: "Algorithm"
title: "Work Hub remote URL: pasted git URL to upstream URL"
description: "A user pastes a repository URL (https, http, ssh:// or scp form) when cloning or attaching a remote through a connection. This rule takes it apart, checks it belongs to the connection's provider and base URL, and builds the upstream URL the git proxy talks to, plus the repository and pull-request web pages."
tags: [algorithm]
generated: { by: "claude-code", at: "2026-11-22T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# Work Hub remote URL: pasted git URL to upstream URL

## Purpose

When a workspace is cloned from a connection or a remote is attached to one, the user pastes the
repository URL as the host shows it (HTTPS, `ssh://` or the scp form `git@host:path`). Work Hub
must refuse a URL that is not on the connection's host, and must build the URL the git proxy
sidecar actually fetches from and pushes to, which depends on the connection's auth method, not on
the pasted transport. The same variables give the "open a pull request" page after a push.

## Code

- Implementation: `work-hub/server/src/connections/remote_url.rs` (`parse`, `resolve`, `pr_url`,
  `UrlError`), over the provider rows of `connections/providers.rs` (doc
  [workhub-git-providers](workhub-git-providers.md)) and the template language of
  `connections/template.rs`. Callers go through `connections/check.rs` (`resolve_url`):
  `work-hub/server/src/workspaces/remotes.rs`, `workspaces/clone.rs`, `workstreams/close.rs`
  (`pr_url`) and the connection Test / branches calls in `check.rs` itself.
- Twins: none. The web UI sends the pasted text and shows the server's answer.
- Test: `work-hub/server/tests/algo.rs` (`workhub_remote_url`), run by `npm run test:algo` from
  `work-hub/`.

## Input and output

- `parse(url)` → `{scheme: https|http|ssh, user, host, port, path}` or `not_a_git_url`.
- `resolve(provider, baseUrl, authMethod, parsed)` → `{upstream, web, vars}` or one of
  `wrong_host`, `wrong_path`, `transport_mismatch`, `http_not_allowed`. Every error is answered as
  `400 invalid_remote_url` with the rule's message.
- `pr_url(provider, baseUrl, vars, target, branch)` → the page URL or none.

## Rules

1. **Parse.** Trimmed; empty, whitespace or control characters → `not_a_git_url`.
   - `scheme://[user[:password]@]host[:port]/path` with scheme `https`, `http` or `ssh` (any
     case). A query or fragment → `not_a_git_url`. The password is dropped.
   - Otherwise the scp form `user@host:path` (user without `:` or `/`, host without `/`, no IPv6).
   - The host is lowercased; IPv6 keeps its brackets. The port must be 1–65535.
   - The path loses leading and trailing `/` and one trailing `.git`. Empty, an empty segment, `.`
     or `..` → `not_a_git_url`.
2. **http.** An `http://` URL for a provider without `allow_http` → `http_not_allowed` (checked
   first).
3. **Base.** The base URL is matched against the provider's `base_template` (its variables, e.g.
   Azure's `{org}`, join `vars`; `{base}` is the whole base URL).
4. **HTTP(S) URLs** must have the base host and the base port (the scheme's default when not
   written), else `wrong_host`. The path must start with the base path's segments and have at
   least one more, else `wrong_path`; the rest is matched against `https_path`.
5. **SSH URLs** must have the provider's SSH host (the base host when the descriptor names none),
   else `wrong_host`; the path is matched against the SSH path template.
6. A template mismatch → `wrong_path`. A variable matched twice (base and SSH path) must agree,
   ignoring case, else `wrong_path`.
7. **Upstream** (providers with an SSH rule):
   - SSH auth: `ssh://<ssh user>@<ssh host>:<port>/<ssh path><.git?>`; the port is the pasted
     `ssh://` port when there is one, else the descriptor's.
   - PAT: `<base url>/<https path><.git?>`.
   - `.git` is appended when the descriptor's `git_suffix` is set. `web` is
     `<base url>/<https path>`.
8. **Generic** (no SSH rule): the transport must match the auth method — SSH auth needs an SSH
   URL, PAT an http(s) URL — else `transport_mismatch`. An SSH URL must be on the base host. The
   pasted URL is the upstream exactly as written (scp form stays scp, port and `.git` kept);
   `web` is none.
9. **PR page.** The provider's `pr_url` template with `{web}` = base URL (no trailing `/`),
   `{target}` and `{branch}` percent-encoded (everything except unreserved characters and `/`,
   byte by byte in UTF-8) and the matched variables. No template → none.

## Edge cases

- Parse: case and `.git/` RU-01, scp RU-02, IPv6 RU-03, password dropped RU-04, no scheme RU-05,
  other scheme RU-06, empty path RU-07, `..` RU-08, query RU-09, space RU-10.
- GitHub: HTTPS × PAT RU-11, HTTPS × SSH RU-12, scp × SSH RU-13, `ssh://` × PAT RU-14, explicit
  SSH port RU-15; wrong host RU-16, wrong port RU-17, wrong SSH host RU-18, page URL RU-19, http
  RU-20, garbage RU-21.
- GitLab nested groups RU-22, upper-case host RU-23, scp × PAT RU-24; sub-path base RU-25, RU-26,
  outside it RU-27, the base itself RU-28; http RU-29; `ssh://` × PAT RU-46, `ssh://` with port ×
  SSH RU-47.
- Azure with userinfo RU-30, HTTPS × SSH RU-31, scp × PAT RU-32, other org RU-33, web host over
  SSH RU-34; `ssh://` × PAT RU-48, `ssh://` × SSH RU-49.
- Generic: http × PAT RU-35, scp RU-36, `ssh://` with port RU-37, HTTPS port RU-38, transport
  mismatch both ways RU-39, RU-40, SSH on another host RU-41.
- PR pages with encoding: GitHub RU-42, GitLab RU-43, Azure non-ASCII RU-44; generic none RU-45.

## Examples

`op` is `parse`, `resolve` or `pr`. `expected` lists the keys the row pins; `vars` is compared
whole when present.

Rows (45): [`docs/algorithm-examples/workhub-remote-url.json`](../../algorithm-examples/workhub-remote-url.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Port ignored when comparing hosts -> RU-17.
- Base path prefix not checked -> RU-27; base path alone accepted -> RU-28.
- Variables not cross-checked between base and SSH path -> RU-33.
- Upstream follows the pasted transport instead of the auth method -> RU-12, RU-14, RU-32.
- `.git` always appended -> RU-30; never appended -> RU-11.
- Generic upstream rebuilt instead of pasted as is -> RU-36, RU-37.
- Transport check dropped -> RU-39, RU-40.
- `http_not_allowed` checked after the host (the http port 80 is not the base port) -> RU-20,
  RU-29.
- `/` percent-encoded in branches -> RU-42; bytes encoded per char instead of per UTF-8 byte ->
  RU-44.

## Where the result is visible

`400 invalid_remote_url` with the rule's message on `POST /api/v1/workspaces` (clone from a
connection) and `POST /api/v1/workspaces/{id}/remotes`; the upstream URL in the sidecar's route
for the remote; the "Open pull request" link after a push on close.
