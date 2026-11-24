---
type: "Algorithm"
title: "Work Hub git providers: descriptor table and derived values"
description: "Every git host product Work Hub knows (GitHub, GitLab, Azure DevOps, a generic git server) is one row of a descriptor table. From a row and a connection, Work Hub derives the git auth header, the connection Test API request, the token and SSH-key pages, the user name in an SSH greeting and the API flags the UI reads."
tags: [algorithm]
generated: { by: "human:denistsyplakov", at: "2026-11-22T22:40:23+04:00" }
reviewed: no
reviewer: none
---

# Work Hub git providers: descriptor table and derived values

## Purpose

Work Hub never branches on a provider name outside one file. Each provider is a descriptor row,
and everything provider-specific — which auth methods are offered, the HTTP Basic user of a token,
how the Test button checks a token, which page to open to create a token or add a key, how to
read the user from `ssh -T` — is derived from that row. This doc pins the table and those
derivations.

## Code

- Implementation: `work-hub/server/src/connections/providers.rs` (`all`, `get`, `Provider`,
  `git_header`, `api_request`, `token_page_url`, `ssh_keys_page_url`, `greeting_user`,
  `base64_encode`), templates filled and matched by `connections/template.rs`. Callers:
  `connections/check.rs` (Test), `connections/service.rs`, `api/connections.rs`
  (`GET /api/v1/connection-providers`), `gitproxy/` (the `header` file).
- Twins: none. The web UI reads the descriptor fields from the API.
- Lint guard: `work-hub/scripts/provider-names-check.mjs` fails when a provider is named in
  `server/src` outside `providers.rs`, or anywhere in `web/src`.
- Test: `work-hub/server/tests/algo.rs` (`workhub_git_providers`), run by `npm run test:algo`
  from `work-hub/`.

## Input and output

A provider id (plus a base URL, a PAT, a username or a text, per derivation) → the derived value,
or none when the provider has no such feature.

## Rules

1. **Table.** `github`, `gitlab`, `azure-devops`, `generic`, in that order. All four offer
   `ssh_generated`, `ssh_uploaded` and `pat`. An unknown id has no descriptor.
2. **PAT user.** `github` → `x-access-token`, `gitlab` → `oauth2`, `azure-devops` → `pat`;
   `generic` → the connection's `username` (so `needsUsername` is true only for generic).
3. **Git header** (the sidecar's per-connection `header` file): always
   `Authorization: Basic base64(<PAT user>:<PAT>)`.
4. **API test request.** `{web}` = base URL without a trailing `/`, `{token}` = PAT,
   `{basic}` = `base64(<PAT user>:<PAT>)`.
   - github: `https://api.github.com/user`, `Authorization: Bearer {token}`.
   - gitlab: `{web}/api/v4/user`, `PRIVATE-TOKEN: {token}`.
   - azure-devops: `{web}/_apis/connectionData`, `Authorization: Basic {basic}`.
   - generic: none (Test runs `git ls-remote` against a repository URL instead).
5. **Pages.** Token and SSH-key page templates with `{web}` filled; github's are fixed URLs,
   gitlab's and azure's sit under the base URL (sub-path included); generic has none.
6. **Greeting.** The one-line template is searched in every line of the `ssh -T` output (CR
   stripped); `{user}` is a run without whitespace, the shortest that lets the rest match.
   github `Hi {user}! You've successfully authenticated`, gitlab `Welcome to GitLab, @{user}!`;
   azure and generic have none, so no user is ever read.
7. **base64.** Standard alphabet with `=` padding (RFC 4648 §4), hand-written (no crate).
8. **Flags for the UI.** `baseUrlFixed` is only github's; `allowHttp` and `testNeedsUrl` only
   generic's; `prLabel` is `merge request` for gitlab, `pull request` for github and azure,
   none for generic.

## Edge cases

- Table order GP-01; flags per provider GP-02..GP-05; unknown id GP-06.
- Git header per provider GP-07..GP-10; a fixed PAT user ignores a username GP-11.
- API request per provider GP-12..GP-15 (trailing `/` of the base URL GP-13).
- Pages per provider GP-16..GP-19 (sub-path GP-17).
- Greeting: one line GP-20, after a warning line with CRLF GP-21, denied GP-22, gitlab GP-23,
  none for azure GP-24 and generic GP-25.
- base64 of 0, 1, 2, 3, 6 and 4 bytes: GP-26..GP-31 (RFC 4648 §10 vectors).

## Examples

`op` is `list`, `describe`, `header`, `api`, `pages`, `greeting` or `base64`. `expected` lists the
keys the row pins.

Rows (31): [`docs/algorithm-examples/workhub-git-providers.json`](../../algorithm-examples/workhub-git-providers.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Generic PAT user fixed instead of from the connection -> GP-10.
- Username preferred over a fixed PAT user -> GP-11.
- Base URL trailing `/` kept -> GP-13, GP-17.
- Azure API test with Bearer instead of Basic -> GP-14.
- Greeting matched only on the first line -> GP-21; `{user}` taken greedily -> GP-20.
- Padding dropped -> GP-27, GP-28; padding added on full groups -> GP-29.

## Where the result is visible

`GET /api/v1/connection-providers` (tiles, fields and links of the Add connection dialog); the
connection Test result ("Signed in as …"); the sidecar's `header` file that git sends upstream.
