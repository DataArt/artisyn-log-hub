// Example dataset for the Log Hub site and deck (site/data/example-dataset.json, impl-plan DD-21).
// Algorithm doc: docs/knowledgebase/algorithms/site-example-dataset.md (`site-example-dataset`).
//
// Pure: no I/O, no top-level `await` (the CJS table test loads it with a dynamic import).
// ESM because its only caller, scripts/site/build-site.mjs, is ESM (unified/remark are ESM-only).
//
//   checkDataset(ds)          -> string[]   every arithmetic inconsistency, [] when consistent
//   fillPlaceholders(text, ds) -> string    replaces {{ds:<dot.path>[|usd|usd0|pct]}}; throws
//                                           `unknown dataset key: <path>` / `unknown format: <f>`

const EPS = 0.005;
const PLACEHOLDER_RE = /\{\{ds:([^}|]+)(?:\|([^}]*))?\}\}/g;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function get(ds, dotPath) {
  let cur = ds;
  for (const key of dotPath.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) {
      return undefined;
    }
    cur = cur[key];
  }
  return cur;
}

/** Groups the integer digits with commas: 1560000 -> "1,560,000". */
function groupInt(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fixed(n, decimals) {
  const sign = n < 0 ? '-' : '';
  const [int, frac] = Math.abs(n).toFixed(decimals).split('.');
  return sign + groupInt(int) + (frac === undefined ? '' : `.${frac}`);
}

function money(n, decimals) {
  const s = fixed(n, decimals);
  return s.startsWith('-') ? `-$${s.slice(1)}` : `$${s}`;
}

function fmt2(n) {
  return isNum(n) ? n.toFixed(2) : String(n);
}

export function checkDataset(ds) {
  const errors = [];
  const total = get(ds, 'session.total');
  const parts = get(ds, 'session.parts');
  const tokens = get(ds, 'session.tokens');
  const pct = get(ds, 'session.contextRereadPct');
  const dailySessions = get(ds, 'daily.sessions');
  const dailyTotal = get(ds, 'daily.total');
  const monthlyTotal = get(ds, 'monthly.total');
  const workingDays = get(ds, 'team.workingDays');

  if (!isNum(total)) errors.push('session.total is not a number');
  if (parts === null || typeof parts !== 'object' || !Object.values(parts).every(isNum)) {
    errors.push('session.parts must be an object of numbers');
  } else if (isNum(total)) {
    const sum = Object.values(parts).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - total) > EPS) {
      errors.push(`session.parts sum ${fmt2(sum)} != session.total ${fmt2(total)}`);
    }
  }

  if (!isNum(dailySessions) || !isNum(dailyTotal)) {
    errors.push('daily.sessions and daily.total must be numbers');
  } else if (isNum(total) && Math.abs(dailyTotal - dailySessions * total) > EPS) {
    errors.push(`daily.total ${fmt2(dailyTotal)} != daily.sessions × session.total ${fmt2(dailySessions * total)}`);
  }

  if (!isNum(monthlyTotal) || !isNum(workingDays)) {
    errors.push('monthly.total and team.workingDays must be numbers');
  } else if (isNum(dailyTotal) && Math.abs(monthlyTotal - workingDays * dailyTotal) > EPS) {
    errors.push(`monthly.total ${fmt2(monthlyTotal)} != team.workingDays × daily.total ${fmt2(workingDays * dailyTotal)}`);
  }

  if (tokens === null || typeof tokens !== 'object' || !Object.values(tokens).every(isNum) ||
      !isNum(get(ds, 'session.tokens.cacheRead'))) {
    errors.push('session.tokens must be an object of numbers with cacheRead');
  } else if (!isNum(pct)) {
    errors.push('session.contextRereadPct is not a number');
  } else {
    const sum = Object.values(tokens).reduce((a, b) => a + b, 0);
    const expected = sum === 0 ? 0 : Math.round((100 * tokens.cacheRead) / sum);
    if (pct !== expected) {
      errors.push(`session.contextRereadPct ${pct} != round(100 × cacheRead / Σ tokens) ${expected}`);
    }
  }

  const insight = get(ds, 'insight');
  if (insight !== undefined) checkInsight(ds, insight, errors);
  return errors;
}

// Optional `insight` block (Home "what to do about it" figure): rules 5-8 of the algorithm doc.
function checkInsight(ds, insight, errors) {
  const fields = ['turns', 'systemContextTokens', 'unusedContextTokens', 'unusedContextPct',
    'subAgentsPct', 'trimPerSession', 'trimMonthly'];
  if (insight === null || typeof insight !== 'object' || !fields.every((f) => isNum(insight[f]))) {
    errors.push(`insight must have numbers ${fields.join(', ')}`);
    return;
  }
  const total = get(ds, 'session.total');
  const subAgents = get(ds, 'session.parts.subAgents');
  const cacheReadCost = get(ds, 'session.parts.cacheRead');
  const cacheReadTokens = get(ds, 'session.tokens.cacheRead');
  const dailySessions = get(ds, 'daily.sessions');
  const workingDays = get(ds, 'team.workingDays');

  const unusedPct = insight.systemContextTokens === 0 ? 0
    : Math.round((100 * insight.unusedContextTokens) / insight.systemContextTokens);
  if (insight.unusedContextPct !== unusedPct) {
    errors.push(`insight.unusedContextPct ${insight.unusedContextPct} != round(100 × unusedContextTokens / systemContextTokens) ${unusedPct}`);
  }
  if (isNum(total) && total !== 0 && isNum(subAgents)) {
    const share = Math.round((100 * subAgents) / total);
    if (insight.subAgentsPct !== share) {
      errors.push(`insight.subAgentsPct ${insight.subAgentsPct} != round(100 × parts.subAgents / session.total) ${share}`);
    }
  }
  if (isNum(cacheReadCost) && isNum(cacheReadTokens) && cacheReadTokens !== 0) {
    const trim = (insight.unusedContextTokens * insight.turns * cacheReadCost) / cacheReadTokens;
    if (Math.abs(insight.trimPerSession - trim) > EPS) {
      errors.push(`insight.trimPerSession ${fmt2(insight.trimPerSession)} != unusedContextTokens × turns × cache-read price ${fmt2(trim)}`);
    }
  }
  if (isNum(dailySessions) && isNum(workingDays)) {
    const monthly = Math.round(insight.trimPerSession * dailySessions * workingDays);
    if (insight.trimMonthly !== monthly) {
      errors.push(`insight.trimMonthly ${insight.trimMonthly} != round(trimPerSession × daily.sessions × team.workingDays) ${monthly}`);
    }
  }
}

function formatValue(value, format, dotPath) {
  if (format === undefined) {
    if (isNum(value)) return Number.isInteger(value) ? groupInt(String(value)) : String(value);
    if (typeof value === 'string') return value;
    throw new Error(`unknown dataset key: ${dotPath}`);
  }
  if (!isNum(value)) {
    if (value === undefined || (value !== null && typeof value === 'object')) {
      throw new Error(`unknown dataset key: ${dotPath}`);
    }
    throw new Error(`dataset key ${dotPath} is not a number`);
  }
  switch (format) {
    case 'usd': return money(value, 2);
    case 'usd0': return money(value, 0);
    case 'pct': return `${fixed(value, 0)}%`;
    default: throw new Error(`unknown format: ${format}`);
  }
}

export function fillPlaceholders(text, ds) {
  return text.replace(PLACEHOLDER_RE, (_m, rawPath, rawFormat) => {
    const dotPath = rawPath.trim();
    const format = rawFormat === undefined ? undefined : rawFormat.trim();
    const value = get(ds, dotPath);
    if (value === undefined) throw new Error(`unknown dataset key: ${dotPath}`);
    return formatValue(value, format, dotPath);
  });
}
