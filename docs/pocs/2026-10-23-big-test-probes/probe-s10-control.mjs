// Control for probe S10: the same session from the ts-webapp ROOT, then again from `packages/web`
// with `--debug` output on stderr, to tell "the plugin never loads from a subdirectory" apart from
// a ts-webapp-specific problem.
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR, filesContaining, probeEnv, runClaude, workspace, writeResult } from './probe-lib.mjs';

const ws = workspace();
const main = ws.repoDir('ts-webapp');
const prompt = 'Say hi in one word.';
const out = {};
for (const [name, cwd, extra] of [
  ['s10-root', main, []],
  ['s10-subdir-debug', path.join(main, 'packages', 'web'), ['--debug']],
]) {
  const r = await runClaude({ name, cwd, env: probeEnv(ws), args: ['--model', 'haiku', ...extra], prompt });
  const init = r.events.find((e) => e.type === 'system' && e.subtype === 'init');
  const stderr = fs.readFileSync(path.join(RESULTS_DIR, `${name}.stderr.log`), 'utf8');
  out[name] = {
    exitCode: r.exitCode,
    sessionId: init?.session_id,
    plugins: (init?.plugins ?? []).map((p) => p.source),
    hookEvents: r.events.filter((e) => e.subtype === 'hook_started').map((e) => e.hook_event ?? e.hook_name),
    sidFiles: filesContaining(path.join(main, '.artisyn', 'ai_work_dir'), init?.session_id ?? '-'),
    pluginDebug: stderr
      .split(/\r?\n/)
      .filter((l) => /plugin|marketplace|artisyn/i.test(l))
      .slice(0, 25),
  };
}
writeResult('s10-control', out);
