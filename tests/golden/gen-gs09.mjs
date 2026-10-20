#!/usr/bin/env node
/**
 * gen-gs09.mjs — deterministic generator of the GS-09 golden fixture (`gs-09-windows-paths/`).
 *
 * GS-09 is the one golden session too big to write by hand (docs/qaa-overview/scenarios/03 §2.3):
 * 400 `Edit` calls, one per file, on Windows paths under `C:\work\acme-shop`. There is no
 * randomness — running it twice writes byte-identical files, and the output is committed.
 *
 *   node tests/golden/gen-gs09.mjs            write the fixture and print its shape
 *   node tests/golden/gen-gs09.mjs --check    exit 1 if the committed files differ from a fresh run
 *
 * Shape:
 *  - folders `src\<area>\<layer>\<kind>\` — 5 × 4 × 4 = 80 leaf folders, four levels deep;
 *  - 400 files: leaves 0–3 hold 6 files, leaf 79 holds a single file (single-child), the rest 5;
 *  - three files are named `wombat-*.ts`, in three different `<area>` branches;
 *  - every Edit replaces one line with another (old 1 / new 1, no common line), so each file is
 *    written 1 line and diffs +1 −1: written 400, diff +400 / −400, 400 Edit calls, 400 files;
 *  - one prompt at 10:00:00 (W2 Thursday), 20 assistant responses of 20 parallel Edits each, every
 *    response split over one transcript line per block (same `message.id` and `usage`, as Claude
 *    Code writes them), final answer at 10:03:20 → work time 200 s;
 *  - tokens 1000 in / 500 out, no cache (sonnet-4-6 → $0.0105).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'gs-09-windows-paths');

const DAY = '2026-01-15';
const ROOT = 'C:\\work\\acme-shop';
const BRANCH = 'fix/windows';
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.99';
const SESSION_ID = '{{RUN}}-gs09';
const PROMPT = 'Bump the exported value in every module under src by one';

const AREAS = ['billing', 'catalog', 'orders', 'shipping', 'users'];
const LAYERS = ['api', 'domain', 'infra', 'ui'];
const KINDS = ['core', 'helpers', 'models', 'views'];
/** Leaf index → wombat file name (leaf = area*16 + layer*4 + kind). */
const WOMBATS = new Map([
  [7, 'wombat-alpha.ts'],
  [33, 'wombat-beta.ts'],
  [61, 'wombat-gamma.ts'],
]);
const RESPONSES = 20;
const EDITS_PER_RESPONSE = 20;

function ts(seconds) {
  const base = Date.UTC(2026, 0, 15, 10, 0, 0);
  return new Date(base + seconds * 1000).toISOString();
}

/** Files per leaf: leaves 0–3 hold 6, the last leaf 1, the rest 5 (sum 400). */
function filesInLeaf(leaf, leafCount) {
  if (leaf < 4) return 6;
  if (leaf === leafCount - 1) return 1;
  return 5;
}

function buildFiles() {
  const files = [];
  const leafCount = AREAS.length * LAYERS.length * KINDS.length;
  let leaf = 0;
  for (const area of AREAS) {
    for (const layer of LAYERS) {
      for (const kind of KINDS) {
        const n = filesInLeaf(leaf, leafCount);
        for (let i = 0; i < n; i++) {
          const name = i === 0 && WOMBATS.has(leaf) ? WOMBATS.get(leaf) : `${kind}-${i + 1}.ts`;
          files.push({ rel: ['src', area, layer, kind, name].join('\\'), leaf });
        }
        leaf += 1;
      }
    }
  }
  return { files, leafCount };
}

function envelope(type, uuid, parentUuid, timestamp, extra) {
  return {
    type,
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_ID,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: ROOT,
    gitBranch: BRANCH,
    version: VERSION,
    ...extra,
  };
}

function usage(input, output) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: output,
    service_tier: 'standard',
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  };
}

export function generate() {
  const { files, leafCount } = buildFiles();
  if (files.length !== RESPONSES * EDITS_PER_RESPONSE) {
    throw new Error(`expected ${RESPONSES * EDITS_PER_RESPONSE} files, built ${files.length}`);
  }

  const lines = [];
  let seq = 0;
  let last = null;
  const nextUuid = () => `gs09-${String(++seq).padStart(4, '0')}`;
  const promptId = 'gs09-p1';

  lines.push({ type: 'mode', mode: 'normal', sessionId: SESSION_ID });
  const prompt = envelope('user', nextUuid(), last, ts(0), { promptId, message: { role: 'user', content: PROMPT } });
  lines.push(prompt);
  last = prompt.uuid;

  for (let r = 0; r < RESPONSES; r++) {
    const at = 5 + 9 * r;
    const msgId = `msg_gs09_${String(r + 1).padStart(3, '0')}`;
    const u = usage(45, 20);
    const batch = files.slice(r * EDITS_PER_RESPONSE, (r + 1) * EDITS_PER_RESPONSE);
    const calls = batch.map((file, i) => {
      const n = r * EDITS_PER_RESPONSE + i + 1;
      const filePath = `${ROOT}\\${file.rel}`;
      const oldString = `export const value = ${n};`;
      const newString = `export const value = ${n + 1};`;
      return { id: `toolu_gs09_${String(n).padStart(3, '0')}`, filePath, oldString, newString };
    });
    // One transcript line per tool_use block, all repeating the response's id and usage.
    for (const call of calls) {
      const line = envelope('assistant', nextUuid(), last, ts(at), {
        requestId: `req_gs09_${String(r + 1).padStart(3, '0')}`,
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [
            {
              type: 'tool_use',
              id: call.id,
              name: 'Edit',
              input: { file_path: call.filePath, old_string: call.oldString, new_string: call.newString, replace_all: false },
            },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: u,
        },
      });
      lines.push(line);
      last = line.uuid;
    }
    const assistantUuid = last;
    for (const call of calls) {
      const line = envelope('user', nextUuid(), last, ts(at + 1), {
        promptId,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: call.id, content: `The file ${call.filePath} has been updated successfully.` }],
        },
        toolUseResult: {
          filePath: call.filePath,
          oldString: call.oldString,
          newString: call.newString,
          originalFile: null,
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${call.oldString}`, `+${call.newString}`] }],
          userModified: false,
          replaceAll: false,
        },
        sourceToolAssistantUUID: assistantUuid,
      });
      lines.push(line);
      last = line.uuid;
    }
  }

  const final = envelope('assistant', nextUuid(), last, ts(200), {
    requestId: 'req_gs09_final',
    message: {
      id: 'msg_gs09_final',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'Bumped the exported value in all 400 modules.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: usage(100, 100),
    },
  });
  lines.push(final);

  const git = { repo: '{{REPO}}', root: ROOT, worktreeRoot: ROOT, branch: BRANCH, user: 'Golden Tester' };
  // The hook's own lines: lifecycle-hook.js writes SessionStart (with `git`) and SessionEnd,
  // telemetry-hook.js writes prompt_start. SessionEnd sits on the transcript's last line, so the
  // session's end time covers the whole turn (the work-time report clamps to it).
  const artisyn = [
    { type: 'artisyn', hook_event_name: 'SessionStart', timestamp: ts(0), session_id: SESSION_ID, git },
    { event: 'prompt_start', timestamp: ts(0), session_id: SESSION_ID, prompt: PROMPT, git },
    { type: 'artisyn', hook_event_name: 'SessionEnd', timestamp: ts(200), session_id: SESSION_ID },
  ];

  const upload = {
    fixture: 'GS-09',
    generatedBy: 'tests/golden/gen-gs09.mjs',
    roots: [{ key: 'gs09', sessionId: SESSION_ID, artisyn: 'artisyn.jsonl', claude: 'session.jsonl', subagents: [] }],
  };

  // Shape facts for expected.json (folders counted as distinct directory prefixes under the repo root).
  const folders = new Set();
  for (const f of files) {
    const parts = f.rel.split('\\');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const leafFolders = new Set(files.map((f) => f.rel.split('\\').slice(0, -1).join('/')));
  const stats = {
    files: files.length,
    editCalls: files.length,
    leafFolders: leafFolders.size,
    folders: folders.size,
    topLevelAreas: AREAS.length,
    leafCount,
    singleFileLeaves: [...leafFolders].filter((d) => files.filter((f) => f.rel.split('\\').slice(0, -1).join('/') === d).length === 1),
    wombats: files.filter((f) => f.rel.includes('wombat-')).map((f) => f.rel.replace(/\\/g, '/')),
  };

  return {
    files: {
      'session.jsonl': lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'artisyn.jsonl': artisyn.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'upload.json': JSON.stringify(upload, null, 2) + '\n',
    },
    stats,
  };
}

function main() {
  const check = process.argv.includes('--check');
  const { files, stats } = generate();
  if (check) {
    const stale = Object.entries(files).filter(([name, content]) => {
      const file = path.join(OUT_DIR, name);
      return !fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== content;
    });
    if (stale.length > 0) {
      console.error(`gs-09-windows-paths is stale: ${stale.map(([n]) => n).join(', ')} — run node tests/golden/gen-gs09.mjs`);
      process.exit(1);
    }
    console.log('gs-09-windows-paths is up to date');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT_DIR, name), content, 'utf8');
  }
  console.log(JSON.stringify(stats, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
