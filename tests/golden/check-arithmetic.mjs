#!/usr/bin/env node
// check-arithmetic.mjs — re-derives the golden numbers without the app (impl-plan DD D3).
//
// The `expected.json` files hold literals. This script recomputes them from first principles so a
// typo in a literal, or a fixture that drifted from its table, is caught before any stand runs:
//
//   - tokens per transcript, parsed straight from the fixture JSONL (assistant lines only,
//     `isSidechain` lines of a root transcript skipped — a sub-agent transcript is sidechain
//     throughout —, one count per `message.id`, a usage without a `cache_creation`
//     object counted as all-5m, `speed: "fast"` tokens and `web_search_requests` collected);
//   - cost per node from the DD D3 rates (per Mtok, $0.01 per web search, fast mode x2 on input and
//     output), priced by the transcript's first model, `null` for a model without a rate;
//   - own / tree totals, per-prompt costs, cache read ratios, delegation share, the "wrong" prices
//     GS-04 and GS-06a must be told apart from, GS-03's context table;
//   - change-surface concentration from the folder distribution (GS-09: from the transcript's paths),
//     with the formula of docs/knowledgebase/change-surface.md §2;
//   - every REPO-GOLD total in `repo-gold.expected.json`, including the merged work time per day.
//
// Usage: node tests/golden/check-arithmetic.mjs   (exit 0 all consistent, 1 on any mismatch)
// `check()` is exported for scripts/__tests__/golden-arithmetic.test.js (`npm run test:scripts`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GOLDEN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** DD D3: USD per million tokens. */
export const RATES = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
};
export const WEB_SEARCH_USD = 0.01;
export const FAST_MODE_MULTIPLIER = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `expected.json` stores ratios and money with at most six decimals. */
const TOL = 5e-7 + 1e-12;
/** Values the design states at display precision (4 decimals). */
const DISPLAY_TOL = 5e-5 + 1e-12;
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'inputFast', 'outputFast', 'webSearch'];

// ---------------------------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------------------------

export function emptyTokens() {
  return Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
}

export function addTokens(a, b) {
  const out = emptyTokens();
  for (const k of TOKEN_KEYS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

/** Cost of a token bundle at `model`'s rate; `null` when the model has no rate. */
export function costUsd(tokens, model, { fastMultiplier = FAST_MODE_MULTIPLIER, oneHourRate } = {}) {
  const r = RATES[model];
  if (!r) return null;
  const extra = fastMultiplier - 1;
  const perTok = (rate) => rate / 1e6;
  return (
    (tokens.input + tokens.inputFast * extra) * perTok(r.input) +
    (tokens.output + tokens.outputFast * extra) * perTok(r.output) +
    tokens.cacheRead * perTok(r.cacheRead) +
    tokens.cacheWrite5m * perTok(r.cacheWrite5m) +
    tokens.cacheWrite1h * perTok(oneHourRate === undefined ? r.cacheWrite1h : r[oneHourRate]) +
    tokens.webSearch * WEB_SEARCH_USD
  );
}

/** cacheRead / (cacheRead + cacheWrite); `null` at a zero denominator. */
export function cacheRatio(cacheRead, cacheWrite) {
  const denom = cacheRead + cacheWrite;
  return denom === 0 ? null : cacheRead / denom;
}

function tokensCacheRatio(t) {
  return cacheRatio(t.cacheRead, t.cacheWrite5m + t.cacheWrite1h);
}

/** Change-surface concentration (docs/knowledgebase/change-surface.md §2). `folders`: folder → file count. */
export function concentration(folders) {
  const entries = Object.entries(folders);
  const F = entries.reduce((s, [, n]) => s + n, 0);
  if (F === 0) return { score: null, band: null };
  const K = entries.length;
  let E = 1;
  if (K > 1) {
    const H = -entries.reduce((s, [, n]) => s + (n / F) * Math.log(n / F), 0);
    E = 1 - H / Math.log(K);
  }
  const S = Math.max(...entries.map(([, n]) => n)) / F;
  const segs = (f) => (f === '.' || f === '' ? [] : f.split('/'));
  const modules = new Set(entries.map(([f]) => (segs(f)[0] ?? '.')));
  const M = 1 / modules.size;
  let D = 1;
  if (K > 1) {
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < K; i++) {
      for (let j = i + 1; j < K; j++) {
        const u = segs(entries[i][0]);
        const v = segs(entries[j][0]);
        let c = 0;
        while (c < u.length && c < v.length && u[c] === v[c]) c++;
        const total = u.length + v.length;
        sum += total === 0 ? 0 : (u.length - c + (v.length - c)) / total;
        pairs++;
      }
    }
    D = 1 - sum / pairs;
  }
  const smallness = F <= 6 ? 1 - (F - 1) / 6 : 0;
  const closeness = smallness * D;
  const E2 = E + closeness * (1 - E);
  const S2 = S + closeness * (1 - S);
  let score = Math.min(100, Math.max(0, Math.round(100 * (0.4 * E2 + 0.25 * S2 + 0.2 * M + 0.15 * D))));
  if (F <= 5) score = Math.max(score, 60);
  const band = score >= 60 ? 'focused' : score >= 40 ? 'mixed' : 'scattered';
  return { score, band, modules: modules.size };
}

/** Union of `[start, end)` intervals cut at UTC day boundaries → minutes per `YYYY-MM-DD`. */
export function mergedMinutesByDay(intervals) {
  const byDay = new Map();
  for (const [s, e] of intervals) {
    for (let d = Math.floor(s / DAY_MS) * DAY_MS; d < e; d += DAY_MS) {
      const cs = Math.max(s, d);
      const ce = Math.min(e, d + DAY_MS);
      if (ce <= cs) continue;
      const key = new Date(d).toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push([cs, ce]);
    }
  }
  const out = {};
  for (const [day, list] of byDay) {
    list.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [cs, ce] = list[0];
    for (const [s, e] of list.slice(1)) {
      if (s > ce) {
        total += ce - cs;
        [cs, ce] = [s, e];
      } else ce = Math.max(ce, e);
    }
    total += ce - cs;
    out[day] = total / 60000;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fixture parsing
// ---------------------------------------------------------------------------------------------

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/**
 * Tokens and first model of one transcript, counted the way DD D3 defines them. A root transcript
 * skips `isSidechain` lines; a sub-agent's own transcript is marked sidechain on every line.
 */
export function transcriptTokens(lines, { skipSidechain = true } = {}) {
  const seen = new Set();
  const tokens = emptyTokens();
  let model = null;
  for (const line of lines) {
    if (line.type !== 'assistant' || (skipSidechain && line.isSidechain === true)) continue;
    const msg = line.message ?? {};
    if (msg.id) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    if (model === null && msg.model) model = msg.model;
    const u = msg.usage;
    if (!u) continue;
    const fast = u.speed === 'fast';
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    if (u.cache_creation && typeof u.cache_creation === 'object') {
      tokens.cacheWrite5m += u.cache_creation.ephemeral_5m_input_tokens ?? 0;
      tokens.cacheWrite1h += u.cache_creation.ephemeral_1h_input_tokens ?? 0;
    } else {
      tokens.cacheWrite5m += u.cache_creation_input_tokens ?? 0;
    }
    if (fast) {
      tokens.inputFast += u.input_tokens ?? 0;
      tokens.outputFast += u.output_tokens ?? 0;
    }
    tokens.webSearch += u.server_tool_use?.web_search_requests ?? 0;
  }
  return { tokens, model };
}

/** Repo-relative folders of every Edit/Write `file_path` under `repoRoot` (Windows or POSIX). */
function editedFolders(lines, repoRoot) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/^([a-z]):/i, (_m, d) => `${d.toLowerCase()}:`);
  const root = norm(repoRoot).replace(/\/+$/, '') + '/';
  const files = new Set();
  for (const line of lines) {
    if (line.type !== 'assistant' || line.isSidechain === true) continue;
    for (const block of line.message?.content ?? []) {
      if (block?.type !== 'tool_use' || !['Edit', 'Write', 'MultiEdit'].includes(block.name)) continue;
      const p = norm(String(block.input?.file_path ?? ''));
      if (p.startsWith(root)) files.add(p.slice(root.length));
    }
  }
  const folders = {};
  for (const f of files) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    folders[dir] = (folders[dir] ?? 0) + 1;
  }
  return folders;
}

export function listFixtures(dir = GOLDEN_DIR) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^gs-\d{2}-/.test(e.name))
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

/**
 * Runs every consistency check. Returns `{ checks, failures }`; each failure is
 * `{ where, actual, expected }`. Never throws on a mismatch.
 */
export function check({ dir = GOLDEN_DIR } = {}) {
  const failures = [];
  let checks = 0;
  const eq = (where, actual, expected, tol = TOL) => {
    checks++;
    const ok =
      typeof actual === 'number' && typeof expected === 'number'
        ? Math.abs(actual - expected) <= tol
        : JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures.push({ where, actual, expected });
  };
  const eqTokens = (where, actual, expected) => {
    for (const k of TOKEN_KEYS) eq(`${where}.${k}`, actual[k], expected?.[k] ?? 0);
  };

  const roots = [];
  for (const folder of listFixtures(dir)) {
    const fdir = path.join(dir, folder);
    const manifest = JSON.parse(fs.readFileSync(path.join(fdir, 'upload.json'), 'utf8'));
    const expectedFile = path.join(fdir, 'expected.json');
    if (!fs.existsSync(expectedFile)) {
      failures.push({ where: `${folder}/expected.json`, actual: 'missing', expected: 'present' });
      continue;
    }
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    eq(`${folder}.fixture`, expected.fixture, manifest.fixture);
    eq(`${folder}.roots`, expected.roots.map((r) => r.key), manifest.roots.map((r) => r.key));

    for (const root of manifest.roots) {
      const exp = expected.roots.find((r) => r.key === root.key);
      if (!exp) continue;
      const at = `${folder}/${root.key}`;
      const rootLines = readJsonl(path.join(fdir, root.claude));
      const artisyn = readJsonl(path.join(fdir, root.artisyn));
      const nodeFiles = [{ key: 'root', file: root.claude, parent: null }, ...root.subagents.map((s) => ({ key: s.key, file: s.file }))];

      // Tokens and cost per node, from the transcript.
      let own = null;
      let tree = emptyTokens();
      let treeCost = 0;
      let treePriced = true;
      for (const nf of nodeFiles) {
        const node = exp.nodes.find((n) => n.key === nf.key);
        if (!node) {
          failures.push({ where: `${at}.nodes`, actual: 'missing', expected: nf.key });
          continue;
        }
        const parsed =
          nf.key === 'root'
            ? transcriptTokens(rootLines)
            : transcriptTokens(readJsonl(path.join(fdir, nf.file)), { skipSidechain: false });
        eq(`${at}.nodes.${nf.key}.model`, parsed.model, node.model);
        eqTokens(`${at}.nodes.${nf.key}.tokens(parsed)`, parsed.tokens, node.tokens);
        const c = costUsd(node.tokens, node.model);
        eq(`${at}.nodes.${nf.key}.costUsd`, c, node.costUsd);
        if (c === null) treePriced = false;
        else treeCost += c;
        tree = addTokens(tree, node.tokens);
        if (nf.key === 'root') own = node.tokens;
      }
      eq(`${at}.nodes.count`, exp.nodes.length, nodeFiles.length);
      eqTokens(`${at}.tokens.own`, own, exp.tokens.own);
      eqTokens(`${at}.tokens.tree`, tree, exp.tokens.tree);
      eq(`${at}.costUsd`, treePriced ? treeCost : null, exp.costUsd);
      eq(`${at}.ownCostUsd`, costUsd(own, exp.model), exp.ownCostUsd);
      eq(`${at}.costUnavailableReason`, RATES[exp.model] ? null : 'unknown-model', exp.costUnavailableReason);
      eq(`${at}.cacheRatio.own`, tokensCacheRatio(own), exp.cacheRatio.own);
      eq(`${at}.cacheRatio.tree`, tokensCacheRatio(tree), exp.cacheRatio.tree);
      if (exp.delegationShare !== undefined) {
        eq(`${at}.delegationShare`, (exp.costUsd - exp.ownCostUsd) / exp.costUsd, exp.delegationShare);
      }

      // Times: the session spans the transcript; prompts and work time add up.
      const stamps = rootLines.map((l) => l.timestamp).filter(Boolean).sort();
      eq(`${at}.start`, stamps[0], exp.start);
      eq(`${at}.end`, stamps.at(-1), exp.end);
      eq(`${at}.durationMs`, Date.parse(exp.end) - Date.parse(exp.start), exp.durationMs);
      eq(`${at}.prompts(artisyn prompt_start)`, artisyn.filter((l) => l.event === 'prompt_start').length, exp.prompts);
      const artisynStamps = artisyn.map((l) => l.timestamp).filter(Boolean).sort();
      eq(`${at}.artisyn span = transcript span`, [artisynStamps[0], artisynStamps.at(-1)], [exp.start, exp.end]);
      if (exp.perPrompt) {
        eq(`${at}.perPrompt.workTimeMs sum`, exp.perPrompt.reduce((s, p) => s + p.workTimeMs, 0), exp.workTimeMs);
        if (exp.perPrompt.every((p) => p.tokens)) {
          eqTokens(`${at}.perPrompt.tokens sum`, exp.perPrompt.reduce((s, p) => addTokens(s, p.tokens), emptyTokens()), own);
          exp.perPrompt.forEach((p, i) => {
            eq(`${at}.perPrompt[${i}].costUsd`, costUsd(p.tokens, exp.model), p.costUsd);
            if (p.cacheRatio !== undefined) eq(`${at}.perPrompt[${i}].cacheRatio`, tokensCacheRatio(p.tokens), p.cacheRatio);
            if (p.costWithSubagentsUsd !== undefined) {
              const sub = p.subagents.reduce((s, k) => s + exp.nodes.find((n) => n.key === k).costUsd, 0);
              eq(`${at}.perPrompt[${i}].costWithSubagentsUsd`, p.costUsd + sub, p.costWithSubagentsUsd);
            }
          });
        }
      }
      if (exp.events) {
        eqTokens(`${at}.events.tokens sum`, exp.events.reduce((s, e) => addTokens(s, e.tokens), emptyTokens()), own);
        eq(`${at}.events.workTimeMs sum`, exp.events.reduce((s, e) => s + e.workTimeMs, 0), exp.workTimeMs);
      }
      if (exp.wrongCostsUsd) {
        const w = exp.wrongCostsUsd;
        if (w.oneHourAtFiveMinuteRate !== undefined) eq(`${at}.wrong.oneHourAtFiveMinuteRate`, costUsd(own, exp.model, { oneHourRate: 'cacheWrite5m' }), w.oneHourAtFiveMinuteRate);
        if (w.flatCacheWrite !== undefined) eq(`${at}.wrong.flatCacheWrite`, costUsd(own, exp.model, { oneHourRate: 'cacheWrite5m' }), w.flatCacheWrite);
        if (w.noFastSurcharge !== undefined) eq(`${at}.wrong.noFastSurcharge`, costUsd(own, exp.model, { fastMultiplier: 1 }), w.noFastSurcharge);
        if (w.pricedByOpus5 !== undefined) eq(`${at}.wrong.pricedByOpus5`, costUsd(own, 'claude-opus-5'), w.pricedByOpus5);
        if (w.pricedByAlphabeticallyFirstModel !== undefined) {
          const first = [...new Set(exp.events.map((e) => e.model))].sort()[0];
          eq(`${at}.wrong.pricedByAlphabeticallyFirstModel`, costUsd(own, first), w.pricedByAlphabeticallyFirstModel);
        }
      }
      if (exp.turns) {
        exp.turns.forEach((t) => eq(`${at}.turns[${t.turn}].context`, t.input + t.cacheRead + t.cacheWrite, t.context));
        eq(`${at}.turns.cacheRead sum`, exp.turns.reduce((s, t) => s + t.cacheRead, 0), own.cacheRead);
        eq(`${at}.turns.cacheWrite sum`, exp.turns.reduce((s, t) => s + t.cacheWrite, 0), own.cacheWrite5m + own.cacheWrite1h);
        eq(`${at}.turns.input sum`, exp.turns.reduce((s, t) => s + t.input, 0), own.input);
        eq(`${at}.peakContext`, Math.max(...exp.turns.map((t) => t.context)), exp.peakContext);
        eq(`${at}.turnsNearCeiling`, exp.turns.filter((t) => t.context >= 0.8 * exp.contextWindow).length, exp.turnsNearCeiling);
        const causes = exp.cacheCreationCauses;
        for (const [k, v] of Object.entries(causes)) {
          eq(`${at}.cacheCreationCauses.${k} sum`, v.compaction + v.fileReread + v.unattributed, own.cacheWrite5m + own.cacheWrite1h);
        }
      }

      // Lines, tools, change surface.
      const subLines = exp.nodes.filter((n) => n.lines).map((n) => n.lines);
      if (subLines.length > 0) {
        eq(`${at}.lines.written = own + nodes`, exp.lines.writtenOwn + subLines.reduce((s, l) => s + l.written, 0), exp.lines.written);
        eq(`${at}.lines.added = nodes`, subLines.reduce((s, l) => s + l.added, 0), exp.lines.added);
        eq(`${at}.lines.removed = nodes`, subLines.reduce((s, l) => s + l.removed, 0), exp.lines.removed);
        eq(`${at}.lines.editWriteCalls = nodes`, subLines.reduce((s, l) => s + l.editWriteCalls, 0), exp.lines.editWriteCalls);
      }
      if (exp.edits) {
        eq(`${at}.edits.written sum`, exp.edits.reduce((s, e) => s + e.written, 0), exp.lines.written);
        eq(`${at}.edits.added sum`, exp.edits.reduce((s, e) => s + e.added, 0), exp.lines.added);
        eq(`${at}.edits.removed sum`, exp.edits.reduce((s, e) => s + e.removed, 0), exp.lines.removed);
        eq(`${at}.edits.count`, exp.edits.length, exp.lines.editWriteCalls);
        const outside = exp.edits.filter((e) => e.outsideRepo);
        eq(`${at}.changeSurface.linesAdded (in repo)`, exp.lines.added - outside.reduce((s, e) => s + e.added, 0), exp.changeSurface.linesAdded);
        eq(`${at}.changeSurface.outsideRepoFiles`, outside.length, exp.changeSurface.outsideRepoFiles);
      }
      for (const [tool, t] of Object.entries(exp.tools ?? {})) {
        eq(`${at}.tools.${tool}.calls`, t.successes + t.failures + t.unresolved, t.calls);
        if (t.failureRate !== undefined) {
          eq(`${at}.tools.${tool}.failureRate`, t.successes + t.failures === 0 ? 0 : t.failures / (t.successes + t.failures), t.failureRate);
        }
      }
      if (exp.costPerLineUsd !== undefined) eq(`${at}.costPerLineUsd`, exp.costUsd / exp.lines.written, exp.costPerLineUsd, DISPLAY_TOL);
      if (exp.linesPerAutonomousHour !== undefined) {
        eq(`${at}.linesPerAutonomousHour`, (exp.lines.written * 3600000) / exp.workTimeMs, exp.linesPerAutonomousHour);
      }
      const cs = exp.changeSurface;
      let folders = cs.folders;
      if (!folders) {
        const gitRoot = artisyn.find((l) => l.git?.root)?.git.root;
        folders = editedFolders(rootLines, gitRoot);
      }
      const conc = concentration(folders);
      eq(`${at}.changeSurface.changedFiles`, Object.values(folders).reduce((s, n) => s + n, 0), cs.changedFiles);
      eq(`${at}.changeSurface.foldersTouched`, Object.keys(folders).length, cs.foldersTouched);
      eq(`${at}.changeSurface.singleFileFolders`, Object.values(folders).filter((n) => n === 1).length, cs.singleFileFolders);
      eq(`${at}.changeSurface.topLevelModules`, conc.score === null ? 0 : conc.modules, cs.topLevelModules);
      eq(`${at}.changeSurface.concentration`, conc.score, cs.concentration);
      eq(`${at}.changeSurface.band`, conc.band, cs.band);

      roots.push({ ...exp, own, tree, subNodes: exp.nodes.length - 1 });
    }
  }

  // REPO-GOLD totals.
  const repoFile = path.join(dir, 'repo-gold.expected.json');
  if (!fs.existsSync(repoFile)) {
    failures.push({ where: 'repo-gold.expected.json', actual: 'missing', expected: 'present' });
    return { checks, failures };
  }
  const repo = JSON.parse(fs.readFileSync(repoFile, 'utf8'));
  const priced = roots.filter((r) => r.costUsd !== null);
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
  const group = (list, keyOf) => {
    const m = {};
    for (const r of list) (m[keyOf(r)] ??= []).push(r);
    return m;
  };

  eq('repo.rootSessions', roots.length, repo.rootSessions);
  eq('repo.sessionsWithDescendants', roots.length + sum(roots, (r) => r.subNodes), repo.sessionsWithDescendants);
  eq('repo.costUsd', sum(priced, (r) => r.costUsd), repo.costUsd);
  const byBranch = group(roots, (r) => r.branch);
  for (const [b, list] of Object.entries(byBranch)) {
    eq(`repo.costByBranch.${b}`, sum(list.filter((r) => r.costUsd !== null), (r) => r.costUsd), repo.costByBranch[b]);
    eq(`repo.sessionsByBranch.${b}`, list.length, repo.sessionsByBranch[b]);
    eq(`repo.workTimeMsByBranch.${b}`, sum(list, (r) => r.workTimeMs), repo.workTimeMsByBranch[b]);
    eq(`repo.linesWrittenByBranch.${b}`, sum(list, (r) => r.lines.written), repo.linesWrittenByBranch[b]);
  }
  eq('repo.costByBranch keys', Object.keys(byBranch).sort(), Object.keys(repo.costByBranch).sort());
  const byWeek = group(roots, (r) => r.week);
  for (const [w, list] of Object.entries(byWeek)) {
    eq(`repo.costByWeek.${w}`, sum(list.filter((r) => r.costUsd !== null), (r) => r.costUsd), repo.costByWeek[w]);
    eq(`repo.sessionsByWeek.${w}`, list.length, repo.sessionsByWeek[w]);
  }
  for (const r of roots) {
    const weekOf = Math.floor((Date.parse(r.start) - Date.parse(repo.range.start)) / (7 * DAY_MS)) + 1;
    eq(`${r.key}.week`, `W${weekOf}`, r.week);
  }
  for (const [model, list] of Object.entries(group(roots, (r) => r.model))) {
    const exp = repo.costByRootModel[model];
    eq(`repo.costByRootModel.${model}.sessions`, list.length, exp?.sessions);
    eq(`repo.costByRootModel.${model}.costUsd`, RATES[model] ? sum(list, (r) => r.costUsd) : null, exp?.costUsd);
  }
  eq('repo.excludedSessionCount', roots.length - priced.length, repo.excludedSessionCount);
  eq('repo.excludedModels', [...new Set(roots.filter((r) => r.costUsd === null).map((r) => r.model))].sort(), [...repo.excludedModels].sort());
  const top = [...priced].sort((a, b) => b.costUsd - a.costUsd).slice(0, repo.topSessionsByCost.length);
  eq('repo.topSessionsByCost', top.map((r) => ({ key: r.key, costUsd: r.costUsd })), repo.topSessionsByCost);

  const treeTotal = roots.reduce((s, r) => addTokens(s, r.tree), emptyTokens());
  const ownTotal = roots.reduce((s, r) => addTokens(s, r.own), emptyTokens());
  for (const [label, t, e] of [['tree', treeTotal, repo.tokens.tree], ['root', ownTotal, repo.tokens.root]]) {
    for (const k of Object.keys(e)) {
      const actual = k === 'cacheWrite' ? t.cacheWrite5m + t.cacheWrite1h : t[k];
      eq(`repo.tokens.${label}.${k}`, actual, e[k]);
    }
  }
  eq('repo.cacheRatio.root', tokensCacheRatio(ownTotal), repo.cacheRatio.root);
  eq('repo.cacheRatio.withDescendants', tokensCacheRatio(treeTotal), repo.cacheRatio.withDescendants);
  const defined = roots.map((r) => tokensCacheRatio(r.own)).filter((x) => x !== null);
  eq('repo.cacheRatio.meanOfSessionRatiosTrap', sum(defined, (x) => x) / defined.length, repo.cacheRatio.meanOfSessionRatiosTrap);
  eq('repo.undefinedRatioSessions', roots.length - defined.length, repo.undefinedRatioSessions);
  const gs03 = roots.find((r) => r.cacheCreationCauses);
  const causes = repo.cacheCreationCausesRootThreshold25000;
  eq('repo.causes.compaction', gs03.cacheCreationCauses.threshold25000.compaction, causes.compaction);
  eq('repo.causes.fileReread', gs03.cacheCreationCauses.threshold25000.fileReread, causes.fileReread);
  eq('repo.causes sum', causes.compaction + causes.fileReread + causes.unattributed, ownTotal.cacheWrite5m + ownTotal.cacheWrite1h);

  eq('repo.workTimeMs', sum(roots, (r) => r.workTimeMs), repo.workTimeMs);
  eq('repo.avgSessionLengthMs', sum(roots, (r) => r.workTimeMs) / roots.length, repo.avgSessionLengthMs);
  // The work-time report: each root works on [start, start + workTime] (clamped to its end),
  // overlapping intervals merge, every day of the range is present.
  const minutes = mergedMinutesByDay(
    roots.map((r) => [Date.parse(r.start), Math.min(Date.parse(r.start) + r.workTimeMs, Date.parse(r.end))]),
  );
  const days = [];
  for (let d = Date.parse(repo.range.start); d <= Date.parse(repo.range.end); d += DAY_MS) days.push(new Date(d).toISOString().slice(0, 10));
  eq('repo.workTimeMinutesByDay days', Object.keys(repo.workTimeMinutesByDay), days);
  for (const day of days) eq(`repo.workTimeMinutesByDay.${day}`, minutes[day] ?? 0, repo.workTimeMinutesByDay[day]);

  eq('repo.lines.written', sum(roots, (r) => r.lines.written), repo.lines.written);
  eq('repo.lines.added', sum(roots, (r) => r.lines.added), repo.lines.added);
  eq('repo.lines.removed', sum(roots, (r) => r.lines.removed), repo.lines.removed);
  eq('repo.lines.editWriteCalls', sum(roots, (r) => r.lines.editWriteCalls), repo.lines.editWriteCalls);
  eq('repo.commits', sum(roots, (r) => r.commits), repo.commits);
  eq('repo.pullRequests', sum(roots, (r) => r.pullRequests), repo.pullRequests);
  const tools = {};
  for (const r of roots) {
    for (const [name, t] of Object.entries(r.tools ?? {})) {
      const acc = (tools[name] ??= { calls: 0, successes: 0, failures: 0, unresolved: 0 });
      for (const k of Object.keys(acc)) acc[k] += t[k];
    }
  }
  eq('repo.tools keys', Object.keys(tools).sort(), Object.keys(repo.tools).sort());
  for (const [name, t] of Object.entries(tools)) {
    for (const k of ['calls', 'successes', 'failures', 'unresolved']) eq(`repo.tools.${name}.${k}`, t[k], repo.tools[name]?.[k]);
    eq(`repo.tools.${name}.failureRate`, t.successes + t.failures === 0 ? 0 : t.failures / (t.successes + t.failures), repo.tools[name]?.failureRate);
  }
  eq('repo.toolCalls', sum(Object.values(tools), (t) => t.calls), repo.toolCalls);
  eq('repo.avgCostPerSessionUsd', sum(priced, (r) => r.costUsd) / roots.length, repo.avgCostPerSessionUsd);
  eq('repo.avgCostPerLineUsd', sum(priced, (r) => r.costUsd) / repo.lines.written, repo.avgCostPerLineUsd);
  eq('repo.avgLinesPerHour', (repo.lines.written * 3600000) / repo.workTimeMs, repo.avgLinesPerHour);

  return { checks, failures };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { checks, failures } = check();
  for (const f of failures) {
    console.error(`MISMATCH ${f.where}: computed ${JSON.stringify(f.actual)}, expected.json has ${JSON.stringify(f.expected)}`);
  }
  console.log(`golden arithmetic: ${checks} checks, ${failures.length} mismatches`);
  process.exit(failures.length === 0 ? 0 : 1);
}
