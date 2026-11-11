// Runs the hook's own advisor prompt (post-turn-analysis-worker.js + advisor-evidence.js) on real
// local transcripts, as the worker would build it. Writes out/hook/<id>.json (gitignored).
// usage: node run-hook.mjs <transcripts dir> <pricing server url> <session id prefix>... [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HOOK = '../../../hook/.claude/telemetry_tool/';
const w = require(`${HOOK}post-turn-analysis-worker.js`);
const { buildAdvisorEvidence } = require(`${HOOK}advisor-evidence.js`);
const { callLlmAsync } = require(`${HOOK}claude-invoke-async.js`);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const [dir, serverUrl, ...rest] = process.argv.slice(2);
const dry = rest.includes('--dry');
const ids = rest.filter((a) => !a.startsWith('--'));
const outDir = path.join(here, 'out', 'hook');
fs.mkdirSync(outDir, { recursive: true });

const pricing = await w.fetchModelPricing(serverUrl, '', 10000);
console.log(pricing ? `pricing: ${Object.keys(pricing).length} models` : 'pricing: unavailable, list prices');

function parseJson(text) {
  const m = text && text.match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

for (const prefix of ids) {
  const file = fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
  if (!file) {
    console.error(`${prefix}: no transcript`);
    continue;
  }
  const transcriptPath = path.join(dir, file);
  const entries = w.readTranscriptEntries(transcriptPath);
  const local = w.deriveLocalAggregate(entries, { fileCategories: [] });
  const model = local.model;
  const aggregate = { ...local, contextWindow: pricing && model && pricing[model] ? pricing[model].contextLength : null };
  const evidence = buildAdvisorEvidence({
    transcriptPath,
    entries,
    pricing,
    pickCallRates: w.pickCallRates,
    readEntries: w.readTranscriptEntries,
    helpers: { isQualifyingUserEvent: w.isQualifyingUserEvent, getPromptText: w.getPromptText, isCommandMessagePrompt: w.isCommandMessagePrompt },
  });
  const prompt = w.buildAdvisorPrompt(aggregate, w.computeContextUsage(entries), w.resolveSkillInvocations(transcriptPath, repoRoot), evidence, 60 * 1024);
  const rec = { id: prefix, totalUsd: evidence.totalUsd, promptBytes: Buffer.byteLength(prompt) };
  if (dry) rec.prompt = prompt;
  else {
    const r = await callLlmAsync(prompt, 'sonnet', 600000, 'claude');
    rec.result = r.ok ? parseJson(r.text) : { error: r.failureKind };
    rec.llmUsd = r.costUsd;
  }
  fs.writeFileSync(path.join(outDir, `${prefix}.json`), JSON.stringify(rec, null, 2));
  console.log(`${prefix}: total $${evidence.totalUsd.toFixed(2)}, prompt ${rec.promptBytes} bytes${dry ? '' : `, llm $${rec.llmUsd}`}`);
}
