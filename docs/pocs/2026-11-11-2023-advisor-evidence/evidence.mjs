// Computes the advisor "evidence" for one session: deterministic, number-backed facts the LLM
// may cite. Reads the main transcript plus every subagent/workflow transcript next to it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const worker = require('../../../hook/.claude/telemetry_tool/post-turn-analysis-worker.js');

// $/Mtok list prices (input, output). Cache read = 0.1x input, 5m write = 1.25x, 1h write = 2x.
const PRICES = [
  [/opus/i, 5, 25],
  [/fable/i, 5, 25],
  [/sonnet/i, 3, 15],
  [/haiku/i, 1, 5],
];
function rates(model) {
  const hit = PRICES.find(([re]) => re.test(model || ''));
  return hit ? { in: hit[1], out: hit[2] } : { in: 3, out: 15 };
}

const CACHE_TTL_5M_S = 300;
const REBUILD_MIN_TOKENS = 20000;
const BIG_RESULT_MIN_TOKENS = 3000;
const CHARS_PER_TOKEN = 3.5;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '' : JSON.stringify(b))).join('');
}

/** One API call per message id; the last streamed chunk carries the final usage. */
function collectCalls(entries) {
  const byId = new Map();
  const calls = [];
  entries.forEach((e, idx) => {
    if (e.type !== 'assistant' || !e.message || !e.message.usage) return;
    const id = e.message.id || `idx-${idx}`;
    let c = byId.get(id);
    if (!c) {
      c = { id, idx, ts: Date.parse(e.timestamp), model: e.message.model, usage: e.message.usage };
      byId.set(id, c);
      calls.push(c);
    } else {
      c.usage = e.message.usage;
    }
  });
  for (const c of calls) {
    const u = c.usage;
    const r = rates(c.model);
    const write = u.cache_creation_input_tokens || 0;
    const w1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
    const w5m = write - w1h;
    c.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + write;
    c.write = write;
    c.w1h = w1h;
    c.parts = {
      read: ((u.cache_read_input_tokens || 0) * r.in * 0.1) / 1e6,
      write: (w5m * r.in * 1.25 + w1h * r.in * 2) / 1e6,
      output: ((u.output_tokens || 0) * r.out) / 1e6,
      input: ((u.input_tokens || 0) * r.in) / 1e6,
    };
    c.cost = c.parts.read + c.parts.write + c.parts.output + c.parts.input;
  }
  return calls;
}

function sum(arr, f) {
  return arr.reduce((a, x) => a + f(x), 0);
}

// Absolute paths are machine-specific and would surface in the UI: keep the last two segments.
function stripAbsPaths(s) {
  return s.replace(/(?:[A-Za-z]:|~)?[\\/][^\s"'`;|]*/g, (m) => {
    const segs = m.split(/[\\/]/).filter(Boolean);
    return segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : m;
  });
}

function shortTarget(name, input) {
  if (!input) return '';
  const p = input.file_path || input.path || input.notebook_path;
  if (p) return String(p).split(/[\\/]/).slice(-3).join('/');
  if (input.command) return stripAbsPaths(String(input.command).replace(/\s+/g, ' ')).slice(0, 90);
  if (input.url) return String(input.url).slice(0, 90);
  if (input.pattern) return `pattern ${String(input.pattern).slice(0, 60)}`;
  if (input.description) return String(input.description).slice(0, 80);
  if (input.skill) return String(input.skill);
  return JSON.stringify(input).slice(0, 80);
}

function analyseTranscript(entries) {
  const calls = collectCalls(entries);
  const callIndexByEntryIdx = new Map(calls.map((c, i) => [c.idx, i]));
  const toolUses = new Map();
  const results = [];
  let lastCallIndex = -1;
  entries.forEach((e, idx) => {
    if (callIndexByEntryIdx.has(idx)) lastCallIndex = callIndexByEntryIdx.get(idx);
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      const ci = calls.findIndex((c) => c.id === e.message.id);
      for (const b of e.message.content) {
        if (b && b.type === 'tool_use') toolUses.set(b.id, { name: b.name, input: b.input, callIndex: ci >= 0 ? ci : lastCallIndex });
      }
    }
    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const tu = toolUses.get(b.tool_use_id) || {};
        const text = textOf(b.content);
        const images = Array.isArray(b.content) ? b.content.filter((x) => x && x.type === 'image').length : 0;
        results.push({ name: tu.name || '?', input: tu.input, callIndex: tu.callIndex ?? lastCallIndex, chars: text.length, images, isError: b.is_error === true, errorHead: b.is_error ? text.replace(/\s+/g, ' ').slice(0, 140) : null });
      }
    }
  });
  return { calls, results };
}

function cacheRebuilds(calls) {
  const out = [];
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1];
    const c = calls[i];
    if (c.write < REBUILD_MIN_TOKENS || c.write < 0.5 * prev.ctx) continue;
    const gapS = (c.ts - prev.ts) / 1000;
    const ttlS = prev.w1h > 0 || c.w1h > 0 ? 3600 : CACHE_TTL_5M_S;
    let cause = 'unknown (cache prefix changed)';
    if (prev.model !== c.model) cause = `model switched ${prev.model} -> ${c.model}`;
    else if (gapS > ttlS) cause = `idle ${Math.round(gapS / 60)} min > cache TTL ${ttlS / 60} min`;
    const r = rates(c.model);
    const extra = (c.write * r.in * (c.w1h ? 2 : 1.25) - c.write * r.in * 0.1) / 1e6;
    out.push({ callNo: i + 1, tokens: c.write, extraUsd: extra, cause });
  }
  return out;
}

// A full-size screenshot is ~1.2-1.6k tokens; use the upper end so the figure is not understated.
const IMAGE_TOKENS = 1600;

/** Images returned by tool calls, and what carrying them through the later calls cost. */
function imageCost(calls, results) {
  let count = 0;
  let usdCarried = 0;
  for (const r of results) {
    if (!r.images) continue;
    count += r.images;
    const later = Math.max(0, calls.length - r.callIndex - 1);
    const rr = rates(calls[Math.max(0, r.callIndex)] && calls[Math.max(0, r.callIndex)].model);
    const tok = r.images * IMAGE_TOKENS;
    usdCarried += (tok * rr.in * 1.25 + tok * rr.in * 0.1 * later) / 1e6;
  }
  return { count, usdCarried };
}

function firstUserText(entries) {
  const e = entries.find((x) => x.type === 'user' && x.message && (typeof x.message.content === 'string' || (Array.isArray(x.message.content) && x.message.content.some((b) => b.type === 'text'))));
  if (!e) return '';
  // A workflow agent's brief starts with a fixed harness preamble; keep only the task itself.
  const text = textOf(e.message.content);
  const marker = 'The computed task text follows:';
  const task = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text;
  return stripAbsPaths(task.replace(/\s+/g, ' ').trim());
}

function toolMix(results) {
  const m = new Map();
  for (const r of results) m.set(r.name, (m.get(r.name) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
}

function listAgentFiles(transcriptPath) {
  const dir = transcriptPath.replace(/\.jsonl$/, '');
  const out = [];
  const walk = (d) => {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (/^agent-.*\.jsonl$/.test(it.name)) out.push(p);
    }
  };
  walk(path.join(dir, 'subagents'));
  return out;
}

function readMeta(agentFile) {
  try {
    return JSON.parse(fs.readFileSync(agentFile.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

const usd = (v) => `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`;
const kt = (v) => `${Math.round(v / 1000)}k`;

/**
 * @returns {{ text: string, facts: object }}
 */
export function buildEvidence(transcriptPath) {
  const entries = worker.readTranscriptEntries(transcriptPath);
  const main = analyseTranscript(entries);
  const mainCost = sum(main.calls, (c) => c.cost);

  // Per-prompt cost: calls between one qualifying prompt and the next belong to it.
  const prompts = [];
  let current = null;
  const callIdxSet = new Map(main.calls.map((c, i) => [c.idx, i]));
  entries.forEach((e, idx) => {
    const raw = e.type === 'user' && !e.isMeta && e.message && typeof e.message.content === 'string' ? e.message.content.trimStart() : '';
    const queued = e.type === 'attachment' && e.attachment && e.attachment.type === 'queued_command' ? e.attachment : null;
    if (raw.startsWith('<task-notification>')) {
      // The model's reaction to a finished background task: not the user's prompt, own line.
      current = { text: '(automatic turn: a background task finished)', auto: true, calls: 0, usd: 0, ctxStart: null, ctxEnd: null };
      prompts.push(current);
    } else if (e.type === 'user' && e.isCompactSummary) {
      current = { text: '(context compacted: the session continued from a summary)', auto: true, calls: 0, usd: 0, ctxStart: null, ctxEnd: null };
      prompts.push(current);
    } else if (queued && typeof queued.prompt === 'string') {
      // A prompt typed while the model was busy is delivered mid-turn as an attachment.
      const human = !queued.origin || queued.origin.kind === 'human';
      current = human
        ? { text: `${queued.prompt} (typed while the model was working)`, calls: 0, usd: 0, ctxStart: null, ctxEnd: null }
        : { text: queued.prompt.trimStart().startsWith('<task-notification>') ? '(automatic turn: a background task finished)' : `(automatic turn: ${queued.origin.kind}) ${queued.prompt.slice(0, 150)}`, auto: true, calls: 0, usd: 0, ctxStart: null, ctxEnd: null };
      prompts.push(current);
    } else if (worker.isQualifyingUserEvent(e)) {
      const text = worker.getPromptText(e);
      if (!text.trimStart().startsWith('<local-command')) {
        current = { text, calls: 0, usd: 0, ctxStart: null, ctxEnd: null };
        prompts.push(current);
      }
    }
    if (current && callIdxSet.has(idx)) {
      const c = main.calls[callIdxSet.get(idx)];
      current.calls++;
      current.usd += c.cost;
      if (current.ctxStart == null) current.ctxStart = c.ctx;
      current.ctxEnd = c.ctx;
    }
  });

  // Subagents / workflow agents.
  const agents = listAgentFiles(transcriptPath).map((f) => {
    const agentEntries = worker.readTranscriptEntries(f);
    const a = analyseTranscript(agentEntries);
    const meta = readMeta(f);
    const reb = cacheRebuilds(a.calls);
    return {
      brief: firstUserText(agentEntries),
      running: meta.finished === false,
      toolCalls: a.results.length,
      startupUsd: a.calls[0] ? a.calls[0].cost : 0,
      images: imageCost(a.calls, a.results),
      rebuildNote: reb.length ? `${reb.length} cache rebuild(s) +${usd(sum(reb, (r) => r.extraUsd))} (${reb[0].cause})` : '',
      description: meta.description || path.basename(f, '.jsonl'),
      type: meta.agentType || (f.includes(`${path.sep}workflows${path.sep}`) ? 'workflow-agent' : 'subagent'),
      inWorkflow: /[\\/]workflows[\\/]/.test(f),
      model: [...new Set(a.calls.map((c) => c.model))].join(','),
      calls: a.calls.length,
      usd: sum(a.calls, (c) => c.cost),
      ctxStart: a.calls[0] ? a.calls[0].ctx : 0,
      ctxPeak: Math.max(0, ...a.calls.map((c) => c.ctx)),
      outputUsd: sum(a.calls, (c) => c.parts.output),
      errors: a.results.filter((r) => r.isError).length,
      toolMix: toolMix(a.results),
      rebuildUsd: sum(reb, (r) => r.extraUsd),
    };
  });
  const agentsCost = sum(agents, (a) => a.usd);
  const total = mainCost + agentsCost;

  const parts = { read: 0, write: 0, output: 0, input: 0 };
  for (const c of main.calls) for (const k in parts) parts[k] += c.parts[k];

  const rebuilds = cacheRebuilds(main.calls);

  // Tool results that stayed in the main context, priced by how many later calls re-read them.
  const n = main.calls.length;
  const big = main.results
    .map((r) => {
      const tok = r.chars / CHARS_PER_TOKEN;
      const later = Math.max(0, n - r.callIndex - 1);
      const rr = rates(main.calls[Math.max(0, r.callIndex)] && main.calls[Math.max(0, r.callIndex)].model);
      return { ...r, tok, later, carriedUsd: (tok * rr.in * 1.25 + tok * rr.in * 0.1 * later) / 1e6 };
    })
    .filter((r) => r.tok >= BIG_RESULT_MIN_TOKENS)
    .sort((a, b) => b.carriedUsd - a.carriedUsd)
    .slice(0, 6);

  const reads = new Map();
  for (const r of main.results) {
    if (r.name !== 'Read' || !r.input || !r.input.file_path) continue;
    const k = String(r.input.file_path).replace(/\\/g, '/').toLowerCase();
    const v = reads.get(k) || { file: shortTarget('Read', r.input), n: 0, chars: 0 };
    v.n++;
    v.chars += r.chars;
    reads.set(k, v);
  }
  const rereads = [...reads.values()].filter((v) => v.n >= 3 || (v.n >= 2 && v.chars > 20000)).sort((a, b) => b.chars - a.chars).slice(0, 5);

  const errs = main.results.filter((r) => r.isError);
  const errByTool = new Map();
  for (const r of errs) {
    const v = errByTool.get(r.name) || { n: 0, sample: r.errorHead };
    v.n++;
    errByTool.set(r.name, v);
  }

  const L = [];
  L.push('Cost structure (estimated from the local transcripts at list prices):');
  L.push(`- Total ${usd(total)} = this session ${usd(mainCost)} (${n} API calls) + ${agents.length} subagent/workflow agents ${usd(agentsCost)}`);
  if (mainCost > 0) {
    const pct = (v) => `${Math.round((100 * v) / mainCost)}%`;
    L.push(`- This session by token kind: cache reads ${usd(parts.read)} (${pct(parts.read)}), cache writes ${usd(parts.write)} (${pct(parts.write)}), output ${usd(parts.output)} (${pct(parts.output)}), uncached input ${usd(parts.input)}`);
  }
  if (n > 0) {
    const ctxs = main.calls.map((c) => c.ctx);
    const over = main.calls.filter((c) => c.ctx > 200000);
    L.push(`- Context per call: first ${kt(ctxs[0])}, median ${kt([...ctxs].sort((a, b) => a - b)[Math.floor(n / 2)])}, peak ${kt(Math.max(...ctxs))}; ${over.length} calls ran above 200k context and cost ${usd(sum(over, (c) => c.cost))}`);
  }
  L.push('');
  const running = agents.filter((a) => a.running).length;
  L.push(`- Status: figures are as of the end of the latest turn; the session may continue.${running ? ` ${running} agent(s) still running.` : ''}`);
  const mainImages = imageCost(main.calls, main.results);
  if (mainImages.count) L.push(`- Images (screenshots, image files) returned into this session's context: ${mainImages.count}, ~${kt(mainImages.count * IMAGE_TOKENS)} tokens, est. cost of carrying them ${usd(mainImages.usdCarried)}`);
  L.push('');
  L.push('Subagents and workflow agents (most expensive first: description | type | model | API calls | cost (of which first call = startup context write) | context at start -> peak | tool calls by tool | notes), then the first 200 characters of its brief:');
  if (agents.length === 0) L.push('(none)');
  const sortedAgents = [...agents].sort((x, y) => y.usd - x.usd);
  for (const a of sortedAgents.slice(0, 12)) {
    const notes = [
      a.running ? 'STILL RUNNING' : '',
      a.errors ? `${a.errors} failed tool calls` : '',
      a.images.count ? `${a.images.count} images in context (~${usd(a.images.usdCarried)})` : '',
      a.rebuildNote,
    ].filter(Boolean).join('; ');
    L.push(`- "${a.description}" | ${a.inWorkflow ? 'workflow agent' : a.type} | ${a.model} | ${a.calls} | ${usd(a.usd)} (${usd(a.startupUsd)}) | ${kt(a.ctxStart)} -> ${kt(a.ctxPeak)} | ${a.toolMix} | ${notes || '-'}`);
    if (a.brief) L.push(`    brief: ${a.brief.slice(0, 200)}`);
  }
  if (agents.length > 12) L.push(`- ...${agents.length - 12} more agents, ${usd(sum(sortedAgents.slice(12), (a) => a.usd))} together`);
  // Many agents that made almost no tool calls: the cost is mostly their own startup context.
  const small = agents.filter((a) => a.toolCalls <= 3);
  if (small.length >= 3) {
    const byModel = [...new Set(small.map((a) => a.model))].join(', ');
    L.push(`- ${small.length} agents made 3 or fewer tool calls each (${byModel}): ${usd(sum(small, (a) => a.usd))} together, of which ${usd(sum(small, (a) => a.startupUsd))} was writing their startup context. Examples: ${small.slice(0, 4).map((a) => `"${a.description}" (${a.toolMix})`).join(', ')}`);
  }
  L.push('');
  L.push('Cache rebuilds in this session (a cache write of more than half the context after the first call):');
  if (rebuilds.length === 0) L.push('(none)');
  for (const r of rebuilds.slice(0, 6)) L.push(`- API call #${r.callNo}: re-wrote ${kt(r.tokens)} tokens, extra ${usd(r.extraUsd)}; cause: ${r.cause}`);
  L.push('');
  L.push('Largest tool results kept in this session\'s context (tool | target | tokens | later API calls that re-read it | estimated cost of carrying it):');
  if (big.length === 0) L.push('(none above 3k tokens)');
  for (const r of big) L.push(`- ${r.name} | ${shortTarget(r.name, r.input)} | ${kt(r.tok)} | ${r.later} | ${usd(r.carriedUsd)}`);
  L.push('');
  L.push('Files read repeatedly in this session (file | reads | total KB):');
  if (rereads.length === 0) L.push('(none)');
  for (const r of rereads) L.push(`- ${r.file} | ${r.n} | ${Math.round(r.chars / 1024)}`);
  L.push('');
  L.push('Failed tool calls in this session (tool | failures | first error):');
  if (errByTool.size === 0) L.push('(none)');
  for (const [name, v] of [...errByTool.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6)) L.push(`- ${name} | ${v.n} | ${stripAbsPaths(v.sample || "")}`);

  return {
    text: L.join('\n'),
    prompts: prompts.map((p) => ({ ...p, ctxStart: p.ctxStart || 0, ctxEnd: p.ctxEnd || 0 })),
    facts: { total, mainCost, agentsCost, agents: agents.length, calls: n },
  };
}
