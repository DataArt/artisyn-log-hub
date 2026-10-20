import * as fs from 'fs';

/**
 * Mode 1 (`AUTH_MODE=none`) is gated on the TCP peer address being loopback
 * (see localhost.util.ts). Inside a container that gate can never pass: a
 * connection from the host to a published port arrives from the container's
 * own default gateway (`::ffff:172.17.0.1` on a default Docker bridge), never
 * from `127.0.0.1`, and Docker's port publishing is NAT/userland forwarding —
 * no `X-Forwarded-*` header exists to recover the original client from.
 *
 * So: when — and only when — we are running inside a container, additionally
 * trust that one gateway address. Deliberately one address, never a subnet.
 *
 * Everything here is a pure function over an injected `FsProbe` so the spec can
 * exercise cgroup v1 *and* v2 layouts, podman, k8s and bare-host inputs without
 * needing a container. `nodeFsProbe` is the only implementation that touches the
 * real filesystem, and it swallows every error — which is how "never throws"
 * holds for missing/unreadable `/proc/*` and for non-Linux hosts, both of which
 * degrade to "no gateway trusted", i.e. exactly the behaviour from before container-gateway trust existed.
 */
export interface FsProbe {
  exists(path: string): boolean;
  read(path: string): string | null;
}

export const nodeFsProbe: FsProbe = {
  exists(path: string): boolean {
    try {
      return fs.existsSync(path);
    } catch {
      return false;
    }
  },
  read(path: string): string | null {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
};

export interface ContainerProbeInput {
  probe: FsProbe;
  env: NodeJS.ProcessEnv;
  pid: number;
}

/** Tier 1 — runtime marker files. Cheapest and most reliable signal. */
const MARKER_FILES = [
  '/.dockerenv', // Docker, Docker Desktop, Rancher Desktop, Colima
  '/run/.containerenv', // Podman
  '/run/.toolboxenv', // Toolbx
  '/.dockerinit', // pre-1.11 Docker
];

/**
 * Tier 2 — orchestrator/platform env vars. Operator-controlled, so there is no
 * spoofing concern; treat the list as extensible, a miss just falls to Tier 3.
 */
const CONTAINER_ENV_VARS = [
  'KUBERNETES_SERVICE_HOST',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'FLY_ALLOC_ID',
  'DYNO',
  'RENDER',
  'CODESPACES',
  'REMOTE_CONTAINERS',
  'DEVCONTAINER',
];

/** Values podman/LXC/nspawn set for PID 1 in `container`, inherited by children. */
const CONTAINER_ENV_VALUES = new Set([
  'docker',
  'podman',
  'oci',
  'lxc',
  'crio',
  'containerd',
  'systemd-nspawn',
]);

/**
 * Tier 3 — cgroup v1 only. Verified: inside our own runtime image
 * `/proc/1/cgroup` is exactly `0::/` (cgroup v2 carries no runtime name), so
 * this stays a fallback and is never the primary signal.
 */
const CGROUP_RUNTIME_RE =
  /docker|containerd|kubepods|libpod|lxc|garden|crio|ecs|buildkit|actions_job/i;

/** Source paths a container runtime binds `/etc/hostname`/`/etc/resolv.conf` from. */
const BIND_SOURCE_HINTS = [
  'docker/containers',
  'containerd',
  'kubelet/pods',
  'containers/storage',
];

/** PID 1 on a bare host. Anything else as PID 1 implies a PID namespace. */
const HOST_INIT_NAMES = new Set([
  'systemd',
  'init',
  'upstart',
  'openrc-init',
  'runit',
  'procd',
  'launchd',
]);

interface MountInfoEntry {
  root: string;
  mountPoint: string;
  fsType: string;
  source: string;
}

/**
 * `/proc/self/mountinfo` rows: `id parent maj:min root mountPoint opts [tags] -
 * fsType source superOpts`. The optional tag fields before the ` - ` separator
 * are variable in number, which is exactly why the separator exists.
 */
function parseMountInfo(content: string | null): MountInfoEntry[] {
  if (!content) return [];
  const entries: MountInfoEntry[] = [];
  for (const line of content.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator === -1) continue;
    const left = line.slice(0, separator).trim().split(/\s+/);
    const right = line
      .slice(separator + 3)
      .trim()
      .split(/\s+/);
    if (left.length < 5 || right.length < 2) continue;
    entries.push({
      root: left[3],
      mountPoint: left[4],
      fsType: right[0],
      source: right[1],
    });
  }
  return entries;
}

function hasBindSourceHint(value: string): boolean {
  return BIND_SOURCE_HINTS.some((hint) => value.includes(hint));
}

/**
 * True when any single containerization signal fires. Tiers are evaluated
 * cheapest-first and return on the first hit; over-detection is bounded by
 * `isTrustablePrivateIpv4`, so breadth is preferred over precision.
 *
 * Never keys off `/proc/version`: inside a Docker Desktop container the kernel
 * string still reads `microsoft-standard-WSL2` (the container shares the WSL
 * kernel), so a WSL exclusion there would break the primary case outright.
 */
export function isContainerized({
  probe,
  env,
  pid,
}: ContainerProbeInput): boolean {
  // Tier 1 — runtime marker files.
  if (MARKER_FILES.some((path) => probe.exists(path))) return true;

  // Tier 2 — orchestrator/platform env vars.
  if (CONTAINER_ENV_VARS.some((name) => (env[name] ?? '').trim() !== '')) {
    return true;
  }
  if (CONTAINER_ENV_VALUES.has((env.container ?? '').trim().toLowerCase())) {
    return true;
  }

  // Tier 3 — kernel/namespace introspection.
  const cgroup = probe.read('/proc/1/cgroup');
  if (cgroup && CGROUP_RUNTIME_RE.test(cgroup)) return true;

  const mounts = parseMountInfo(probe.read('/proc/self/mountinfo'));
  for (const mount of mounts) {
    if (mount.mountPoint === '/' && mount.fsType === 'overlay') return true;
    if (
      mount.mountPoint === '/etc/hostname' ||
      mount.mountPoint === '/etc/resolv.conf'
    ) {
      if (hasBindSourceHint(mount.root) || hasBindSourceHint(mount.source)) {
        return true;
      }
    }
  }

  const comm = probe.read('/proc/1/comm')?.trim();
  if (comm && !HOST_INIT_NAMES.has(comm)) return true;

  // Last and weakest: false in our own image (in cluster mode PID 1 is the
  // cluster primary, not an HTTP worker), so it must never be the only signal.
  return pid === 1;
}

/**
 * Decodes the IPv4 default gateway out of `/proc/net/route`: the row whose
 * `Destination` is `00000000`, taking its `Gateway` field, which is the
 * little-endian hex of the address (`010011AC` → `172.17.0.1`). With several
 * default routes the lowest `Metric` wins; an on-link `00000000` gateway (no
 * next hop) and malformed/short rows are skipped, as is the header row (its
 * `Destination` column is the literal `Destination`).
 *
 * IPv6 (`/proc/net/ipv6_route`) is out of scope: Docker bridge networks are
 * IPv4-only by default and the peer arrives as an IPv4-mapped address, which
 * localhost.util.ts's existing `::ffff:` normalization already reduces to IPv4.
 */
export function parseDefaultGatewayIpv4(
  procNetRoute: string | null,
): string | null {
  if (!procNetRoute) return null;

  let best: { address: string; metric: number } | null = null;
  for (const line of procNetRoute.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) continue;
    const [, destination, gateway] = fields;
    if (destination !== '00000000') continue;
    if (!/^[0-9a-f]{8}$/i.test(gateway) || gateway === '00000000') continue;
    const metric = Number(fields[6]);
    if (!Number.isInteger(metric)) continue;
    if (best && best.metric <= metric) continue;
    best = { address: hexToDottedQuad(gateway), metric };
  }
  return best?.address ?? null;
}

/** `010011AC` → `172.17.0.1` — the hex is little-endian, so read it backwards. */
function hexToDottedQuad(hex: string): string {
  const octets: number[] = [];
  for (let i = 0; i < 8; i += 2) {
    octets.unshift(parseInt(hex.slice(i, i + 2), 16));
  }
  return octets.join('.');
}

/**
 * Only a private-range gateway is ever trusted. This is what bounds every
 * possible false positive from `isContainerized`: a bare host wrongly detected
 * as containerized but sitting behind a public-IP gateway trusts nothing extra.
 */
export function isTrustablePrivateIpv4(addr: string): boolean {
  const octets = addr.split('.');
  if (octets.length !== 4) return false;
  const parsed = octets.map((octet) =>
    /^\d{1,3}$/.test(octet) ? Number(octet) : NaN,
  );
  if (parsed.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return false;
  }
  const [a, b] = parsed;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a === 169 && b === 254;
}

/** Containerized + private default gateway, or null. Never throws. */
export function resolveTrustedGateway(
  input: ContainerProbeInput,
): string | null {
  try {
    if (!isContainerized(input)) return null;
    const gateway = parseDefaultGatewayIpv4(
      input.probe.read('/proc/net/route'),
    );
    if (!gateway) return null;
    return isTrustablePrivateIpv4(gateway) ? gateway : null;
  } catch {
    return null;
  }
}

let cachedGateway: string | null | undefined;

/**
 * Memoized — including the negative result — so no request ever hits the
 * filesystem. main.ts warms this at startup (and logs the outcome under
 * `AUTH_MODE=none`), so by the time any request arrives it is already resolved.
 */
export function getTrustedGateway(): string | null {
  if (cachedGateway === undefined) {
    cachedGateway = resolveTrustedGateway({
      probe: nodeFsProbe,
      env: process.env,
      pid: process.pid,
    });
  }
  return cachedGateway;
}

/** Test-only — drops the memo so each spec case resolves from its own probe. */
export function resetTrustedGatewayCache(): void {
  cachedGateway = undefined;
}
