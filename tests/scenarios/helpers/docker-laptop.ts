/**
 * docker-laptop.ts — a "laptop" for S-HOOK-10: one long-lived Docker container per scenario run
 * that holds the user's home, two git repos with the installed hook, and the shared receiver
 * (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-HOOK-10).
 *
 *  - image: the official Node LTS image from the ECR mirror (`public.ecr.aws/docker/library/node`,
 *    the `bookworm` variant has `git`) — the same mirror `.claude/skills/big-prod-e2e-test` uses,
 *    because Docker Hub's anonymous pull limit bites; pulled once when it is missing;
 *  - container `scn-laptop-<run>`, labelled with the scenario and the run id, started with
 *    `--init` (PID 1 reaps the detached receivers and uploaders) and
 *    `--add-host host.docker.internal:host-gateway`, so the stand on the host (it listens on all
 *    interfaces) is `http://host.docker.internal:<stand port>` from inside;
 *  - the network is cut and restored with `docker network disconnect/connect bridge` (a real
 *    `ENETUNREACH`, loopback keeps working, so the receiver still serves the hooks), the power
 *    with `docker kill` / `docker start` (every process dies, the filesystem stays);
 *  - nothing is ever built as a shell command line: files go in and out through
 *    `tests/scenarios/fixtures/laptop/fsx.cjs`, hook events through `run-event.cjs` (both copied
 *    to `/laptop/` in the container), which also measures each hook's wall time inside the
 *    container;
 *  - {@link Laptop.remove} deletes this container only (`docker rm -f <its own name>`).
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { REPO_ROOT } from './hook-process';

/** The Node LTS image the laptop runs (Active LTS line, full Debian image: has git). */
export const LAPTOP_IMAGE = 'public.ecr.aws/docker/library/node:24-bookworm';
/** The container user's home (root). */
export const LAPTOP_HOME = '/root';
/** How the container reaches the host. */
export const LAPTOP_HOST_ALIAS = 'host.docker.internal';
/** Where the in-container helpers live. */
const LAPTOP_TOOLS = '/laptop';
const LAPTOP_TOOLS_SOURCE = path.join(REPO_ROOT, 'tests', 'scenarios', 'fixtures', 'laptop');
const NETWORK = 'bridge';
const SCENARIO_LABEL = 'artisyn.scenario=S-HOOK-10';
const RUN_LABEL_KEY = 'artisyn.scenario.run';

const GIT_IDENTITY = ['GIT_AUTHOR_NAME=Laptop Dev', 'GIT_AUTHOR_EMAIL=laptop-dev@arrakis.test', 'GIT_COMMITTER_NAME=Laptop Dev', 'GIT_COMMITTER_EMAIL=laptop-dev@arrakis.test'];

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `docker <args>` with optional stdin; never rejects on a non-zero exit (the caller decides). */
export function docker(args: string[], { input, timeoutMs = 120_000 }: { input?: string; timeoutMs?: number } = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docker ${args.slice(0, 3).join(' ')} did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`cannot run docker: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => { /* docker exited before reading stdin */ });
    child.stdin.end(input ?? '');
  });
}

async function dockerOk(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  const r = await docker(args, opts);
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')} failed (${String(r.code)}): ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
  return r.stdout;
}

/**
 * The scenario's own preflight: Docker must answer. A missing or stopped Docker fails the test with
 * this message (never a silent skip).
 */
export async function assertDockerAvailable(): Promise<void> {
  let r: DockerResult;
  try {
    r = await docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30_000 });
  } catch (err) {
    r = { code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
  if (r.code === 0 && r.stdout.trim()) return;
  throw new Error(
    'S-HOOK-10 preflight: Docker is not available (`docker info` failed: ' +
      `${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${String(r.code)}`}).\n` +
      '  S-HOOK-10 runs the hook on a "laptop" container and needs a running Docker daemon that can\n' +
      `  pull ${LAPTOP_IMAGE} once (see tests/scenarios/README.md → Prerequisites).`,
  );
}

/** Pulls the laptop image once when it is not present locally. */
export async function ensureLaptopImage(): Promise<void> {
  if ((await docker(['image', 'inspect', LAPTOP_IMAGE], { timeoutMs: 30_000 })).code === 0) return;
  await dockerOk(['pull', '-q', LAPTOP_IMAGE], { timeoutMs: 15 * 60_000 });
}

/** One hook command's result, measured inside the container. */
export interface LaptopHookRun {
  script: string;
  code: number | null;
  ms: number;
  stdout: string;
  stderr: string;
}

export interface UploadJobEntry {
  name: string;
  job: Record<string, unknown> | null;
}

export interface UploadState {
  queue: UploadJobEntry[];
  claims: Array<{ name: string; claim: { pid?: number; startedAt?: string } | null }>;
  failed: Array<{ name: string; record: Record<string, unknown> | null }>;
  lock: { pid?: number; startedAt?: string; version?: string } | null;
  heartbeat: { pid?: number; ts?: number } | null;
  /** The container's clock when the state was read (epoch ms). */
  now: number;
}

export interface PowerCutResult {
  cutAt: string | null;
  claims: string[];
  runs: LaptopHookRun[];
}

export class Laptop {
  constructor(readonly name: string) {}

  /** `docker exec [-i] <name> <argv…>`. */
  exec(argv: string[], { input, env = [], timeoutMs }: { input?: string; env?: string[]; timeoutMs?: number } = {}): Promise<DockerResult> {
    const envArgs = env.flatMap((e) => ['-e', e]);
    return docker(['exec', ...(input !== undefined ? ['-i'] : []), ...envArgs, this.name, ...argv], { input, timeoutMs });
  }

  /** {@link exec} that throws on a non-zero exit and returns stdout. */
  async run(argv: string[], opts: { input?: string; env?: string[]; timeoutMs?: number } = {}): Promise<string> {
    const r = await this.exec(argv, opts);
    if (r.code !== 0) throw new Error(`laptop: ${argv.join(' ')} failed (${String(r.code)}): ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
    return r.stdout;
  }

  /** Writes `content` to `file` in the container (parent dirs created, atomic). */
  async put(file: string, content: string): Promise<void> {
    await this.run(['node', `${LAPTOP_TOOLS}/fsx.cjs`, 'put', file], { input: content });
  }

  /** `file`'s content, or null when it does not exist. */
  async get(file: string): Promise<string | null> {
    const r = await this.exec(['node', `${LAPTOP_TOOLS}/fsx.cjs`, 'get', file]);
    if (r.code === 3) return null;
    if (r.code !== 0) throw new Error(`laptop: get ${file} failed (${String(r.code)}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  /** The shared upload state under the laptop user's `~/.artisyn/upload/`. */
  async uploadState(): Promise<UploadState> {
    const out = await this.run(['node', `${LAPTOP_TOOLS}/fsx.cjs`, 'upload', LAPTOP_HOME]);
    return JSON.parse(out) as UploadState;
  }

  /** `git init` + one commit + `origin` in `dir` (created). */
  async makeRepo(dir: string, remote: string): Promise<void> {
    await this.run(['mkdir', '-p', dir]);
    const git = (args: string[]) => this.run(['git', '-C', dir, ...args], { env: GIT_IDENTITY });
    await git(['init', '-q']);
    await git(['config', 'user.name', 'Laptop Dev']);
    await git(['config', 'user.email', 'laptop-dev@arrakis.test']);
    await this.put(`${dir}/README.md`, '# laptop project\n');
    await git(['add', 'README.md']);
    await git(['commit', '-q', '-m', 'seed']);
    await git(['checkout', '-q', '-B', 'main']);
    await git(['remote', 'add', 'origin', remote]);
  }

  /** Copies a host directory's `.artisyn/` (an extracted plugin) into `repoDir` in the container. */
  async copyArtisynDir(hostProjectDir: string, repoDir: string): Promise<void> {
    await dockerOk(['cp', path.join(hostProjectDir, '.artisyn'), `${this.name}:${repoDir}/`]);
  }

  /** Runs every hook the plugin registers for `input.hook_event_name`, the way Claude Code does. */
  async runEvent(plugin: string, input: Record<string, unknown>): Promise<LaptopHookRun[]> {
    const out = await this.run(['node', `${LAPTOP_TOOLS}/run-event.cjs`], { input: JSON.stringify({ plugin, input }), timeoutMs: 60_000 });
    const parsed = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { runs?: LaptopHookRun[] };
    return parsed.runs ?? [];
  }

  /**
   * Runs the event's hooks and cuts the power (SIGKILL of every process in the container) the
   * moment a queue job is claimed. The container stops; read the result with
   * {@link readPowerCut} after {@link start}.
   */
  async runEventWithPowerCut(plugin: string, input: Record<string, unknown>, timeoutMs = 30_000): Promise<void> {
    const cut = { queueDir: `${LAPTOP_HOME}/.artisyn/upload/queue`, file: `${LAPTOP_TOOLS}/power-cut.json`, timeoutMs };
    await this.exec(['node', `${LAPTOP_TOOLS}/run-event.cjs`], { input: JSON.stringify({ plugin, input, cut }), timeoutMs: timeoutMs + 30_000 });
  }

  async readPowerCut(): Promise<PowerCutResult | null> {
    const raw = await this.get(`${LAPTOP_TOOLS}/power-cut.json`);
    return raw ? (JSON.parse(raw) as PowerCutResult) : null;
  }

  /** "No VPN": the container leaves its only network; loopback stays. */
  async disconnect(): Promise<void> {
    await dockerOk(['network', 'disconnect', NETWORK, this.name]);
  }

  /** The network is back. */
  async connect(): Promise<void> {
    await dockerOk(['network', 'connect', NETWORK, this.name]);
  }

  async isRunning(): Promise<boolean> {
    const r = await docker(['inspect', '-f', '{{.State.Running}}', this.name]);
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  /** Power off: `docker kill` (a container that already went down counts as off). */
  async kill(): Promise<void> {
    if (await this.isRunning()) {
      const r = await docker(['kill', this.name]);
      if (r.code !== 0 && (await this.isRunning())) throw new Error(`docker kill ${this.name} failed: ${r.stderr.trim()}`);
    }
    const deadline = Date.now() + 30_000;
    while (await this.isRunning()) {
      if (Date.now() > deadline) throw new Error(`${this.name} still runs after docker kill`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Power on: `docker start` (PID numbering starts over; nothing of ours auto-starts). */
  async start(): Promise<void> {
    await dockerOk(['start', this.name]);
  }

  /** Removes this container (and only this one). */
  async remove(): Promise<void> {
    await docker(['rm', '-f', this.name], { timeoutMs: 60_000 });
  }
}

/** Starts `scn-laptop-<run>` from {@link LAPTOP_IMAGE} and copies the in-container helpers in. */
export async function startLaptop(run: string): Promise<Laptop> {
  if (!/^[0-9a-z-]+$/.test(run)) throw new Error(`bad run id ${run}`);
  const name = `scn-laptop-${run}`;
  await ensureLaptopImage();
  await dockerOk([
    'run', '-d', '--init',
    '--name', name,
    '--label', SCENARIO_LABEL,
    '--label', `${RUN_LABEL_KEY}=${run}`,
    '--add-host', `${LAPTOP_HOST_ALIAS}:host-gateway`,
    LAPTOP_IMAGE,
    'sleep', 'infinity',
  ]);
  const laptop = new Laptop(name);
  try {
    await dockerOk(['cp', LAPTOP_TOOLS_SOURCE, `${name}:${LAPTOP_TOOLS}`]);
  } catch (err) {
    await laptop.remove();
    throw err;
  }
  return laptop;
}

/** The stand URL as the laptop sees it (`http://host.docker.internal:<port>`). */
export function standUrlFromLaptop(standUrl: string): string {
  const u = new URL(standUrl);
  u.hostname = LAPTOP_HOST_ALIAS;
  return u.toString().replace(/\/+$/, '');
}

/** `~/.claude/projects/<slug>` of a container repo, as the hook derives it from the git root. */
export function laptopProjectDir(repoDir: string): string {
  return `${LAPTOP_HOME}/.claude/projects/${repoDir.replace(/[^a-zA-Z0-9-]/g, '-')}`;
}
