// S-HOOK-02. A torn line and privacy: the hook repairs NDJSON and never leaks secrets
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-HOOK-02; layer «hook
// (child processes)»; no mode in the design → A and C, DD SC4 — step 5 uploads to the stand).
//
// Steps 1–4 and 6–9 run against a fake log hub that records every body; step 5 points the same
// project at the stand with a real API key and checks the repaired files are ingested. It runs
// last because it re-points the project's config at the stand.
//
// Code facts that differ from the design text:
//   - OTEL is off in this project, so there is no receiver.log; the privacy check of step 6 covers
//     hook.log (receiver.log is S-HOOK-07's surface);
//   - a dropped line is reported as `<ns>/<file>: dropped line <n> (<bytes> bytes): <parse error> |
//     "<first 120 chars, JSON-escaped>"`, after one summary line `dropped K malformed JSON line(s)
//     of N before upload`;
//   - a file whose every line is broken is not uploaded and is logged as `[fail] <ns>/<file>: no
//     valid JSON lines left after sanitizing`;
//   - the server drops blank lines when it stores a log, so the stored artisyn log has the three
//     non-blank kept lines of the four the hook kept;
//   - `tool_input` is written as is (the design's open question 7 — accepted); only
//     `tool_response` is reduced to `edit_result` `{added, removed, changeKind, filePath}`.
//
// Replaces:
//   - hook/.claude/telemetry_tool/__tests__/ndjson-sanitize.test.js (15)
//   - hook/.claude/telemetry_tool/__tests__/edit-result-counts.test.js — four fields, no content (≈ 4)
//   - hook/.claude/telemetry_tool/__tests__/hook-log.test.js (5)
//   - hook/.claude/telemetry_tool/__tests__/upload-logs.test.js — API key never in hook.log (2)
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import {
  claudeProjectDir,
  copyToolDir,
  isRecord,
  makeFakeGitRepo,
  makeFakeHome,
  ndjsonLines,
  readHookLog,
  runHook,
  runScript,
  runToken,
  startFakeLogHub,
  telemetryDir,
  tempDirs,
  writeConfig,
  writeStandConfig,
  QUIET_HOOK_CONFIG,
  type FakeLogHub,
} from '../helpers/hook-process';
import { storedBody } from '../helpers/ingest';
import { waitForQueueIdle } from '../helpers/queue';

const KEY = 'KEY-SECRET-777';

test('@S-HOOK-02 the hook repairs torn NDJSON byte-for-byte and keeps secrets out of logs and bodies @mode-a @mode-c', async ({
  db,
  stand,
  users,
}) => {
  test.setTimeout(150_000);
  const run = runToken();
  const dirs = tempDirs();
  let hub: FakeLogHub | undefined;
  // Session ids are unique per run: step 5 sends the same files to the shared stand schema.
  const cur = `h02-${run}-cur`;
  const art = `h02-${run}-art`;
  const bl = `h02-${run}-bl`;
  const bad = `h02-${run}-bad`;
  const repoUrl = `https://git.arrakis.test/scn/${run}/hook02`;
  try {
    hub = await startFakeLogHub((req) =>
      // One failing upload, so hook.log carries an error line to check for the key and the query.
      req.sessionId === bad ? { status: 500, body: '{"message":"boom"}' } : { status: 201, body: '{"warnings":[]}' },
    );
    const toolDir = copyToolDir(dirs);
    const repo = makeFakeGitRepo(dirs, { remote: `git@git.arrakis.test:scn/${run}/hook02.git` });
    const home = makeFakeHome(dirs);
    const telemetry = telemetryDir(repo);
    const project = claudeProjectDir(home, repo);
    writeConfig(repo, {
      base: { ...QUIET_HOOK_CONFIG, serverUrl: hub.url, sendLogsTimeoutMs: 5000 },
      local: { apiKey: KEY },
    });

    // 5 lines: \r\n ending, Cyrillic + emoji, the torn 3rd line, a blank line, a plain line.
    const artLines = [
      `{"event":"session_start","session_id":"${art}","timestamp":"2026-10-14T10:00:00.000Z"}\n`,
      `{"event":"prompt_start","session_id":"${art}","timestamp":"2026-10-14T10:00:01.000Z","prompt":"Привет 👋 мир","git":{"repo":"${repoUrl}","branch":"main"}}\r\n`,
      '{"event":"prompt_start","pro\n',
      '\n',
      `{"event":"prompt_stop","session_id":"${art}","timestamp":"2026-10-14T10:01:00.000Z"}\n`,
    ];
    const artFile = Buffer.from(artLines.join(''), 'utf8');
    const artKept = Buffer.from([artLines[0], artLines[1], artLines[3], artLines[4]].join(''), 'utf8');
    const tornBytes = Buffer.byteLength(artLines[2].slice(0, -1), 'utf8');
    const longTorn = `{"type":"user","sessionId":"${bl}","message":"${'y'.repeat(300)}`;

    await test.step('1. artisyn file with a torn 3rd line; a backlog transcript with a torn last line; a file that is all broken', async () => {
      fs.writeFileSync(path.join(telemetry, `${art}.jsonl`), artFile);
      fs.writeFileSync(
        path.join(telemetry, `${cur}.jsonl`),
        `{"event":"prompt_start","session_id":"${cur}","prompt":"PROMPT-SECRET do the thing","git":{"repo":"${repoUrl}","branch":"main"}}\n`,
      );
      fs.writeFileSync(
        path.join(project, `${bl}.jsonl`),
        `{"type":"user","sessionId":"${bl}","timestamp":"2026-10-14T10:00:00.000Z","message":{"role":"user","content":"hi"}}\n${longTorn}`,
      );
      fs.writeFileSync(path.join(telemetry, `${bad}-all.jsonl`), '{"broken\n{also broken\n');
      fs.writeFileSync(path.join(telemetry, `${bad}.jsonl`), `{"event":"prompt_start","session_id":"${bad}"}\n`);
    });

    await test.step('2. Stop: the artisyn body is the file minus the torn line, byte for byte (\\r\\n, unicode, blank line kept)', async () => {
      const res = await runHook(toolDir, { hook_event_name: 'Stop', session_id: cur, cwd: repo }, { home });
      expect(res.code, res.stderr).toBe(0);
      const sent = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === art);
      expect(sent, 'artisyn upload of the torn file').toBeTruthy();
      expect(sent!.body.equals(artKept), `sent:\n${sent!.body.toString('utf8')}`).toBe(true);
      const curBody = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === cur)!.body.toString('utf8');
      expect(ndjsonLines(curBody)[0].type).toBe('hook-status');
      expect(curBody.endsWith(fs.readFileSync(path.join(telemetry, `${cur}.jsonl`), 'utf8'))).toBe(true);
    });

    await test.step('3. hook.log names each dropped line: number, bytes, reason; the fragment is capped at 120 chars', async () => {
      const log = readHookLog(repo, 'send-logs-hook.js');
      expect(log.some((l) => l.includes(`[warn] artisyn/${art}.jsonl: dropped 1 malformed JSON line(s) of 5 before upload`))).toBe(true);
      const detail = log.find((l) => l.includes(`[warn] artisyn/${art}.jsonl: dropped line 3 (${tornBytes} bytes): `));
      expect(detail, log.join('\n')).toBeTruthy();
      expect(detail).toContain('| "{\\"event\\":\\"prompt_start\\",\\"pro"');
      const longDetail = log.find((l) => l.includes(`[warn] claude/${bl}.jsonl: dropped line 2 (${Buffer.byteLength(longTorn)} bytes): `));
      expect(longDetail, log.join('\n')).toBeTruthy();
      const fragment: unknown = JSON.parse(longDetail!.slice(longDetail!.indexOf(' | ') + 3));
      expect(fragment).toBe(longTorn.slice(0, 120));
    });

    await test.step('4. a file with only broken lines is not uploaded; hook.log says why; the run still exits 0', async () => {
      expect(hub!.requests.some((r) => r.sessionId === `${bad}-all`)).toBe(false);
      expect(
        readHookLog(repo, 'send-logs-hook.js').some((l) =>
          l.includes(`[fail] artisyn/${bad}-all.jsonl: no valid JSON lines left after sanitizing`),
        ),
      ).toBe(true);
    });

    await test.step('6. privacy of the log: no API key, no request query, no prompt text in hook.log', async () => {
      const log = readHookLog(repo).join('\n');
      expect(log).toContain(`upload failed for artisyn/${bad}: HTTP 500`);
      expect(log).not.toContain(KEY);
      expect(log).not.toContain('/api/v2/logs?');
      expect(log).not.toContain('sessionId=');
      expect(log).not.toContain('PROMPT-SECRET');
    });

    await test.step('7. hook-status.logTail in the uploaded body: at most 50 lines of hook.log, without the key', async () => {
      const curReq = hub!.requests.find((r) => r.type === 'artisyn' && r.sessionId === cur)!;
      const status = ndjsonLines(curReq.body.toString('utf8'))[0];
      const tail = status.logTail;
      expect(Array.isArray(tail)).toBe(true);
      const tailLines = Array.isArray(tail) ? tail.map(String) : [];
      expect(tailLines.length).toBeGreaterThan(0);
      expect(tailLines.length).toBeLessThanOrEqual(50);
      const log = readHookLog(repo);
      for (const l of tailLines) expect(log).toContain(l);
      expect(tailLines.join('\n')).not.toContain(KEY);
    });

    await test.step('8. PostToolUse: edit_result has exactly four fields, tool_response content never lands in the telemetry file', async () => {
      const post = (tool: string, toolInput: object, toolResponse: object) =>
        runScript(
          toolDir,
          'lifecycle-hook.js',
          {
            hook_event_name: 'PostToolUse',
            session_id: cur,
            cwd: repo,
            tool_name: tool,
            tool_use_id: `tu-${tool}`,
            tool_input: toolInput,
            tool_response: toolResponse,
          },
          { home },
        );
      const file = path.join(repo, 'src', 'login.ts');
      expect(
        (
          await post('Edit', { file_path: file, old_string: 'a', new_string: 'b' }, {
            filePath: file,
            originalFile: 'RESPONSE-SECRET original file body',
            structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' x', '-a', '+b', '+c'] }],
          })
        ).code,
      ).toBe(0);
      expect(
        (await post('Write', { file_path: file, content: 'l1\nl2\nl3' }, { type: 'create', filePath: file, content: 'RESPONSE-SECRET\nl2\nl3', structuredPatch: [] })).code,
      ).toBe(0);
      expect(
        (
          await post('MultiEdit', { file_path: file, edits: [] }, {
            filePath: file,
            originalFile: 'RESPONSE-SECRET again',
            structuredPatch: [{ lines: ['-q', '-r', '+s'] }],
          })
        ).code,
      ).toBe(0);
      expect((await post('Bash', { command: 'ls' }, { stdout: 'RESPONSE-SECRET from stdout', stderr: '' })).code).toBe(0);

      const raw = fs.readFileSync(path.join(telemetry, `${cur}.jsonl`), 'utf8');
      expect(raw).not.toContain('RESPONSE-SECRET');
      const events = ndjsonLines(raw).filter((e) => e.hook_event_name === 'PostToolUse');
      const byTool = (t: string) => events.find((e) => e.tool_name === t)!;
      expect(byTool('Edit').edit_result).toEqual({ added: 2, removed: 1, changeKind: 'modified', filePath: file });
      expect(byTool('Write').edit_result).toEqual({ added: 3, removed: 0, changeKind: 'added', filePath: file });
      expect(byTool('MultiEdit').edit_result).toEqual({ added: 1, removed: 2, changeKind: 'modified', filePath: file });
      expect(byTool('Bash').edit_result).toBeUndefined();
      expect(byTool('Edit').tool_input).toEqual({ file_path: file, old_string: 'a', new_string: 'b' });
    });

    await test.step('9. the local config never reaches telemetry or any uploaded body', async () => {
      hub!.requests.length = 0;
      expect((await runHook(toolDir, { hook_event_name: 'Stop', session_id: cur, cwd: repo }, { home })).code).toBe(0);
      expect(hub!.requests.length).toBeGreaterThan(0);
      for (const name of fs.readdirSync(telemetry)) {
        const p = path.join(telemetry, name);
        if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, 'utf8'), name).not.toContain(KEY);
      }
      for (const r of hub!.requests) expect(r.body.toString('utf8'), `${r.type}/${r.sessionId}`).not.toContain(KEY);
    });

    await test.step('5. the stand accepts the repaired files: the session is ingested with the kept lines', async () => {
      const owner = await users.user('user', { label: 'h02-owner' });
      const key = await createApiKey(owner.api);
      writeStandConfig(repo, stand.url, key.key);
      fs.rmSync(path.join(telemetry, `${bad}.jsonl`));
      fs.rmSync(path.join(telemetry, '.claude-logs.sent'), { force: true });
      const res = await runHook(toolDir, { hook_event_name: 'Stop', session_id: cur, cwd: repo }, { home });
      expect(res.code, res.stderr).toBe(0);
      await waitForQueueIdle(db, owner.id);
      const stored = await storedBody(db, art, 'artisyn');
      expect(stored, 'artisyn log of the repaired session').not.toBeNull();
      expect(stored!.map((e) => (isRecord(e) ? e.event : null))).toEqual(['session_start', 'prompt_start', 'prompt_stop']);
      expect(await storedBody(db, bl, 'claude')).toHaveLength(1);
      const repos = await (await owner.api.get('/api/v1/repositories')).json();
      expect(JSON.stringify(repos)).toContain(repoUrl);
    });
  } finally {
    await hub?.close();
    dirs.cleanup();
  }
});
