---
type: "Algorithm"
title: "Work Hub connection fields: base URL, remote name, PAT, key and exposed env name"
description: "The per-value shape rules for what a user types into a Work Hub connection or remote: the base URL of a provider, a remote name, a personal access token, an uploaded private key and the name of the env variable a token connection may be exposed as in sessions."
tags: [algorithm]
generated: { by: "human:denistsyplakov", at: "2026-11-22T22:40:23+04:00" }
reviewed: no
reviewer: none
---

# Work Hub connection fields: base URL, remote name, PAT, key and exposed env name

## Purpose

A connection and its remotes carry a few values that end up in URLs, git config, files in the git
proxy sidecar and session environments. Each is checked for shape before anything is stored, so a
bad value is refused with a readable message instead of failing later inside a container.
Uniqueness (connection name, remote name per workspace, exposed name per user, clash with a
workspace's `containerEnv`) is checked by the services against the database and is not part of
this doc; connection names follow [workhub-names](workhub-names.md).

## Code

- Implementation: `work-hub/server/src/connections/fields.rs` (`validate_base_url`,
  `validate_remote_name`, `validate_pat`, `validate_private_key`, `is_env_name`,
  `validate_expose_env`, `FieldError`). Callers: `connections/service.rs` (base URL, PAT, key,
  exposed name) and `workspaces/remotes.rs` (remote name).
- Twins: none. The web UI only shows the server's message.
- Test: `work-hub/server/tests/algo.rs` (`workhub_connection_fields`; the agent token variables
  come from the real `AgentRegistry`), run by `npm run test:algo` from `work-hub/`.

## Input and output

A value (and for some fields a provider or an auth method) → `ok` (the base URL also returns its
normalized form) or an error rule. The API answers `400` with the code: `invalid_env_name`,
`expose_not_allowed`, `invalid_remote_name`, or `invalid_connection` for the base URL, PAT and key.

## Rules

1. **Base URL** (trimmed).
   - A provider with a fixed base URL takes it when the value is empty or equals it ignoring case
     and a trailing `/`.
   - Otherwise it must parse as an absolute URL with a host (`base_url_not_url`), scheme `https`
     or — when the provider allows it — `http` (`base_url_scheme`), and no query, fragment or
     userinfo (`base_url_extra`).
   - Normalized by the URL parser (host lowercased, the scheme's default port dropped), then one
     trailing `/` run stripped; it must match the provider's `base_template` (`base_url_form`).
2. **Remote name.** `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (ASCII), not ending in `.lock`.
3. **PAT.** 1–4096 characters (not bytes); no whitespace or control character anywhere — nothing
   is trimmed.
4. **Private key.** At most 16384 bytes; after leading whitespace it begins with `-----BEGIN`.
5. **Exposed env name.**
   - Only a `pat` connection can expose one, else `expose_not_allowed` (checked first).
   - `^[A-Z_][A-Z0-9_]*$`, at most 64 characters.
   - Not one of `PATH HOME USER SHELL TERM LANG PWD HOSTNAME` (exact match), not starting with
     `WH_`, and not any registered agent's token variable (`token_env()` of each adapter).
   - Any violation → `env_name`.

## Edge cases

- Env name: valid CF-01, CF-02; leading digit CF-03; lower case CF-04; `-` CF-05; empty CF-06;
  reserved CF-07, CF-08 and a near miss CF-09; `WH_` CF-10 and a near miss CF-11; agent token
  CF-12; non-PAT method CF-13, checked before the name CF-14; 64/65 characters CF-15, CF-16.
- Remote name: valid CF-17..CF-19; bad first character CF-20, CF-21; `/` CF-22; space CF-23;
  empty CF-24; `.lock` CF-25 and a near miss CF-26; non-ASCII CF-27; 64/65 characters CF-28,
  CF-29.
- Base URL: fixed base CF-30..CF-32; trailing `/` CF-33; sub-path CF-34; no scheme CF-35; http
  CF-36; other scheme CF-37; query CF-38; fragment CF-39; userinfo CF-40; generic http CF-41;
  case and port CF-42, CF-43; Azure organization CF-44..CF-46.
- PAT: valid CF-47; empty CF-48; space CF-49; line break CF-50; 4096/4097 CF-51, CF-52;
  characters not bytes CF-53.
- Key: valid CF-54; leading whitespace CF-55; public key CF-56; empty CF-57; 16384/16385 bytes
  CF-58, CF-59.

## Examples

`field` is `env`, `remote`, `base`, `pat` or `key`; `value` is a string or, for long values,
`{before?, repeat, times}` meaning `before` + `repeat` repeated `times` times. `expected` lists
the keys the row pins (`error` is the rule, `code` the API code).

Rows (59): [`docs/algorithm-examples/workhub-connection-fields.json`](../../algorithm-examples/workhub-connection-fields.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Reserved names matched as prefixes -> CF-09; `WH` matched without `_` -> CF-11.
- Agent token variables not checked -> CF-12.
- Name checked before the method -> CF-14.
- `.lock` matched anywhere -> CF-26; non-ASCII letters allowed -> CF-27.
- PAT trimmed -> CF-50; length in bytes -> CF-53; `>=` instead of `>` -> CF-51.
- Key leading whitespace not allowed -> CF-55; limit off by one -> CF-58.
- Fixed base compared case-sensitively -> CF-31; default port kept -> CF-43; template not checked
  -> CF-45, CF-46.

## Where the result is visible

`400` answers of `POST`/`PATCH /api/v1/connections`, `POST /api/v1/workspaces/{id}/remotes` and
the clone path of `POST /api/v1/workspaces`, shown under the field in the Add / Edit connection
and Attach remote dialogs.
