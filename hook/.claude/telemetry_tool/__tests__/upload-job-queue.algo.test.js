'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/upload-job-queue.md against `upload-queue.js` and
 * `upload-logs.js#isUnreachableError`. The twin rows (DD-18: `buildName`, `parseName`, `heartbeat`,
 * `claimStale`, `backoff`, `jobExit`, `constants`) run once against `upload-queue.js` and once against
 * the standalone copies in `otel-receiver.js`, so the two copies cannot drift apart. `requeueable`
 * rows run against the receiver only (`isRequeueableFailure`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const queue = require('../upload-queue');
const receiver = require('../otel-receiver');
const { isUnreachableError } = require('../upload-logs');

const TWINS = { 'upload-queue': queue, 'otel-receiver': receiver };
const TWIN_KINDS = new Set(['buildName', 'parseName', 'heartbeat', 'claimStale', 'backoff', 'jobExit', 'constants']);
const CONSTANT_NAMES = [
  'UPLOAD_DIR', 'QUEUE_DIR', 'FAILED_DIR', 'HEARTBEAT_FILE', 'UPLOADER_LOCK_FILE',
  'UPLOAD_QUEUE_CAPABILITY', 'UPLOAD_CONTRACT', 'JOB_SCHEMA', 'HEARTBEAT_STALE_MS', 'JOB_RUN_TIMEOUT_MS',
];

/** `(pid) => boolean` over the row's `alivePids`. */
function aliveFrom(input) {
  const alive = new Set(input.alivePids || []);
  return (pid) => alive.has(pid);
}

function runParseName(mod, input) {
  const parsed = mod.parseJobName(input.name);
  if (!parsed) return null;
  return { sid: parsed.sid, ts: parsed.ts, tsMs: parsed.tsMs, trigger: parsed.trigger, pid: parsed.pid, rand: parsed.rand };
}

function runBuildName(mod, input) {
  try {
    return {
      name: mod.buildJobName({
        sessionId: input.sessionId,
        trigger: input.trigger,
        now: Date.parse(input.now),
        pid: input.pid,
        rand: input.rand,
      }),
    };
  } catch {
    return { error: true };
  }
}

function runListOrder(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-job-queue-'));
  try {
    for (const name of input.files) fs.writeFileSync(path.join(dir, name), '{}');
    return queue.listJobs(dir).map((job) => job.name);
  } finally {
    // Only the temp dir this row created itself.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One twin-capable row against one module. */
function runTwin(mod, input) {
  switch (input.kind) {
    case 'buildName':
      return runBuildName(mod, input);
    case 'parseName':
      return runParseName(mod, input);
    case 'heartbeat':
      return { fresh: mod.isHeartbeatFresh(input.heartbeat, input.now) };
    case 'claimStale':
      return { stale: mod.isClaimStale(input.claim, input.now, aliveFrom(input)) };
    case 'backoff':
      return { delayMs: mod.backoffMs(input.n) };
    case 'jobExit':
      return { ...mod.JOB_EXIT };
    case 'constants':
      return Object.fromEntries(CONSTANT_NAMES.map((name) => [name, mod[name]]));
    default:
      throw new Error(`unknown twin kind ${JSON.stringify(input.kind)}`);
  }
}

function runHookOnly(input) {
  switch (input.kind) {
    case 'requeueable':
      return { requeueable: receiver.isRequeueableFailure(input.reason) };
    case 'listOrder':
      return runListOrder(input);
    case 'decide':
      return {
        decision: queue.decideHandOff({
          event: input.event, heartbeat: input.heartbeat, queueDirUsable: input.queueDirUsable, now: input.now,
        }),
      };
    case 'stuck':
      return { stuck: queue.isJobStuck(queue.parseJobName(input.name), input.claim, input.now, aliveFrom(input)) };
    case 'outcome':
      return { outcome: queue.classifyRunOutcome(input.result) };
    case 'limit':
      return { reason: queue.jobLimitReason({ createdAt: input.createdAt, attempts: input.attempts }, input.now) };
    case 'unreachable':
      return { unreachable: isUnreachableError(input.code) };
    default:
      throw new Error(`unknown input.kind ${JSON.stringify(input.kind)}`);
  }
}

for (const row of loadExamples('upload-job-queue')) {
  if (TWIN_KINDS.has(row.input.kind)) {
    for (const [twin, mod] of Object.entries(TWINS)) {
      test(`${row.id} [${twin}]`, () => {
        assert.deepEqual(runTwin(mod, row.input), row.expected);
      });
    }
  } else {
    test(row.id, () => {
      assert.deepEqual(runHookOnly(row.input), row.expected);
    });
  }
}
