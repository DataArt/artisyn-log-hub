---
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
    memoizes `resolveTrustedGateway` for the process).
- Twins: none.
- Test: `server/src/auth/utils/localhost.util.algo.spec.ts`.

## Rules

**A. Is the request local?** Only the TCP peer address (`req.socket.remoteAddress`) is used; any
`X-Forwarded-For` header is ignored (it is trivially spoofable).

1. Missing address: treat as `""`.
2. Strip a leading `::ffff:` (an IPv4 address arriving on the dual-stack socket; Node always
   reports it in lower case, and only that exact lower-case prefix is stripped, so
   `::FFFF:127.0.0.1` stays as it is and is not local).
3. Local if the result is exactly `127.0.0.1` or `::1` (other `127.x` addresses are not).
4. Otherwise local only if a trusted gateway exists (part B) and equals the result exactly.

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
- Private ranges: `172.15`/`172.16`/`172.31`/`172.32` (LR-19..LR-22), `10` vs `11` (LR-23, LR-40),
  `192.168` vs `192.167`/`192.169` (LR-37, LR-38, LR-24), `169.254` vs `169.253` (LR-25, LR-39);
  malformed addresses: LR-26, LR-41, LR-42, LR-44, LR-45, LR-46.

## Examples

Three kinds of rows.

- `"kind": "request"`: `remoteAddress` (or `null` for none), optional `headers`, and
  `trustedGateway` (the result of part B for this process, or `null`). The fake request's `ip`
  is what Express would report behind a trusted proxy: the `X-Forwarded-For` value if given,
  else the peer address. Expects `local`.
- `"kind": "gateway"`: a fake machine for part B. `files` maps a path to its content (a path not
  listed does not exist), `env` is the environment, `pid` the process id; with `"throws": true`
  every file access fails with an error. Expects `trustedGateway`.
- `"kind": "private"`: one address for rule 7. Expects `trusted`.

A route file is the header line plus rows of tab-separated fields
`Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT`.

```examples
[
  {
    "id": "LR-01",
    "input": {"kind": "request", "remoteAddress": "127.0.0.1", "trustedGateway": null},
    "expected": {"local": true},
    "note": "Rule 3: IPv4 loopback."
  },
  {
    "id": "LR-02",
    "input": {"kind": "request", "remoteAddress": "::1", "trustedGateway": null},
    "expected": {"local": true},
    "note": "Rule 3: IPv6 loopback."
  },
  {
    "id": "LR-03",
    "input": {"kind": "request", "remoteAddress": "::ffff:127.0.0.1", "trustedGateway": null},
    "expected": {"local": true},
    "note": "Rule 2 strips ::ffff:, leaving 127.0.0.1 (the normal case for a browser using localhost on the dual-stack socket)."
  },
  {
    "id": "LR-04",
    "input": {"kind": "request", "remoteAddress": "10.0.0.5", "trustedGateway": null},
    "expected": {"local": false},
    "note": "Rule 3 fails, no gateway (rule 4)."
  },
  {
    "id": "LR-05",
    "input": {"kind": "request", "remoteAddress": "::ffff:10.0.0.5", "trustedGateway": null},
    "expected": {"local": false},
    "note": "Rule 2 gives 10.0.0.5, not loopback."
  },
  {
    "id": "LR-06",
    "input": {"kind": "request", "remoteAddress": "127.0.0.2", "trustedGateway": null},
    "expected": {"local": false},
    "note": "Rule 3 is an exact match: 127.0.0.2 is in 127/8 but is not 127.0.0.1."
  },
  {
    "id": "LR-07",
    "input": {"kind": "request", "remoteAddress": null, "trustedGateway": null},
    "expected": {"local": false},
    "note": "Rule 1: no address is '', which matches nothing."
  },
  {
    "id": "LR-08",
    "input": {"kind": "request", "remoteAddress": "10.0.0.5", "headers": {"x-forwarded-for": "127.0.0.1"}, "trustedGateway": null},
    "expected": {"local": false},
    "note": "Part A ignores X-Forwarded-For: the peer is 10.0.0.5."
  },
  {
    "id": "LR-09",
    "input": {"kind": "request", "remoteAddress": "172.17.0.1", "trustedGateway": "172.17.0.1"},
    "expected": {"local": true},
    "note": "Rule 4: equals the trusted gateway."
  },
  {
    "id": "LR-10",
    "input": {"kind": "request", "remoteAddress": "::ffff:172.17.0.1", "trustedGateway": "172.17.0.1"},
    "expected": {"local": true},
    "note": "Rules 2 and 4: the mapped form of the gateway (how Docker delivers host traffic)."
  },
  {
    "id": "LR-11",
    "input": {"kind": "request", "remoteAddress": "172.17.0.9", "trustedGateway": "172.17.0.1"},
    "expected": {"local": false},
    "note": "Rule 4 trusts one address, not the subnet."
  },
  {
    "id": "LR-12",
    "input": {"kind": "request", "remoteAddress": "172.17.0.1", "trustedGateway": null},
    "expected": {"local": false},
    "note": "Rule 4: without a trusted gateway from part B the Docker gateway address is remote like any other (it is not hard-coded)."
  },
  {
    "id": "LR-13",
    "input": {"kind": "gateway", "files": {"/.dockerenv": "", "/proc/net/route": "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n"}, "env": {}, "pid": 1234},
    "expected": {"trustedGateway": "172.17.0.1"},
    "note": "Rule 5.1 marker file. Rule 6: the default route's gateway 010011AC read backwards is AC.11.00.01 = 172.17.0.1. Rule 7: 172.17 is in 172.16-31."
  },
  {
    "id": "LR-14",
    "input": {"kind": "gateway", "files": {"/proc/1/cgroup": "0::/init.scope\n", "/proc/self/mountinfo": "25 0 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw\n", "/proc/1/comm": "systemd\n", "/proc/net/route": "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"}, "env": {}, "pid": 1234},
    "expected": {"trustedGateway": null},
    "note": "Rule 5: no marker, no variable, cgroup without a runtime name, root on ext4, PID 1 is systemd, own pid 1234: not a container, so the private gateway 192.168.1.1 is not trusted."
  },
  {
    "id": "LR-15",
    "input": {"kind": "gateway", "files": {"/proc/net/route": "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t08080808\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"}, "env": {"KUBERNETES_SERVICE_HOST": "10.96.0.1"}, "pid": 1234},
    "expected": {"trustedGateway": null},
    "note": "Rule 5.2 fires (Kubernetes), rule 6 gives 8.8.8.8, rule 7 refuses a public address."
  },
  {
    "id": "LR-16",
    "input": {"kind": "gateway", "files": {"/.dockerenv": ""}, "env": {}, "pid": 1234},
    "expected": {"trustedGateway": null},
    "note": "Containerized, but there is no /proc/net/route, so rule 6 finds no gateway."
  },
  {
    "id": "LR-17",
    "input": {"kind": "gateway", "files": {"/run/.containerenv": "", "/proc/net/route": "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\neth1\t00000000\t010011AC\t0003\t0\t0\t50\t00000000\t0\t0\t0\n"}, "env": {}, "pid": 1234},
    "expected": {"trustedGateway": "172.17.0.1"},
    "note": "Rule 5.1 (podman marker). Rule 6: two default routes, metric 50 (172.17.0.1) beats metric 100 (192.168.1.1)."
  },
  {
    "id": "LR-18",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t00000000\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t00000000\t010011AC\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 6: the on-link default route (gateway 00000000, metric 0) is skipped although its metric is lower, so the real gateway 010011AC at metric 100 is used: 172.17.0.1. Keeping it would give 0.0.0.0, which rule 7 refuses: null."
  },
  {
    "id": "LR-19",
    "input": {"kind": "private", "address": "172.15.255.255"},
    "expected": {"trusted": false},
    "note": "Rule 7: second octet 15 < 16."
  },
  {
    "id": "LR-20",
    "input": {"kind": "private", "address": "172.16.0.1"},
    "expected": {"trusted": true},
    "note": "Rule 7: 172.16 is the first block of 172.16.0.0/12."
  },
  {
    "id": "LR-21",
    "input": {"kind": "private", "address": "172.31.255.254"},
    "expected": {"trusted": true},
    "note": "Rule 7: 172.31 is the last block."
  },
  {
    "id": "LR-22",
    "input": {"kind": "private", "address": "172.32.0.1"},
    "expected": {"trusted": false},
    "note": "Rule 7: second octet 32 > 31."
  },
  {
    "id": "LR-23",
    "input": {"kind": "private", "address": "10.255.0.1"},
    "expected": {"trusted": true},
    "note": "Rule 7: 10.0.0.0/8."
  },
  {
    "id": "LR-24",
    "input": {"kind": "private", "address": "192.169.0.1"},
    "expected": {"trusted": false},
    "note": "Rule 7: 192.168/16 only; 192.169 is public."
  },
  {
    "id": "LR-25",
    "input": {"kind": "private", "address": "169.254.10.1"},
    "expected": {"trusted": true},
    "note": "Rule 7: link-local 169.254/16."
  },
  {
    "id": "LR-26",
    "input": {"kind": "private", "address": "10.0.0.256"},
    "expected": {"trusted": false},
    "note": "Rule 7 needs four octets 0..255; 256 is not an octet, so not an address at all."
  },
  {
    "id": "LR-27",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t100\t00000000\t0\t0\t0\neth1\t000011AC\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 6 only reads rows with Destination 00000000: the eth1 row (destination 000011AC, gateway 192.168.1.1, metric 0) is not a default route, so 172.17.0.1 is used."
  },
  {
    "id": "LR-28",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth1\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 6: equal metrics, the first default route in the file wins: 172.17.0.1, not 192.168.1.1."
  },
  {
    "id": "LR-29",
    "input": {"kind":"gateway","files":{"/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\neth0\t00000000\tnot-hex\t0003\t0\t0\t0\t00000000\neth0\t00000000\t0a01a8c0\t0003\t0\t0\tx\t00000000\t0\t0\t0\neth0\t00000000\t010011ac\t0003\t0\t0\t5\t00000000\t0\t0\t0\n"},"env":{"container":" Podman "},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.2: container trimmed and lowercased is podman. Rule 6 skips the 2-field row, the non-hex gateway and the row with metric x; the lower-case hex 010011ac is read: 172.17.0.1."
  },
  {
    "id": "LR-30",
    "input": {"kind":"gateway","files":{"/proc/1/cgroup":"12:memory:/docker/0123456789ab\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.3: a cgroup v1 line naming docker."
  },
  {
    "id": "LR-31",
    "input": {"kind":"gateway","files":{"/proc/1/cgroup":"0::/\n","/proc/self/mountinfo":"1234 1233 0:100 / / rw,relatime - overlay overlay rw,lowerdir=/l\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.4: / is mounted as overlay (cgroup v2 says nothing)."
  },
  {
    "id": "LR-32",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"25 0 8:2 / / rw - ext4 /dev/sda2 rw\n1240 25 0:24 /docker/containers/abc/hostname /etc/hostname rw - ext4 /dev/sdc rw\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.4: root is ext4, but /etc/hostname is mounted from a root path containing docker/containers."
  },
  {
    "id": "LR-33",
    "input": {"kind":"gateway","files":{"/proc/1/comm":"node\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.5: PID 1 is node, not a host init."
  },
  {
    "id": "LR-34",
    "input": {"kind":"gateway","files":{"/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.6: no other signal fires, but the process itself is PID 1."
  },
  {
    "id": "LR-35",
    "input": {"kind":"gateway","files":{"/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{"KUBERNETES_SERVICE_HOST":"   ","container":""},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 5.2 needs a non-empty value after trimming; spaces and an empty container value do not count. No other signal: not a container, so null."
  },
  {
    "id": "LR-36",
    "input": {"kind":"gateway","files":{},"env":{},"pid":1234,"throws":true},
    "expected": {"trustedGateway":null},
    "note": "Rule 8: the fake machine throws on every file access, so probing fails and no gateway is trusted (no crash)."
  },
  {
    "id": "LR-37",
    "input": {"kind":"private","address":"192.168.0.1"},
    "expected": {"trusted":true},
    "note": "Rule 7: 192.168.0.0/16."
  },
  {
    "id": "LR-38",
    "input": {"kind":"private","address":"192.167.255.255"},
    "expected": {"trusted":false},
    "note": "Rule 7: second octet 167 is not 168."
  },
  {
    "id": "LR-39",
    "input": {"kind":"private","address":"169.253.0.1"},
    "expected": {"trusted":false},
    "note": "Rule 7: only 169.254 is link-local."
  },
  {
    "id": "LR-40",
    "input": {"kind":"private","address":"11.0.0.1"},
    "expected": {"trusted":false},
    "note": "Rule 7: only first octet 10, not 11."
  },
  {
    "id": "LR-41",
    "input": {"kind":"private","address":"10.0.0"},
    "expected": {"trusted":false},
    "note": "Rule 7: three parts, not four."
  },
  {
    "id": "LR-42",
    "input": {"kind":"private","address":"10.0.0.1e1"},
    "expected": {"trusted":false},
    "note": "Rule 7: an octet must be 1-3 decimal digits; '1e1' is not (Number would read it as 10)."
  },
  {
    "id": "LR-43",
    "input": {"kind":"gateway","files":{"/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{"ECS_CONTAINER_METADATA_URI_V4":"http://169.254.170.2/v4/abc"},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.2: a platform variable alone makes it a container; the private gateway is trusted."
  },
  {
    "id": "LR-44",
    "input": {"kind":"private","address":"10.0.0."},
    "expected": {"trusted":false},
    "note": "Rule 7: the fourth part is empty (Number would read it as 0)."
  },
  {
    "id": "LR-45",
    "input": {"kind":"private","address":"10.0.0.0001"},
    "expected": {"trusted":false},
    "note": "Rule 7: four digits in one octet."
  },
  {
    "id": "LR-46",
    "input": {"kind":"private","address":"10.0.0.1.5"},
    "expected": {"trusted":false},
    "note": "Rule 7: five parts, not four."
  },
  {
    "id": "LR-47",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 6: a route row with exactly 7 fields is enough."
  },
  {
    "id": "LR-48",
    "input": {"kind":"request","remoteAddress":"::FFFF:127.0.0.1","trustedGateway":null},
    "expected": {"local":false},
    "note": "Rule 2 strips only the lower-case prefix: the upper-case form is left as it is and matches neither loopback form."
  },
  {
    "id": "LR-49",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"30 25 0:50 / /var/lib/docker rw - overlay overlay rw\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 5.4: an overlay mount that is not the mount point / is no signal; nothing else fires: null."
  },
  {
    "id": "LR-50",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"1240 25 0:24 / /etc/hostname rw - ext4 /var/lib/docker/containers/abc rw\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.4: the root is /, but the source contains docker/containers, which is enough."
  },
  {
    "id": "LR-51",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"1241 25 0:24 /var/lib/kubelet/pods/p1/etc-hosts /etc/resolv.conf rw - ext4 /dev/sda1 rw\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.4: /etc/resolv.conf counts like /etc/hostname; its root contains kubelet/pods."
  },
  {
    "id": "LR-52",
    "input": {"kind":"gateway","files":{"/proc/1/comm":"  \n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 5.5: a blank comm is no signal (only a non-empty name that is not a host init counts); nothing else fires: null."
  },
  {
    "id": "LR-53",
    "input": {"kind":"request","remoteAddress":"172.17.0.10","trustedGateway":"172.17.0.1"},
    "expected": {"local":false},
    "note": "Rule 4 compares the whole address: 172.17.0.10 only starts with the gateway 172.17.0.1."
  },
  {
    "id": "LR-54",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"1 2 3 / / - overlay none\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.4: exactly 5 fields before the separator and 2 after is enough: mount point /, type overlay."
  },
  {
    "id": "LR-56",
    "input": {"kind":"gateway","files":{"/proc/1/cgroup":"12:memory:/DOCKER/abc\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.3 ignores case: DOCKER counts."
  },
  {
    "id": "LR-57",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"1234 1233 0:100 / / rw - fuse.fuse-overlayfs fuse-overlayfs rw\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 5.4: the type must be exactly overlay; fuse.fuse-overlayfs is not. Nothing else fires."
  },
  {
    "id": "LR-58",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"1240 25 0:24 /DOCKER/CONTAINERS/abc/hostname /etc/hostname rw - ext4 /dev/sdc rw\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 5.4 hints are case-sensitive: DOCKER/CONTAINERS is not docker/containers. Nothing else fires."
  },
  {
    "id": "LR-59",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C0\t0003\t0\t0\t1.5\neth1\t00000000\t0201A8C0\t0003\t0\t0\t2abc\neth2\t00000000\t010011AC\t0003\t0\t0\t5\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 6: metrics 1.5 and 2abc are not integers, so those rows are skipped; 172.17.0.1 at metric 5 is the only one counted. Reading metrics with parseInt would pick 192.168.1.1 (1.5 -> 1), with parseFloat 192.168.1.2 (2abc -> 2)."
  },
  {
    "id": "LR-60",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011A\t0003\t0\t0\t0\neth1\t00000000\t010011AC0\t0003\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 6 needs exactly 8 hex digits: 7 and 9 digits are skipped, nothing is left."
  },
  {
    "id": "LR-61",
    "input": {"kind":"gateway","files":{"/proc/1/comm":"Systemd\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.5 compares names case-sensitively: Systemd is not systemd, so it counts as a signal."
  },
  {
    "id": "LR-62",
    "input": {"kind":"private","address":"169.255.0.1"},
    "expected": {"trusted":false},
    "note": "Rule 7: only 169.254 is link-local; 169.255 is not."
  },
  {
    "id": "LR-63",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"1 2 3 / / rw - overlay\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 5.4: 6 fields before the separator but only 1 after it: the row does not count; nothing else fires."
  },
  {
    "id": "LR-64",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C0\t0003\t0\t0\t0\neth1\t00000000\t010011AC\t0003\t0\t0\t-1\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 6: Number(\"-1\") is an integer, so the eth1 row counts, and -1 is lower than 0: 172.17.0.1 wins over 192.168.1.1."
  },
  {
    "id": "LR-65",
    "input": {"kind":"request","remoteAddress":"127.0.0.1","trustedGateway":"172.17.0.1"},
    "expected": {"local":true},
    "note": "Rule 3 before rule 4: loopback stays local inside a container with a trusted gateway."
  },
  {
    "id": "LR-66",
    "input": {"kind":"gateway","files":{"/proc/1/cgroup":"0::/user.slice/specs.scope\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 5.3 is a plain substring match: \"specs\" contains \"ecs\", so it counts as a container signal (a known over-detection, bounded by rule 7)."
  },
  {
    "id": "LR-67",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"1234 1233 0:100 / / rw - overlayfs overlay rw\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 5.4: the type must be exactly overlay; overlayfs is not. Nothing else fires."
  },
  {
    "id": "LR-68",
    "input": {"kind":"private","address":"10.0.0.255"},
    "expected": {"trusted":true},
    "note": "Rule 7: 255 is a valid octet (\"at most 255\")."
  },
  {
    "id": "LR-69",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C0\t0003\t0\t0\t20\neth1\t00000000\t010011AC\t0003\t0\t0\t0x10\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 6: Number(\"0x10\") is 16, an integer, and 16 < 20: 172.17.0.1 wins. A digits-only metric check would skip it and pick 192.168.1.1."
  },
  {
    "id": "LR-70",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"1240 25 0:24 /docker/containers/abc/data /var/lib/data rw - ext4 /dev/sdc rw\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 5.4: the bind hint only counts for /etc/hostname and /etc/resolv.conf; a docker/containers root mounted at /var/lib/data is no signal. Nothing else fires."
  },
  {
    "id": "LR-71",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n eth0\t00000000\t010011AC\t0003\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 6 trims each line: the leading space before eth0 does not shift the fields."
  },
  {
    "id": "LR-72",
    "input": {"kind":"gateway","files":{"/proc/self/mountinfo":"1 2 3 / / - ext4 x - overlay overlay\n","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":null},
    "note": "Rule 5.4 uses the first \" - \": the type is ext4, not overlay (the later \" - overlay\" is part of the right side). Nothing else fires."
  },
  {
    "id": "LR-73",
    "input": {"kind":"gateway","files":{"/.dockerenv":"","/proc/net/route":"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C0\t0003\t0\t0\t150\neth1\t00000000\t010011AC\t0003\t0\t0\t1e2\n"},"env":{},"pid":1234},
    "expected": {"trustedGateway":"172.17.0.1"},
    "note": "Rule 6: Number(\"1e2\") is 100, an integer, below 150: 172.17.0.1 wins."
  },
  {
    "id": "LR-74",
    "input": {"kind":"private","address":"173.16.0.1"},
    "expected": {"trusted":false},
    "note": "Rule 7: second octet 16 is in 16-31, but the first octet must be 172."
  },
  {
    "id": "LR-75",
    "input": {"kind":"private","address":"193.168.0.1"},
    "expected": {"trusted":false},
    "note": "Rule 7: 168 as second octet counts only after 192."
  },
  {
    "id": "LR-76",
    "input": {"kind":"private","address":"170.254.0.1"},
    "expected": {"trusted":false},
    "note": "Rule 7: 254 as second octet counts only after 169."
  }
]
```

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
- Not in the table: the per-process memo of `getTrustedGateway` and `nodeFsProbe` swallowing real
  filesystem errors.

## Where the result is visible

Mode `none`: `POST /api/v1/auth/identify` answers `403` to a non-local request, and the
auto-identify guard does not sign it in, so the login page cannot be used from another machine.
At startup in mode `none` the server logs the trusted gateway when there is one.
