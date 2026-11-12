// Runs the current (v1) and proposed (v2) advisor prompts on real local transcripts.
// usage: node run.mjs <transcripts dir> <session id prefix>... [--model sonnet] [--dry]
// Writes out/<id>.json (gitignored: it holds real session prompts).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildEvidence } from './evidence.mjs';
import { buildAdvisorPromptV2 } from './prompt-v2.mjs';

const require = createRequire(import.meta.url);
const HOOK = '../../../hook/.claude/telemetry_tool/';
const worker = require(`${HOOK}post-turn-analysis-worker.js`);
const { callLlmAsync } = require(`${HOOK}claude-invoke-async.js`);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const dir = args[0];
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'sonnet';
const dry = args.includes('--dry');
const ids = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i] !== model);
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

function parseJson(text) {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function v1Prompt(transcriptPath, evidence) {
  const entries = worker.readTranscriptEntries(transcriptPath);
  const local = worker.deriveLocalAggregate(entries, { fileCategories: [] });
  const aggregate = { ...local, sessionCostUsd: +evidence.facts.total.toFixed(2), contextWindow: null };
  return worker.buildAdvisorPrompt(
    aggregate,
    worker.computeContextUsage(entries),
    worker.resolveSkillInvocations(transcriptPath, repoRoot),
    worker.buildPromptTurns(entries),
    60 * 1024,
  );
}

async function one(prefix) {
  const file = fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
  if (!file) throw new Error(`no transcript for ${prefix}`);
  const transcriptPath = path.join(dir, file);
  const evidence = buildEvidence(transcriptPath);
  const entries = worker.readTranscriptEntries(transcriptPath);
  const p1 = v1Prompt(transcriptPath, evidence);
  const p2 = buildAdvisorPromptV2(evidence, { model: worker.deriveLastAssistantModel(entries), contextWindow: null });
  const rec = { id: prefix, facts: evidence.facts, evidence: evidence.text, promptBytes: { v1: Buffer.byteLength(p1), v2: Buffer.byteLength(p2) } };
  if (!dry) {
    const [r1, r2] = await Promise.all([callLlmAsync(p1, model, 600000, 'claude'), callLlmAsync(p2, model, 600000, 'claude')]);
    rec.v1 = r1.ok ? parseJson(r1.text) : { error: r1.failureKind };
    rec.v2 = r2.ok ? parseJson(r2.text) : { error: r2.failureKind };
    rec.llmCost = { v1: r1.costUsd, v2: r2.costUsd };
  } else {
    rec.v2Prompt = p2;
  }
  fs.writeFileSync(path.join(outDir, `${prefix}.json`), JSON.stringify(rec, null, 2));
  console.log(`${prefix}: total $${evidence.facts.total.toFixed(2)}, prompt ${rec.promptBytes.v1} -> ${rec.promptBytes.v2} bytes${dry ? '' : `, llm $${rec.llmCost.v1}/$${rec.llmCost.v2}`}`);
}

for (const id of ids) {
  try {
    await one(id);
  } catch (err) {
    console.error(`${id}: ${err.message}`);
  }
}
