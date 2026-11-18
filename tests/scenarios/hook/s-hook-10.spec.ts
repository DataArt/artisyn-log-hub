// S-HOOK-10. Offline laptop, power-off, recovery: there is no VPN, the user works, sessions are
// created but not uploaded; the laptop is switched off (every process dies); it is switched on, and
// the first session the user runs uploads everything
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-HOOK-10; layer «hook in a
// Docker container + real server»; hook 3.0.0 upload queue, task 2026-11-18-receiver-upload-queue
// chunk 17).
//
// The "laptop" is one Docker container per run (helpers/docker-laptop.ts): the built plugin from
// the stand's own installer tarball is copied into two git repos X and Y in it, with a real API key
// of the stand and the shared receiver set up the way the installer leaves it
// (`~/.artisyn/otel/port.json`, `token`, `bin/`). The Log Hub is the scenario stand itself, reached
// at `http://host.docker.internal:<stand port>`. Hook events are fed by an in-container driver that
// runs every command `hooks/hooks.json` registers for the event and measures each one inside the
// container.
//
// Code facts the scenario relies on:
//   - "no VPN" is `docker network disconnect`: the hook gets a real `ENETUNREACH` at once, while
//     loopback (the receiver's port) keeps working, so `Stop` / `SessionEnd` hand off to the queue;
//   - a job whose `createdAt` is over 24 h old goes to `failed/` (`over-age`) on its next run, and the
//     hook records the `upload-jobs-failed` recommendation in the repo;
//   - the power cut is timed by the driver: it SIGKILLs every process of the container the moment a
//     queue job is claimed, so a stale `.claim` is left next to the stale `uploader.lock` and
//     `heartbeat.json`; then `docker kill` / `docker start` (pids start over from 1);
//   - variant A (first session in repo Y): the `SessionStart` announce starts a new receiver, which
//     takes over the stale lock and drains the queue (the dead claim's job included); repo X's jobs
//     upload X1–X3, their `done` full scan clears X's `failed/` record and recommendation;
//   - variant B (first turn in repo X itself): after a second offline round and power cut, a `Stop`
//     of a new session X5 runs before any receiver is up — the heartbeat is older than the 15 s
//     window, as after any real boot — so it takes DD-7's `in-process-stop` path: it uploads X4 and
//     X5 itself and respawns the receiver, which drains Y2 and the leftover jobs.
//
// Preflight: Docker must answer `docker info`; otherwise the test fails with a clear message.
import { randomBytes } from 'crypto';
import type { Pool } from 'pg';
import { test, expect } from '../fixtures';
import type { ScenarioUser } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  assertDockerAvailable,
  LAPTOP_HOME,
  laptopProjectDir,
  standUrlFromLaptop,
  startLaptop,
  type Laptop,
  type LaptopHookRun,
  type UploadState,
} from '../helpers/docker-laptop';
import { installBuiltPlugin, isRecord, QUIET_HOOK_CONFIG, runToken, tempDirs } from '../helpers/hook-process';
import { ndjson, sessionRowCount, storedBody } from '../helpers/ingest';
import { ownRepoId } from '../helpers/prompt-session';

/** The receiver's port inside the container (its own network namespace: no clash with the host). */
const SHARED_PORT = 47555;
/** DD-13 timing bound per hand-off hook run (DD-1: < 1000 ms wall time on a shared runner). */
const HOOK_WALL_MS = 1000;
/** The stand must have everything within this long after the first session (plan item). */
const RECOVERY_WAIT_MS = 120_000;
/** `HEARTBEAT_STALE_MS` of upload-queue.js. */
const HEARTBEAT_STALE_MS = 15_000;
const DAY_MS = 24 * 60 * 60_000;

interface Repo {
  name: 'X' | 'Y';
  dir: string;
  plugin: string;
  repoUrl: string;
}

interface Turn {
  prompt: string;
  answer: string;
}

/** Transcript lines of a session; uuids are `<sid>-u<n>` / `<sid>-a<n>`. */
function transcript(sid: string, repo: Repo, turns: Turn[]): string {
  const t0 = Date.now() - 5 * 60_000;
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const lines: object[] = [];
  turns.forEach((turn, i) => {
    const n = i + 1;
    lines.push({ type: 'user', uuid: `${sid}-u${n}`, parentUuid: n > 1 ? `${sid}-a${n - 1}` : null, sessionId: sid, timestamp: at(i * 20), cwd: repo.dir, gitBranch: 'main', message: { role: 'user', content: turn.prompt } });
    lines.push({
      type: 'assistant', uuid: `${sid}-a${n}`, parentUuid: `${sid}-u${n}`, sessionId: sid, timestamp: at(i * 20 + 5),
      message: { id: `msg-${sid}-${n}`, role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 900 + n, output_tokens: 80 + n }, content: [{ type: 'text', text: turn.answer }] },
    });
  });
  return ndjson(lines);
}

function uuidsOf(sid: string, turns: number): string[] {
  const out: string[] = [];
  for (let n = 1; n <= turns; n += 1) out.push(`${sid}-u${n}`, `${sid}-a${n}`);
  return out;
}

/** Session ids the stand lists for the owner's repo (empty while the repo does not exist yet). */
async function standSessionIds(owner: ScenarioUser, repoUrl: string): Promise<string[]> {
  let id: number;
  try {
    id = await ownRepoId(owner.api, repoUrl);
  } catch {
    return [];
  }
  const res = await owner.api.get(`/api/v1/repositories/${id}/sessions`);
  if (res.status() !== 200) return [];
  return ((await res.json()) as Array<{ sessionId: string }>).map((s) => s.sessionId);
}

/** Whether the stored claude transcript of `sid` holds every expected line. */
async function hasFullTranscript(db: Pool, sid: string, uuids: string[]): Promise<boolean> {
  const body = (await storedBody(db, sid, 'claude')) ?? [];
  const have = new Set(body.filter(isRecord).map((l) => String(l.uuid)));
  return uuids.every((u) => have.has(u));
}

function jobsOf(state: UploadState, repo: Repo): UploadState['queue'] {
  return state.queue.filter((e) => e.job && typeof e.job.telemetryDir === 'string' && e.job.telemetryDir.startsWith(`${repo.dir}/`));
}

test('@S-HOOK-10 offline laptop: sessions queue without a network, survive a power cut and all upload with the first session after power-on @mode-a', async ({
  db,
  stand,
  users,
}) => {
  test.setTimeout(600_000);
  await test.step('preflight: Docker is available', async () => {
    await assertDockerAvailable();
  });

  const run = runToken();
  const dirs = tempDirs();
  let laptop: Laptop | null = null;
  try {
    const owner = await users.user('user', { label: 'h10-owner' });
    const key = await createApiKey(owner.api);
    const serverUrl = standUrlFromLaptop(stand.url);
    const repoOf = (name: 'X' | 'Y'): Repo => {
      const slug = `laptop-${name.toLowerCase()}`;
      const dir = `/work/${slug}`;
      return { name, dir, plugin: `${dir}/.artisyn/marketplace/plugins/log-hub-hooks`, repoUrl: `https://git.arrakis.test/e2e/${run}/${slug}` };
    };
    const X = repoOf('X');
    const Y = repoOf('Y');
    const hookLog = async (repo: Repo) => ((await laptop!.get(`${repo.dir}/.artisyn/ai_work_dir/hook.log`)) ?? '').split('\n');
    const recommendations = async (repo: Repo): Promise<string[]> => {
      const raw = await laptop!.get(`${repo.dir}/.artisyn/ai_work_dir/hook-recommendations.json`);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { recommendations?: Array<{ rule: string }> };
      return (parsed.recommendations ?? []).map((r) => r.rule);
    };
    const transcriptPath = (repo: Repo, sid: string) => `${laptopProjectDir(repo.dir)}/${sid}.jsonl`;
    const writeTranscript = (repo: Repo, sid: string, turns: Turn[]) => laptop!.put(transcriptPath(repo, sid), transcript(sid, repo, turns));
    /** One hook event of the installed plugin; every command must exit 0. */
    const fire = async (repo: Repo, sid: string, event: string, extra: Record<string, unknown> = {}) => {
      const runs = await laptop!.runEvent(repo.plugin, { hook_event_name: event, session_id: sid, cwd: repo.dir, transcript_path: transcriptPath(repo, sid), ...extra });
      expect(runs.length, `${event} ran the plugin's hooks`).toBeGreaterThan(0);
      for (const r of runs) expect(r.code, `${event} ${r.script}: ${r.stderr}`).toBe(0);
      return runs.map((r) => ({ ...r, label: `${sid} ${event} ${r.script}` }));
    };
    /** A whole short session: SessionStart, one turn (UserPromptSubmit, Stop), SessionEnd. */
    const session = async (repo: Repo, sid: string) => {
      await writeTranscript(repo, sid, [{ prompt: `work on ${sid}`, answer: `done with ${sid}` }]);
      return [
        ...(await fire(repo, sid, 'SessionStart', { source: 'startup' })),
        ...(await fire(repo, sid, 'UserPromptSubmit', { prompt: `work on ${sid}` })),
        ...(await fire(repo, sid, 'Stop')),
        ...(await fire(repo, sid, 'SessionEnd', { reason: 'other' })),
      ];
    };
    const expectFast = (runs: Array<LaptopHookRun & { label: string }>) => {
      for (const r of runs) expect(r.ms, `${r.label} wall time inside the container`).toBeLessThan(HOOK_WALL_MS);
    };
    /** Waits until every queued job of the repos ran once and was rescheduled (attempts ≥ 1, no claim). */
    const waitForRescheduled = async (repos: Repo[], expected: number) => {
      await expect
        .poll(
          async () => {
            const state = await laptop!.uploadState();
            const jobs = repos.flatMap((r) => jobsOf(state, r));
            return { jobs: jobs.length, unrun: jobs.filter((j) => !(Number(j.job?.attempts) >= 1)).length, claims: state.claims.length };
          },
          { timeout: 60_000, intervals: [500] },
        )
        .toEqual({ jobs: expected, unrun: 0, claims: 0 });
    };

    await test.step('setup: the laptop container, repos X and Y with the built plugin and a stand API key, shared receiver state', async () => {
      const hostProject = dirs.make('h10-plugin');
      await installBuiltPlugin(stand.url, hostProject);
      laptop = await startLaptop(run);
      for (const repo of [X, Y]) {
        await laptop.makeRepo(repo.dir, `git@git.arrakis.test:e2e/${run}/laptop-${repo.name.toLowerCase()}.git`);
        await laptop.copyArtisynDir(hostProject, repo.dir);
        await laptop.put(`${repo.dir}/.artisyn/config/log-hub.json`, JSON.stringify({ ...QUIET_HOOK_CONFIG, serverUrl, sendLogsTimeoutMs: 5000 }, null, 2));
        await laptop.put(`${repo.dir}/.artisyn/config/log-hub.local.json`, JSON.stringify({ apiKey: key.key }, null, 2));
      }
      const otel = `${LAPTOP_HOME}/.artisyn/otel`;
      await laptop.put(`${otel}/token`, randomBytes(32).toString('hex'));
      await laptop.put(`${otel}/port.json`, JSON.stringify({ version: 1, port: SHARED_PORT, allocatedAt: new Date().toISOString() }));
      await laptop.run(['mkdir', '-p', `${otel}/bin`]);
      for (const file of ['otel-receiver.js', 'version.json', 'otel-ensure-receiver.js']) {
        await laptop.run(['cp', `${X.plugin}/scripts/${file}`, `${otel}/bin/${file}`]);
      }
      const version = JSON.parse((await laptop.get(`${X.plugin}/scripts/version.json`)) ?? '{}') as { version?: string };
      expect(Number(String(version.version).split('.')[0]), `plugin version ${String(version.version)} has the upload queue`).toBeGreaterThanOrEqual(3);
    });

    const xSids = [1, 2, 3].map((n) => `h10-x${n}-${run}`);
    await test.step('no VPN: three sessions X1–X3 in repo X — every hook run returns in < 1000 ms, nothing reaches the stand, the jobs wait in ~/.artisyn/upload/queue/', async () => {
      await laptop!.disconnect();
      const runs = [];
      for (const sid of xSids) runs.push(...(await session(X, sid)));
      expectFast(runs);

      const log = await hookLog(X);
      expect(log.filter((l) => l.includes('[send-logs-hook.js]') && l.includes('queued: job=')).length, 'every Stop / SessionEnd handed off').toBe(6);
      // Each job ran once on the receiver, hit the dead network and was rescheduled.
      await waitForRescheduled([X], 6);
      expect((await hookLog(X)).some((l) => l.includes('aborted: server unreachable (ENETUNREACH)')), 'the job run aborted on the first unreachable upload').toBe(true);
      const state = await laptop!.uploadState();
      for (const sid of xSids) {
        expect(jobsOf(state, X).filter((e) => e.job?.sessionId === sid).map((e) => e.job?.trigger).sort(), sid).toEqual(['session-end', 'stop']);
      }
      for (const sid of xSids) expect(await sessionRowCount(db, sid), `${sid} is not on the stand`).toBe(0);
    });

    const overAgeJob = await test.step('a job already gave up: X1’s session-end job, 25 h old, moves to failed/ (over-age) on its next run', async () => {
      const pick = async () => jobsOf(await laptop!.uploadState(), X).find((e) => e.job?.sessionId === xSids[0] && e.job?.trigger === 'session-end');
      const target = await pick();
      expect(target, 'X1 session-end job is queued').toBeTruthy();
      const queuePath = `${LAPTOP_HOME}/.artisyn/upload/queue/${target!.name}`;
      let moved = false;
      for (let attempt = 0; attempt < 3 && !moved; attempt += 1) {
        const current = await pick();
        if (!current?.job) break;
        // Due now and created 25 h ago; written atomically (the receiver's watch picks it up).
        await laptop!.put(queuePath, JSON.stringify({ ...current.job, createdAt: new Date(Date.now() - DAY_MS - 60 * 60_000).toISOString(), nextAttemptAt: null }, null, 2));
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const state = await laptop!.uploadState();
          if (state.failed.some((f) => f.name === target!.name)) {
            moved = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      const state = await laptop!.uploadState();
      const record = state.failed.find((f) => f.name === target!.name)?.record;
      expect(record?.failedReason, 'moved to failed/ as over-age').toBe('over-age');
      expect(jobsOf(state, X), 'the other five X jobs still wait').toHaveLength(5);
      expect(await recommendations(X), 'the hook told the user').toContain('upload-jobs-failed');
      expect((await hookLog(X)).some((l) => l.includes(`job failed: ${target!.name}`) && l.includes('over-age'))).toBe(true);
      return target!.name;
    });

    await test.step('power off: the power goes while a job runs (SIGKILL of every process, docker kill); power on — the stale uploader.lock, heartbeat.json and .claim are still on disk', async () => {
      // The user's last turn in X3 before closing the lid: its Stop queues a job, the receiver
      // claims it, and that is the moment the power goes.
      await writeTranscript(X, xSids[2], [
        { prompt: `work on ${xSids[2]}`, answer: `done with ${xSids[2]}` },
        { prompt: 'one more thing', answer: 'done before the battery died' },
      ]);
      await fire(X, xSids[2], 'UserPromptSubmit', { prompt: 'one more thing' });
      await laptop!.runEventWithPowerCut(X.plugin, { hook_event_name: 'Stop', session_id: xSids[2], cwd: X.dir, transcript_path: transcriptPath(X, xSids[2]) });
      await laptop!.kill();
      await laptop!.start();
      await laptop!.connect();

      const cut = await laptop!.readPowerCut();
      expect(cut?.cutAt, 'the power went while a job was claimed').toBeTruthy();
      const state = await laptop!.uploadState();
      expect(state.lock, 'stale uploader.lock').not.toBeNull();
      expect(state.heartbeat, 'stale heartbeat.json').not.toBeNull();
      expect(state.claims.length, `stale .claim (cut saw ${cut!.claims.join(', ')})`).toBeGreaterThanOrEqual(1);
      expect(state.claims.map((c) => c.name)).toEqual(expect.arrayContaining([cut!.claims[0]]));
      test.info().annotations.push({
        type: 'power-cut',
        description: `lock pid ${String(state.lock?.pid)}, claim pid ${String(state.claims[0]?.claim?.pid)}, heartbeat age ${state.now - Number(state.heartbeat?.ts)} ms`,
      });
      expect(state.failed.map((f) => f.name)).toEqual([overAgeJob]);
    });

    const y1 = `h10-y1-${run}`;
    await test.step('power on, first session in repo Y: within 120 s X1–X3 and Y1 are on the stand with their full transcripts, queue/ and failed/ are empty, X’s upload-jobs-failed recommendation is gone', async () => {
      await writeTranscript(Y, y1, [{ prompt: `work on ${y1}`, answer: `done with ${y1}` }]);
      await fire(Y, y1, 'SessionStart', { source: 'startup' });
      await fire(Y, y1, 'UserPromptSubmit', { prompt: `work on ${y1}` });
      await fire(Y, y1, 'Stop');
      const expected = [
        ...xSids.map((sid, i) => ({ sid, repo: X, uuids: uuidsOf(sid, i === 2 ? 2 : 1) })),
        { sid: y1, repo: Y, uuids: uuidsOf(y1, 1) },
      ];
      await expect
        .poll(
          async () => {
            const missing: string[] = [];
            for (const e of expected) {
              if (!(await standSessionIds(owner, e.repo.repoUrl)).includes(e.sid)) missing.push(`${e.sid}: not listed`);
              else if (!(await hasFullTranscript(db, e.sid, e.uuids))) missing.push(`${e.sid}: transcript incomplete`);
            }
            const state = await laptop!.uploadState();
            return {
              missing,
              queue: state.queue.map((q) => q.name),
              failed: state.failed.map((f) => `${f.name} ${String(f.record?.failedReason)}`),
              xRecommendations: (await recommendations(X)).filter((r) => r === 'upload-jobs-failed'),
            };
          },
          { timeout: RECOVERY_WAIT_MS, intervals: [2000] },
        )
        .toEqual({ missing: [], queue: [], failed: [], xRecommendations: [] });
    });

    const x4 = `h10-x4-${run}`;
    const y2 = `h10-y2-${run}`;
    const x5 = `h10-x5-${run}`;
    await test.step('variant B — offline again: X4 in repo X and Y2 in repo Y queue; power cut; power on', async () => {
      await laptop!.disconnect();
      const runs = [...(await session(X, x4)), ...(await session(Y, y2))];
      expectFast(runs);
      await waitForRescheduled([X, Y], 4);
      for (const sid of [x4, y2]) expect(await sessionRowCount(db, sid), `${sid} is not on the stand`).toBe(0);
      await laptop!.kill();
      await laptop!.start();
      await laptop!.connect();
      // A real boot takes longer than the heartbeat window: wait until the dead receiver's
      // heartbeat is stale, so the next hook run sees no live uploader.
      await expect
        .poll(async () => {
          const state = await laptop!.uploadState();
          return state.heartbeat === null || state.now - Number(state.heartbeat.ts) > HEARTBEAT_STALE_MS;
        }, { timeout: 60_000, intervals: [1000] })
        .toBe(true);
    });

    await test.step('variant B — the first turn after power-on is in repo X itself: its Stop uploads in-process (X4, X5 at once) and respawns the receiver, which drains Y2 and the rest within 120 s', async () => {
      await writeTranscript(X, x5, [{ prompt: `work on ${x5}`, answer: `done with ${x5}` }]);
      await fire(X, x5, 'Stop');
      const x5Lines = (await hookLog(X)).filter((l) => l.includes(`[send-logs-hook.js]`) && l.includes(x5));
      expect(x5Lines.some((l) => l.includes('queued: job=')), 'no hand-off without a live receiver').toBe(false);
      expect(x5Lines.some((l) => l.includes('receiver: spawned for upload queue')), x5Lines.join('\n')).toBe(true);
      // The in-process full scan already uploaded every X session. X5 had no UserPromptSubmit (that
      // hook re-arms the receiver, which would turn this Stop into a hand-off), so it has no first
      // prompt and the session list leaves it out: it is checked in the stored transcript.
      await expect
        .poll(async () => {
          const missing: string[] = [];
          for (const sid of [x4, x5]) if (!(await hasFullTranscript(db, sid, uuidsOf(sid, 1)))) missing.push(sid);
          return missing;
        }, { timeout: 15_000, intervals: [500] })
        .toEqual([]);
      await expect
        .poll(
          async () => {
            const missing: string[] = [];
            for (const e of [{ sid: x4, repo: X, listed: true }, { sid: x5, repo: X, listed: false }, { sid: y2, repo: Y, listed: true }]) {
              if (e.listed && !(await standSessionIds(owner, e.repo.repoUrl)).includes(e.sid)) missing.push(`${e.sid}: not listed`);
              else if (!(await hasFullTranscript(db, e.sid, uuidsOf(e.sid, 1)))) missing.push(`${e.sid}: transcript incomplete`);
            }
            const state = await laptop!.uploadState();
            return { missing, queue: state.queue.map((q) => q.name), failed: state.failed.map((f) => f.name) };
          },
          { timeout: RECOVERY_WAIT_MS, intervals: [2000] },
        )
        .toEqual({ missing: [], queue: [], failed: [] });
    });
  } finally {
    if (laptop) await (laptop as Laptop).remove();
    dirs.cleanup();
  }
});
