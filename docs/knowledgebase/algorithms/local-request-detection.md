---
type: "Algorithm"
title: "Local request detection: who may use passwordless mode"
description: "In `AUTH_MODE=none` anyone can identify as any e-mail without a password, so that mode is limited to requests from the same machine. This rule decides whether a request is \"local\"."
tags: [algorithm]
generated: { by: "ai:claude-opus-5-5", at: "2026-11-25T16:00:00+04:00" }
reviewed: 2026-10-15
reviewer: ai
---

# Local request detection: who may use passwordless mode

## Purpose

In `AUTH_MODE=none` anyone can identify as any e-mail without a password, so that mode is limited
to requests from the same machine. This rule decides whether a request is "local". It is the only
protection of mode `none`: a wrong "yes" opens the server to the network, a wrong "no" locks the
owner out (in the released Docker image the owner's own browser arrives from the container
gateway, never from loopback).

## Code

- Implementation:
  - `server/src/auth/utils/localhost.util.ts` (`isLocalhostRequest`);
  - `server/src/auth/utils/container-gateway.util.ts` (`resolveTrustedGateway`,
    `isContainerized`, `parseDefaultGatewayIpv4`, `isTrustablePrivateIpv4`; `getTrustedGateway`
    memoizes `resolveTrustedGateway` for the process);
  - `server/src/auth/utils/trusted-peers.util.ts` (`parseTrustedPeers`; `getTrustedPeers`
    memoizes it over `AUTH_NONE_TRUSTED_PEERS`).
- Twins: Work Hub's Rust port `work-hub/server/src/auth/local_request.rs` (`is_local_address`
  takes the peer address, the trusted gateway and the trusted peers directly, so part A rows never
  build a request; `resolve_trusted_gateway` and `is_trustable_private_ipv4` take an `FsProbe`;
  `parse_trusted_peers` is part C). It runs every row
  in `work-hub/server/tests/algo.rs` (`cargo test --test algo`, i.e. `npm run test:algo` from
  `work-hub/`).
- Test: `server/src/auth/utils/localhost.util.algo.spec.ts`.

## Rules

**A. Is the request local?** Only the TCP peer address (`req.socket.remoteAddress`) is used; any
`X-Forwarded-For` header is ignored (it is trivially spoofable).

1. Missing address: treat as `""`.
2. Strip a leading `::ffff:` (an IPv4 address arriving on the dual-stack socket; Node always
   reports it in lower case, and only that exact lower-case prefix is stripped, so
   `::FFFF:127.0.0.1` stays as it is and is not local).
3. Local if the result is exactly `127.0.0.1` or `::1` (other `127.x` addresses are not).
4. Otherwise local only if the result equals exactly the trusted gateway (part B, when there is
   one) or one of the configured trusted peers (part C).

**B. Trusted gateway** (resolved once per process; `null` = none):

5. Only inside a container. The process counts as containerized when any one signal fires,
   checked in this order:
   1. a marker file exists: `/.dockerenv`, `/run/.containerenv`, `/run/.toolboxenv`,
      `/.dockerinit`;
   2. a platform variable that is non-blank after trimming: `KUBERNETES_SERVICE_HOST`, `ECS_CONTAINER_METADATA_URI`,
      `ECS_CONTAINER_METADATA_URI_V4`, `FLY_ALLOC_ID`, `DYNO`, `RENDER`, `CODESPACES`,
      `REMOTE_CONTAINERS`, `DEVCONTAINER`; or `container` set to one of `docker`, `podman`,
      `oci`, `lxc`, `crio`, `containerd`, `systemd-nspawn` (trimmed, any case);
   3. `/proc/1/cgroup` contains, as a plain substring anywhere (any case), `docker`, `containerd`, `kubepods`, `libpod`, `lxc`, `garden`,
      `crio`, `ecs`, `buildkit` or `actions_job` (any case);
   4. `/proc/self/mountinfo` has the mount point `/` with filesystem type exactly `overlay`, or a
      mount at `/etc/hostname` or `/etc/resolv.conf` (of any type; it is not checked to be a bind
      mount) whose root or source contains `docker/containers`, `containerd`, `kubelet/pods` or
      `containers/storage` (case-sensitive). A mountinfo row counts only if it has the ` - `
      separator (the first one in the row; each side is trimmed and split on whitespace), at least 5 fields before it and at least 2 after it: the 4th and 5th fields
      before it are the root and the mount point, the 1st and 2nd after it the type and source;
   5. `/proc/1/comm`, trimmed, is non-empty and not a host init (`systemd`, `init`, `upstart`,
      `openrc-init`, `runit`, `procd`, `launchd`; compared case-sensitively);
   6. the process itself is PID 1.
6. The gateway comes from `/proc/net/route` (each line trimmed and split on whitespace; the
   header row is ignored like any other non-matching row). Only rows with at least 7 fields,
   `Destination` `00000000` (a default route), a `Gateway` of exactly 8 hex digits (any case)
   other than `00000000`, and a `Metric` that JavaScript `Number()` turns into an integer (so `1e2`, `0x10` and `-1` count,
   `1.5` and `5abc` do not). The gateway hex is little-endian
   (`010011AC` -> `172.17.0.1`). Among the counted rows the lowest `Metric` wins; on equal
   metrics the first one in the file. No such row: no gateway.
7. The gateway is trusted only if it is a well-formed IPv4 address (exactly four parts, each 1-3
   decimal digits and at most 255) in a private range: `10.0.0.0/8`, `172.16.0.0/12` (second
   octet 16-31), `192.168.0.0/16` or `169.254.0.0/16`.
8. Probing never crashes startup: the real file probe treats any file it cannot read as
   missing, and any other error while resolving means no gateway.

**C. Configured trusted peers** (`AUTH_NONE_TRUSTED_PEERS`, read once per process):

9. The value (unset = empty) is split on commas and whitespace; empty entries are skipped. An
   entry is kept only if it passes rule 7 as it is (a plain private IPv4 address: no `::ffff:`
   form, no subnet, no name); a repeat is kept once, in first-seen order. Every other entry is
   rejected (the server logs the rejected ones at startup in mode `none`) and does not affect the
   kept ones.

Why part C exists: some runtimes deliver host traffic to the published port from neither loopback
nor the container's gateway. Rancher Desktop on Windows forwards `127.0.0.1:5003` through its own VM
network, so the peer is `192.168.127.1` while the gateway is the compose bridge's `172.x.0.1`. The
release installer finds that address itself: after `docker compose up -d` it calls
`GET /api/v1/auth/local-check` from the host, and on `local: false` writes the reported `peer` into
`.env` and restarts the app (`release-template/install.ps1`, `install.sh`).

The rows test each signal kind, not every listed name: the other marker files, platform
variables, `container` values, cgroup words, bind-source words and host-init names are
configuration lists checked by the same code path as the one tested member.

## Edge cases

- IPv4-mapped loopback and other loopback-looking addresses: LR-03, LR-06.
- No address: LR-07.
- Spoofed `X-Forwarded-For`: LR-08.
- Gateway trusted in a container, mapped form, a neighbour in the same subnet, no gateway:
  LR-09..LR-12.
- Bare host with a private gateway is not trusted: LR-14; blank platform variables are not a
  signal: LR-35.
- Each container signal on its own: LR-13 (marker), LR-43 (platform variable), LR-29
  (`container=` value), LR-30 (cgroup), LR-31 (overlay root), LR-32, LR-50, LR-51 (mounts at
  `/etc/hostname` and `/etc/resolv.conf`, hint in root or source), LR-33 (PID 1 name), LR-34
  (own PID 1). Not signals: overlay elsewhere (LR-49), a blank comm (LR-52).
- Upper-case `::FFFF:` prefix: LR-48. A peer that only starts with the gateway: LR-53.
- A route row of exactly 7 fields: LR-47.
- Public gateway inside a container: LR-15; no route file: LR-16; two default routes: LR-17;
  on-link `00000000` gateway skipped even with the lowest metric: LR-18; non-default routes
  ignored: LR-27; equal metrics: LR-28; malformed route rows (in LR-29); a leading space: LR-71.
- Probing throws: LR-36.
- Rancher Desktop peer with and without a configured peer: LR-77, LR-78; a configured peer's
  neighbour: LR-79; loopback still local next to configured peers: LR-80.
- Parsing the configured peers: the installer's value (LR-81), separators, blanks and repeats
  (LR-82), rejected forms (LR-83), unset (LR-84), a rejected entry next to a kept one (LR-85).
- Private ranges: `172.15`/`172.16`/`172.31`/`172.32` (LR-19..LR-22), `10` vs `11` (LR-23, LR-40),
  `192.168` vs `192.167`/`192.169` (LR-37, LR-38, LR-24), `169.254` vs `169.253` (LR-25, LR-39);
  malformed addresses: LR-26, LR-41, LR-42, LR-44, LR-45, LR-46.

## Examples

Four kinds of rows.

- `"kind": "request"`: `remoteAddress` (or `null` for none), optional `headers`,
  `trustedGateway` (the result of part B for this process, or `null`) and optional
  `trustedPeers` (the kept list of part C; absent = none). The fake request's `ip`
  is what Express would report behind a trusted proxy: the `X-Forwarded-For` value if given,
  else the peer address. Expects `local`.
- `"kind": "peers"`: `raw`, the `AUTH_NONE_TRUSTED_PEERS` value (`null` = unset). Expects
  `peers` (kept) and `rejected`, both in input order.
- `"kind": "gateway"`: a fake machine for part B. `files` maps a path to its content (a path not
  listed does not exist), `env` is the environment, `pid` the process id; with `"throws": true`
  every file access fails with an error. Expects `trustedGateway`.
- `"kind": "private"`: one address for rule 7. Expects `trusted`.

A route file is the header line plus rows of tab-separated fields
`Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT`.

Rows (84): [`docs/algorithm-examples/local-request-detection.json`](../../algorithm-examples/local-request-detection.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `::ffff:` not stripped -> LR-03, LR-10.
- Loopback as `startsWith('127.')` -> LR-06.
- `X-Forwarded-For` or `req.ip` honoured -> LR-08 (the fake request's `ip` is the header value).
- Gateway subnet trusted instead of one address -> LR-11.
- A fixed Docker gateway (`172.17.0.1`) trusted without asking part B -> LR-12.
- Gateway trusted outside a container -> LR-14.
- Public gateway trusted -> LR-15.
- Hex read big-endian -> LR-13 (`1.0.17.172`, public, so `null`).
- Highest metric wins -> LR-17 (`192.168.1.1`); last of equal metrics wins -> LR-28.
- On-link `00000000` gateway kept -> LR-18 (`0.0.0.0` wins on metric 0, then refused: `null`).
- Destination not checked -> LR-27 (`192.168.1.1`).
- Hex gateway matched case-sensitively, or a non-integer metric read as 0 -> LR-29.
- Any single container signal removed -> its row: LR-43 (platform variable), LR-29
  (`container=` value, also its trim and case), LR-30 (cgroup), LR-31 (overlay root), LR-32 and
  LR-50 (bind mount by root and by source), LR-51 (`/etc/resolv.conf`), LR-33 (PID 1 name), LR-34
  (own PID 1). Platform variables not trimmed -> LR-35.
- Overlay accepted at any mount point -> LR-49; any overlay-like type -> LR-57. A blank comm
  taken as a signal -> LR-52; comm compared case-insensitively -> LR-61.
- Mountinfo field minimums off by one: more than 5 / 2 required -> LR-54; at least 1 after the
  separator -> LR-63. Equivalent: at least 4 before it (the mount point is the 5th field, so a
  4-field row never names `/`).
- Negative metrics refused -> LR-64. Metrics checked as plain digits -> LR-69, LR-73.
- Bind hint counted at any mount point -> LR-70. Route lines not trimmed -> LR-71. The last
  ` - ` taken as the separator -> LR-72. A trusted gateway replacing the loopback check -> LR-65.
- Cgroup words matched as whole words -> LR-66; type checked with a prefix -> LR-67.
- Cgroup words case-sensitive -> LR-56; bind hints case-insensitive -> LR-58.
- Metric read with `parseFloat`/`parseInt` -> LR-59. Gateway pattern not anchored or not 8
  digits -> LR-60. `169.254` widened -> LR-62.
- Rows of exactly 7 route fields skipped (`> 7`) -> LR-47.
- `::ffff:` stripped case-insensitively -> LR-48. Gateway compared by prefix -> LR-53.
- No `try`/`catch` around probing -> LR-36 (throws instead of `null`).
- `172.16.0.0/12` as `b > 16` or `b < 31` -> LR-20, LR-21; `b >= 15` / `b <= 32` -> LR-19,
  LR-22.
- First octet not checked in the 172 / 192 / 169 branches -> LR-74, LR-75, LR-76.
- `192.168` branch dropped -> LR-37; `b <= 168` -> LR-38; `169.x` with any `b` -> LR-39;
  `a >= 10 && a <= 11` -> LR-40.
- Octet range not checked -> LR-26; `>= 255` instead of `> 255` -> LR-68; part count not checked -> LR-41, LR-46; digits not checked
  (octets read with `Number`) -> LR-42, LR-44, LR-45.
- Configured peers ignored -> LR-77; trusted by subnet or prefix -> LR-79; replacing loopback ->
  LR-80. Parsing: whitespace not a separator -> LR-82; repeats kept -> LR-82; rule 7 not applied
  (public, subnet, name or mapped form kept) -> LR-83; one bad entry drops the whole list -> LR-85.
- Not in the table: the per-process memos of `getTrustedGateway` / `getTrustedPeers` and
  `nodeFsProbe` swallowing real filesystem errors.

## Where the result is visible

Mode `none`: `POST /api/v1/auth/identify` answers `403` (`error: "not_local"`, the message names
the peer address it saw) to a non-local request, and the auto-identify guard does not sign it in,
so the login page cannot be used from another machine; the login page shows that message.
`GET /api/v1/auth/local-check` returns `{local, peer}` for the caller (the installer's probe). At
startup in mode `none` the server logs the trusted gateway and the configured peers, and warns
about rejected peers.
