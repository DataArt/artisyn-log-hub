// Follow-up to probe S10: Claude Code reads project settings only from `<cwd>/.claude/`, so a
// session started in `packages/web` loads neither the plugin nor the OTEL env. Tries two ways to
// give such a session the repo's settings:
//   A) `--settings <file>`: the repo's settings.json + settings.local.json merged, the marketplace
//      path made absolute;
//   B) a `packages/web/.claude/` copy of both files with the marketplace path `../../.artisyn/marketplace`.
// For each: does the plugin load, do the hooks fire, and which ai_work_dir holds the session id.
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR, filesContaining, probeEnv, runClaude, workspace, writeResult } from './probe-lib.mjs';

const ws = workspace();
const main = ws.repoDir('ts-webapp');
const sub = path.join(main, 'packages', 'web');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const base = readJson(path.join(main, '.claude', 'settings.json'));
const local = readJson(path.join(main, '.claude', 'settings.local.json'));
const mpName = Object.keys(base.extraKnownMarketplaces)[0];
const fwd = (p) => p.replace(/\\/g, '/');

function withMarketplacePath(settings, p) {
  const copy = structuredClone(settings);
  copy.extraKnownMarketplaces[mpName].source.path = p;
  return copy;
}

async function session(name, args) {
  const r = await runClaude({
    name,
    cwd: sub,
    env: probeEnv(ws),
    args: ['--model', 'haiku', '--permission-mode', 'bypassPermissions', ...args],
    prompt: `Run exactly this Bash command: cat "${fwd(main)}/packages/core/src/index.ts" then say how many exported functions it has.`,
  });
  const init = r.events.find((e) => e.type === 'system' && e.subtype === 'init');
  const sid = init?.session_id ?? '-';
  await new Promise((res) => setTimeout(res, 8000));
  return {
    exitCode: r.exitCode,
    sessionId: sid,
    plugins: (init?.plugins ?? []).map((p) => p.source),
    hookEvents: r.events.filter((e) => e.subtype === 'hook_started').map((e) => e.hook_event ?? e.hook_name),
    sidFilesMain: filesContaining(path.join(main, '.artisyn', 'ai_work_dir'), sid),
    sidFilesSub: filesContaining(path.join(sub, '.artisyn'), sid),
  };
}

const out = {};
const flagFile = path.join(RESULTS_DIR, 's10-flag-settings.json');
fs.writeFileSync(
  flagFile,
  JSON.stringify({ ...withMarketplacePath(base, fwd(path.join(main, '.artisyn', 'marketplace'))), env: local.env }, null, 2),
);
out.flagSettings = await session('s10-flag-settings', ['--settings', `"${flagFile}"`]);

fs.mkdirSync(path.join(sub, '.claude'), { recursive: true });
fs.writeFileSync(path.join(sub, '.claude', 'settings.json'), JSON.stringify(withMarketplacePath(base, '../../.artisyn/marketplace'), null, 2));
fs.writeFileSync(path.join(sub, '.claude', 'settings.local.json'), JSON.stringify(local, null, 2));
out.subdirCopy = await session('s10-subdir-copy', []);
fs.rmSync(path.join(sub, '.claude'), { recursive: true, force: true });
writeResult('s10-settings', out);
