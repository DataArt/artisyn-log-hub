'use strict';

/**
 * Evidence for the Turn-End Cost Advisor: number-backed facts the advisor LLM may cite, computed
 * from the session's own transcript and every subagent / workflow-agent transcript stored next to
 * it (`<session>/subagents/**\/agent-*.jsonl` with a `.meta.json` each).
 *
 * Without these figures the model only sees counters and falls back to stock tips; with them it can
 * name the prompt, agent or file that cost the money. See
 * docs/knowledgebase/algorithms/advisor-evidence.md for the rules and
 * docs/pocs/2026-11-11-2023-advisor-evidence/ for how the shape was chosen.
 *
 * Pure apart from reading the agent transcripts; every read is fail-open.
 */

const fs = require('fs');
const path = require('path');

/** List prices ($/Mtok in, out) used only when the server's model-pricing lookup has no entry. */
const LIST_PRICES = [
  [/opus|fable/i, 5, 25],
  [/sonnet/i, 3, 15],
  [/haiku/i, 1, 5],
];
const FAST_MODE_MULTIPLIER = 2;
const CACHE_TTL_5M_S = 300;
const CACHE_TTL_1H_S = 3600;
/** A cache write this big and over half the previous context is a rebuild, not growth. */
const REBUILD_MIN_TOKENS = 20000;
const BIG_RESULT_MIN_TOKENS = 3000;
const CHARS_PER_TOKEN = 3.5;
/** A full-size screenshot is ~1.2-1.6k tokens; the upper end keeps the figure from being understated. */
const IMAGE_TOKENS = 1600;
const LARGE_CONTEXT_TOKENS = 200000;
const MAX_AGENT_LINES = 12;
const SMALL_AGENT_MAX_TOOL_CALLS = 3;
const SMALL_AGENT_GROUP_MIN = 3;
const BRIEF_CHARS = 200;
const WORKFLOW_BRIEF_MARKER = 'The computed task text follows:';
const WORKFLOW_REQUEST_PREFIX = '[Workflow harness — user request]';
const WORKFLOW_REQUEST_END = 'this request wins:';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * A per-call pricer. Uses the server's `GET /api/v1/model-pricing` rates (tier-aware through
 * `pickCallRates`) when the model is there, list prices otherwise.
 * @param {Record<string, *>|null} pricing
 * @param {(promptTokens: number, rates: *) => *} pickCallRates
 * @returns {{ price: (model: string|null, usage: *) => { read: number, write: number, output: number, input: number }, usedListPrices: () => boolean }}
 */
function makePricer(pricing, pickCallRates) {
  let listUsed = false;
  function ratesFor(model, promptTokens) {
    const server = pricing && model ? pricing[model] : null;
    if (server) return pickCallRates(promptTokens, server);
    listUsed = true;
    const hit = LIST_PRICES.find(([re]) => re.test(model || ''));
    const pin = hit ? hit[1] : 3;
    const pout = hit ? hit[2] : 15;
    return { priceIn: pin, priceOut: pout, priceCacheR: pin * 0.1, priceCacheW5m: pin * 1.25, priceCacheW1h: pin * 2 };
  }
  return {
    price(model, usage) {
      const t = readTokens(usage);
      const r = ratesFor(model, t.input + t.read + t.write5m + t.write1h);
      const fast = usage && usage.speed === 'fast' ? FAST_MODE_MULTIPLIER : 1;
      return {
        read: (t.read * r.priceCacheR) / 1e6,
        write: (t.write5m * r.priceCacheW5m + t.write1h * r.priceCacheW1h) / 1e6,
        output: (t.output * fast * r.priceOut) / 1e6,
        input: (t.input * fast * r.priceIn) / 1e6,
      };
    },
    usedListPrices: () => listUsed,
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readTokens(usage) {
  const u = usage || {};
  const write = num(u.cache_creation_input_tokens);
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const w1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const w5m = cc && num(cc.ephemeral_5m_input_tokens) + w1h > 0 ? num(cc.ephemeral_5m_input_tokens) : write - w1h;
  return { input: num(u.input_tokens), output: num(u.output_tokens), read: num(u.cache_read_input_tokens), write5m: w5m, write1h: w1h };
}

// ---------------------------------------------------------------------------
// Transcript analysis
// ---------------------------------------------------------------------------

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '' : JSON.stringify(b)))
    .join('');
}

/**
 * One API call per `message.id` (streamed chunks repeat it; the last carries the final usage),
 * priced and with its context size.
 * @param {Array<Record<string, *>>} entries
 * @param {ReturnType<typeof makePricer>} pricer
 */
function collectCalls(entries, pricer) {
  const byId = new Map();
  const calls = [];
  entries.forEach((e, idx) => {
    if (!e || e.type !== 'assistant' || !e.message || !e.message.usage) return;
    const id = e.message.id || `idx-${idx}`;
    const known = byId.get(id);
    if (known) {
      known.usage = e.message.usage;
      return;
    }
    const call = { id, idx, ts: Date.parse(e.timestamp), model: e.message.model || null, usage: e.message.usage };
    byId.set(id, call);
    calls.push(call);
  });
  for (const c of calls) {
    const t = readTokens(c.usage);
    c.ctx = t.input + t.read + t.write5m + t.write1h;
    c.write = t.write5m + t.write1h;
    c.w1h = t.write1h;
    c.parts = pricer.price(c.model, c.usage);
    c.cost = c.parts.read + c.parts.write + c.parts.output + c.parts.input;
  }
  return calls;
}

/**
 * The calls plus every tool result with the call that requested it.
 * @param {Array<Record<string, *>>} entries
 * @param {ReturnType<typeof makePricer>} pricer
 */
function analyseTranscript(entries, pricer) {
  const calls = collectCalls(entries, pricer);
  const callIndexById = new Map(calls.map((c, i) => [c.id, i]));
  const toolUses = new Map();
  const results = [];
  let lastCallIndex = -1;
  for (const e of entries) {
    if (e && e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      const ci = callIndexById.has(e.message.id) ? callIndexById.get(e.message.id) : lastCallIndex;
      if (ci >= 0) lastCallIndex = ci;
      for (const b of e.message.content) {
        if (b && b.type === 'tool_use') toolUses.set(b.id, { name: b.name, input: b.input, callIndex: ci });
      }
    }
    if (e && e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const tu = toolUses.get(b.tool_use_id) || {};
        const text = textOf(b.content);
        results.push({
          name: tu.name || 'unknown',
          input: tu.input,
          callIndex: typeof tu.callIndex === 'number' ? tu.callIndex : lastCallIndex,
          chars: text.length,
          images: Array.isArray(b.content) ? b.content.filter((x) => x && x.type === 'image').length : 0,
          isError: b.is_error === true,
          errorHead: b.is_error === true ? text.replace(/\s+/g, ' ').slice(0, 140) : null,
        });
      }
    }
  }
  return { calls, results };
}

/**
 * Calls that re-wrote more than half of the previous context into the cache, with the likely cause.
 * @param {ReturnType<typeof collectCalls>} calls
 */
function cacheRebuilds(calls) {
  const out = [];
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1];
    const c = calls[i];
    if (c.write < REBUILD_MIN_TOKENS || c.write < 0.5 * prev.ctx) continue;
    const gapS = (c.ts - prev.ts) / 1000;
    const ttlS = prev.w1h > 0 || c.w1h > 0 ? CACHE_TTL_1H_S : CACHE_TTL_5M_S;
    let cause = 'unknown (the cached prefix changed)';
    if (prev.model !== c.model) cause = `model switched ${prev.model} -> ${c.model}`;
    else if (gapS > ttlS) cause = `${Math.round(gapS / 60)} min since the previous call > cache TTL ${ttlS / 60} min`;
    // What the rewrite cost above reading the same prefix from the cache (read = 0.1x input,
    // write = 1.25x for 5 min or 2x for 1 hour).
    const extra = c.parts.write * (1 - 0.1 / (c.w1h ? 2 : 1.25));
    out.push({ callNo: i + 1, tokens: c.write, extraUsd: extra, cause });
  }
  return out;
}

/** Images returned by tool calls, and what carrying them through the later calls cost. */
function imageCost(calls, results) {
  let count = 0;
  let usdCarried = 0;
  for (const r of results) {
    if (!r.images) continue;
    count += r.images;
    usdCarried += carriedCost(calls, r.callIndex, r.images * IMAGE_TOKENS);
  }
  return { count, usdCarried };
}

/** Cost of writing `tokens` to the cache once and reading them on every later call. */
function carriedCost(calls, callIndex, tokens) {
  const at = calls[Math.max(0, callIndex)];
  if (!at) return 0;
  const t = readTokens(at.usage);
  const promptTokens = t.input + t.read + t.write5m + t.write1h;
  // Effective per-token rates of that call, taken from its own priced parts.
  const readRate = t.read > 0 ? at.parts.read / t.read : 0;
  const writeRate = t.write5m + t.write1h > 0 ? at.parts.write / (t.write5m + t.write1h) : readRate * 12.5;
  const later = Math.max(0, calls.length - callIndex - 1);
  return promptTokens > 0 ? tokens * writeRate + tokens * readRate * later : 0;
}

function toolMix(results) {
  const m = new Map();
  for (const r of results) m.set(r.name, (m.get(r.name) || 0) + 1);
  return (
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none'
  );
}

/** Absolute paths are machine-specific and would surface in the UI: keep the last two segments. */
function stripAbsPaths(s) {
  return String(s).replace(/(?:[A-Za-z]:|~)?[\\/][^\s"'`;|]*/g, (m) => {
    const segs = m.split(/[\\/]/).filter(Boolean);
    return segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : m;
  });
}

function shortTarget(input) {
  if (!input || typeof input !== 'object') return '';
  const p = input.file_path || input.path || input.notebook_path;
  if (p) return String(p).split(/[\\/]/).slice(-3).join('/');
  if (input.command) return stripAbsPaths(String(input.command).replace(/\s+/g, ' ')).slice(0, 90);
  if (input.url) return String(input.url).slice(0, 90);
  if (input.pattern) return `pattern ${String(input.pattern).slice(0, 60)}`;
  if (input.description) return String(input.description).slice(0, 80);
  if (input.skill) return String(input.skill);
  return '';
}

/**
 * The agent's brief. A workflow agent gets a harness preamble: either the computed task right
 * away, or first the relayed user request and the computed task in the next message — the task
 * is what the agent was told to do, so it wins.
 */
function agentBrief(entries) {
  const texts = entries
    .filter(
      (x) =>
        x &&
        x.type === 'user' &&
        x.message &&
        (typeof x.message.content === 'string' ||
          (Array.isArray(x.message.content) && x.message.content.some((b) => b && b.type === 'text'))),
    )
    .slice(0, 3)
    .map((x) => textOf(x.message.content));
  if (texts.length === 0) return '';
  const computed = texts.find((t) => t.includes(WORKFLOW_BRIEF_MARKER));
  let brief = computed ? computed.slice(computed.indexOf(WORKFLOW_BRIEF_MARKER) + WORKFLOW_BRIEF_MARKER.length) : texts[0];
  if (!computed && brief.startsWith(WORKFLOW_REQUEST_PREFIX)) {
    const at = brief.indexOf(WORKFLOW_REQUEST_END);
    brief = at >= 0 ? brief.slice(at + WORKFLOW_REQUEST_END.length) : brief;
  }
  return stripAbsPaths(brief.replace(/\s+/g, ' ').trim());
}

// ---------------------------------------------------------------------------
// Prompts with their cost
// ---------------------------------------------------------------------------

/**
 * The session's prompts in order, each with the cost of the calls up to the next one. A prompt
 * typed while the model was busy arrives as a `queued_command` attachment; a finished background
 * task and a compaction start automatic turns, kept apart so prompt numbers match what the user typed.
 * @param {Array<Record<string, *>>} entries
 * @param {ReturnType<typeof collectCalls>} calls
 * @param {{ isQualifyingUserEvent: Function, getPromptText: Function, isCommandMessagePrompt: Function }} helpers
 * @returns {Array<{ text: string, auto: boolean, isCommandMessage: boolean, skillName: string|null, calls: number, usd: number, ctxStart: number, ctxEnd: number }>}
 */
function buildPromptCosts(entries, calls, helpers) {
  const callByIdx = new Map(calls.map((c) => [c.idx, c]));
  const prompts = [];
  let current = null;
  const start = (text, auto, isCommandMessage) => {
    current = { text, auto, isCommandMessage, skillName: null, calls: 0, usd: 0, ctxStart: 0, ctxEnd: 0 };
    prompts.push(current);
  };
  entries.forEach((e, idx) => {
    if (!e) return;
    const raw = e.type === 'user' && !e.isMeta && e.message && typeof e.message.content === 'string' ? e.message.content.trimStart() : '';
    const queued = e.type === 'attachment' && e.attachment && e.attachment.type === 'queued_command' ? e.attachment : null;
    if (raw.startsWith('<task-notification>')) {
      start('(automatic turn: a background task finished)', true, false);
    } else if (e.type === 'user' && e.isCompactSummary) {
      start('(context compacted: the session continued from a summary)', true, false);
    } else if (queued && typeof queued.prompt === 'string') {
      if (!queued.origin || queued.origin.kind === 'human') {
        start(`${queued.prompt} (typed while the model was working)`, false, false);
      } else if (queued.prompt.trimStart().startsWith('<task-notification>')) {
        start('(automatic turn: a background task finished)', true, false);
      } else {
        start(`(automatic turn: ${queued.origin.kind}) ${queued.prompt.slice(0, 150)}`, true, false);
      }
    } else if (helpers.isQualifyingUserEvent(e)) {
      const text = helpers.getPromptText(e);
      if (!text.trimStart().startsWith('<local-command')) start(text, false, helpers.isCommandMessagePrompt(e));
    }
    if (!current) return;
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content) && current.skillName === null) {
      const skill = e.message.content.find((b) => b && b.type === 'tool_use' && b.name === 'Skill' && b.input && typeof b.input.skill === 'string');
      if (skill) current.skillName = skill.input.skill;
    }
    const c = callByIdx.get(idx);
    if (c) {
      if (current.calls === 0) current.ctxStart = c.ctx;
      current.calls++;
      current.usd += c.cost;
      current.ctxEnd = c.ctx;
    }
  });
  return prompts;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Every `agent-*.jsonl` under `<session>/subagents/`, workflow agents included. */
function listAgentFiles(transcriptPath) {
  const root = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const out = [];
  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else if (/^agent-.*\.jsonl$/.test(it.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

function readMeta(agentFile) {
  try {
    return JSON.parse(fs.readFileSync(agentFile.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

function analyseAgent(file, readEntries, pricer) {
  const entries = readEntries(file);
  const a = analyseTranscript(entries, pricer);
  const meta = readMeta(file);
  const rebuilds = cacheRebuilds(a.calls);
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  return {
    description: typeof meta.description === 'string' && meta.description ? meta.description : path.basename(file, '.jsonl'),
    type: /[\\/]workflows[\\/]/.test(file) ? 'workflow agent' : meta.agentType || 'subagent',
    running: meta.finished === false,
    model: [...new Set(a.calls.map((c) => c.model).filter(Boolean))].join(','),
    calls: a.calls.length,
    usd: sum(a.calls, (c) => c.cost),
    startupUsd: a.calls[0] ? a.calls[0].cost : 0,
    ctxStart: a.calls[0] ? a.calls[0].ctx : 0,
    ctxPeak: Math.max(0, ...a.calls.map((c) => c.ctx)),
    toolCalls: a.results.length,
    toolMix: toolMix(a.results),
    errors: a.results.filter((r) => r.isError).length,
    images: imageCost(a.calls, a.results),
    rebuildNote: rebuilds.length
      ? `${rebuilds.length} cache rebuild(s) +${usd(sum(rebuilds, (r) => r.extraUsd))} (${rebuilds[0].cause})`
      : '',
    brief: agentBrief(entries),
  };
}

// ---------------------------------------------------------------------------
// Evidence text
// ---------------------------------------------------------------------------

function usd(v) {
  return `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`;
}

function kt(v) {
  return `${Math.round(v / 1000)}k`;
}

/**
 * @param {{
 *   transcriptPath: string,
 *   entries: Array<Record<string, *>>,
 *   pricing: Record<string, *>|null,
 *   pickCallRates: Function,
 *   readEntries: (file: string) => Array<Record<string, *>>,
 *   helpers: { isQualifyingUserEvent: Function, getPromptText: Function, isCommandMessagePrompt: Function },
 * }} input
 * @returns {{ text: string, prompts: ReturnType<typeof buildPromptCosts>, totalUsd: number }}
 */
function buildAdvisorEvidence(input) {
  const pricer = makePricer(input.pricing, input.pickCallRates);
  const main = analyseTranscript(input.entries, pricer);
  const prompts = buildPromptCosts(input.entries, main.calls, input.helpers);
  const agents = listAgentFiles(input.transcriptPath)
    .map((f) => analyseAgent(f, input.readEntries, pricer))
    .filter((a) => a.calls > 0)
    .sort((x, y) => y.usd - x.usd);

  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const n = main.calls.length;
  const mainUsd = sum(main.calls, (c) => c.cost);
  const agentsUsd = sum(agents, (a) => a.usd);
  const total = mainUsd + agentsUsd;
  const parts = { read: 0, write: 0, output: 0, input: 0 };
  for (const c of main.calls) for (const k of Object.keys(parts)) parts[k] += c.parts[k];

  const L = [];
  L.push(
    pricer.usedListPrices()
      ? 'Cost structure (from the local transcripts; some models priced at list prices):'
      : 'Cost structure (from the local transcripts at the Log Hub model prices):',
  );
  L.push(`- Total ${usd(total)} = this session ${usd(mainUsd)} (${n} API calls) + ${agents.length} subagent/workflow agents ${usd(agentsUsd)}`);
  if (mainUsd > 0) {
    const pct = (v) => `${Math.round((100 * v) / mainUsd)}%`;
    L.push(
      `- This session by token kind: cache reads ${usd(parts.read)} (${pct(parts.read)}), cache writes ${usd(parts.write)} (${pct(parts.write)}), output ${usd(parts.output)} (${pct(parts.output)}), uncached input ${usd(parts.input)}`,
    );
  }
  if (n > 0) {
    const ctxs = main.calls.map((c) => c.ctx);
    const sorted = [...ctxs].sort((a, b) => a - b);
    const over = main.calls.filter((c) => c.ctx > LARGE_CONTEXT_TOKENS);
    L.push(
      `- Context per call: first ${kt(ctxs[0])}, median ${kt(sorted[Math.floor(n / 2)])}, peak ${kt(sorted[n - 1])}; ${over.length} calls ran above ${kt(LARGE_CONTEXT_TOKENS)} context and cost ${usd(sum(over, (c) => c.cost))}`,
    );
  }
  const running = agents.filter((a) => a.running).length;
  L.push(`- Status: figures are as of the end of the latest turn; the session may continue.${running ? ` ${running} agent(s) still running.` : ''}`);
  const mainImages = imageCost(main.calls, main.results);
  if (mainImages.count) {
    L.push(`- Images (screenshots, image files) returned into this session's context: ${mainImages.count}, ~${kt(mainImages.count * IMAGE_TOKENS)} tokens, cost of carrying them ${usd(mainImages.usdCarried)}`);
  }

  L.push('');
  L.push(
    'Subagents and workflow agents (most expensive first: description | type | model | API calls | cost (of which first call = startup context write) | context at start -> peak | tool calls by tool | notes), each followed by the start of its brief:',
  );
  if (agents.length === 0) L.push('(none)');
  for (const a of agents.slice(0, MAX_AGENT_LINES)) {
    const notes = [
      a.running ? 'STILL RUNNING' : '',
      a.errors ? `${a.errors} failed tool calls` : '',
      a.images.count ? `${a.images.count} images in context (~${usd(a.images.usdCarried)})` : '',
      a.rebuildNote,
    ]
      .filter(Boolean)
      .join('; ');
    L.push(`- "${a.description}" | ${a.type} | ${a.model || 'unknown'} | ${a.calls} | ${usd(a.usd)} (${usd(a.startupUsd)}) | ${kt(a.ctxStart)} -> ${kt(a.ctxPeak)} | ${a.toolMix} | ${notes || '-'}`);
    if (a.brief) L.push(`    brief: ${a.brief.slice(0, BRIEF_CHARS)}`);
  }
  if (agents.length > MAX_AGENT_LINES) {
    L.push(`- ...${agents.length - MAX_AGENT_LINES} more agents, ${usd(sum(agents.slice(MAX_AGENT_LINES), (a) => a.usd))} together`);
  }
  const small = agents.filter((a) => a.toolCalls <= SMALL_AGENT_MAX_TOOL_CALLS);
  if (small.length >= SMALL_AGENT_GROUP_MIN) {
    L.push(
      `- ${small.length} agents made ${SMALL_AGENT_MAX_TOOL_CALLS} or fewer tool calls each: ${usd(sum(small, (a) => a.usd))} together, of which ${usd(sum(small, (a) => a.startupUsd))} was writing their startup context. Examples: ${small
        .slice(0, 4)
        .map((a) => `"${a.description}" (${a.toolMix})`)
        .join(', ')}`,
    );
  }

  L.push('');
  L.push('Cache rebuilds in this session (a cache write of more than half the context after the first call):');
  const rebuilds = cacheRebuilds(main.calls);
  if (rebuilds.length === 0) L.push('(none)');
  for (const r of rebuilds.slice(0, 6)) L.push(`- API call #${r.callNo}: re-wrote ${kt(r.tokens)} tokens, extra ${usd(r.extraUsd)}; cause: ${r.cause}`);

  L.push('');
  L.push("Largest tool results kept in this session's context (tool | target | tokens | later API calls that re-read it | cost of carrying it):");
  const big = main.results
    .map((r) => {
      const tok = r.chars / CHARS_PER_TOKEN;
      return { ...r, tok, later: Math.max(0, n - r.callIndex - 1), carriedUsd: carriedCost(main.calls, r.callIndex, tok) };
    })
    .filter((r) => r.tok >= BIG_RESULT_MIN_TOKENS)
    .sort((a, b) => b.carriedUsd - a.carriedUsd)
    .slice(0, 6);
  if (big.length === 0) L.push(`(none above ${kt(BIG_RESULT_MIN_TOKENS)} tokens)`);
  for (const r of big) L.push(`- ${r.name} | ${shortTarget(r.input)} | ${kt(r.tok)} | ${r.later} | ${usd(r.carriedUsd)}`);

  L.push('');
  L.push('Files read repeatedly in this session (file | reads | total KB):');
  const reads = new Map();
  for (const r of main.results) {
    if (r.name !== 'Read' || !r.input || !r.input.file_path) continue;
    const key = String(r.input.file_path).replace(/\\/g, '/').toLowerCase();
    const v = reads.get(key) || { file: shortTarget(r.input), n: 0, chars: 0 };
    v.n++;
    v.chars += r.chars;
    reads.set(key, v);
  }
  const rereads = [...reads.values()]
    .filter((v) => v.n >= 3 || (v.n >= 2 && v.chars > 20000))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5);
  if (rereads.length === 0) L.push('(none)');
  for (const r of rereads) L.push(`- ${r.file} | ${r.n} | ${Math.round(r.chars / 1024)}`);

  L.push('');
  L.push('Failed tool calls in this session (tool | failures | first error):');
  const errByTool = new Map();
  for (const r of main.results.filter((x) => x.isError)) {
    const v = errByTool.get(r.name) || { n: 0, sample: r.errorHead || '' };
    v.n++;
    errByTool.set(r.name, v);
  }
  if (errByTool.size === 0) L.push('(none)');
  for (const [name, v] of [...errByTool.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6)) {
    L.push(`- ${name} | ${v.n} | ${stripAbsPaths(v.sample)}`);
  }

  return { text: L.join('\n'), prompts, totalUsd: total };
}

module.exports = {
  buildAdvisorEvidence,
  buildPromptCosts,
  cacheRebuilds,
  collectCalls,
  makePricer,
  stripAbsPaths,
  usd,
  kt,
};
