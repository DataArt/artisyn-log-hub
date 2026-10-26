import { MIN_PARSED_MODELS } from './model-pricing.constants';
import {
  isValidRate,
  normalizeTiers,
  round6,
  validatePricingTiers,
} from './model-pricing-rates';
import type { ModelPricingRates, PricingTier } from './model-pricing.types';

/**
 * Pure parser of the Anthropic pricing page's markdown rendering.
 *
 * Reads the first markdown table after the `## Model pricing` heading, locating columns by
 * header text, and the page's first "$N per 1,000 searches" / "$N USD per 1,000 searches"
 * web-search price.
 *
 * Prompt-length tiers: a model listed as a `(for prompts up to N tokens)` /
 * `(for prompts over N tokens)` row pair becomes one model. The first plain or `up to N` row
 * gives the base rates; each `over N` row adds a tier `{ aboveTokens: N, … }`. Untiered models
 * get `tiers: null`.
 *
 * Returns null — so the whole fetch fails and writes nothing — when the layout no longer
 * matches: a missing heading/table/column, fewer than {@link MIN_PARSED_MODELS} merged models,
 * no web-search price, any price that is not finite, negative or above `MAX_RATE`, an `over`
 * row with no base row, an `over N` row paired with an `up to M` row (M ≠ N), a duplicated
 * `over` threshold, or tiers failing `validatePricingTiers`.
 *
 * `charsPerToken` / `contextLength` are not on the page and are always null here; the fetch
 * service carries them forward from the model's current row.
 */
export function parseAnthropicPricing(
  markdown: string,
): Map<string, ModelPricingRates> | null {
  const lines = markdown.split(/\r?\n/);
  const headingIdx = lines.findIndex((l) =>
    /^##\s+Model pricing\s*$/i.test(l.trim()),
  );
  if (headingIdx < 0) return null;

  const table = readFirstTable(lines, headingIdx + 1);
  if (!table) return null;

  const header = table.header.map((h) => h.toLowerCase());
  const col = (needle: string): number =>
    header.findIndex((h) => h.includes(needle));
  const cols = {
    model: col('model'),
    priceIn: col('base input'),
    priceCacheW5m: col('5m cache write'),
    priceCacheW1h: col('1h cache write'),
    priceCacheR: col('cache hits'),
    priceOut: col('output'),
  };
  if (Object.values(cols).some((i) => i < 0)) return null;

  const webSearch = parseWebSearchPrice(markdown);
  if (webSearch === null) return null;

  // Rows merged per model id, in first-seen order.
  const merged = new Map<string, MergedModel>();
  for (const row of table.rows) {
    const parsedId = toModelId(row[cols.model] ?? '');
    if (!parsedId) continue;
    const { id, bound } = parsedId;
    let model = merged.get(id);
    if (!model) {
      model = { base: null, upToTokens: null, tiers: [] };
      merged.set(id, model);
    }
    const isTier = bound?.kind === 'over';
    // First base row wins; a later plain/upTo row for the same model is skipped unread.
    if (!isTier && model.base) continue;

    const rates = parseRowRates(row, cols);
    if (!rates) return null;

    if (isTier) {
      if (model.tiers.some((t) => t.aboveTokens === bound.tokens)) return null;
      model.tiers.push({ aboveTokens: bound.tokens, ...rates });
    } else {
      model.base = rates;
      model.upToTokens = bound?.kind === 'upTo' ? bound.tokens : null;
    }
  }

  const result = new Map<string, ModelPricingRates>();
  for (const [id, model] of merged) {
    if (!model.base) {
      if (model.tiers.length > 0) return null; // an `over` row with no base row
      continue;
    }
    const upTo = model.upToTokens;
    if (upTo !== null && model.tiers.some((t) => t.aboveTokens !== upTo)) {
      return null; // `over N` paired with `up to M`, M ≠ N
    }
    const sorted = [...model.tiers].sort(
      (a, b) => a.aboveTokens - b.aboveTokens,
    );
    if (validatePricingTiers(sorted) !== null) return null;
    result.set(id, {
      ...model.base,
      priceWebSearch: webSearch,
      charsPerToken: null,
      contextLength: null,
      tiers: normalizeTiers(sorted),
    });
  }

  return result.size >= MIN_PARSED_MODELS ? result : null;
}

/** The five per-token rates of one table row (USD/MTok). */
type RowRates = Omit<PricingTier, 'aboveTokens'>;

/** Accumulated rows of one model id while merging (DD13). */
interface MergedModel {
  /** Rates of the first plain or `up to N` row; null until one is seen. */
  base: RowRates | null;
  /** N of the base row's `(for prompts up to N tokens)`, or null for a plain row. */
  upToTokens: number | null;
  /** One tier per `(for prompts over N tokens)` row, in page order. */
  tiers: PricingTier[];
}

type RateColumns = Record<keyof RowRates, number>;

/** The row's five rates; null when any is missing or not a valid rate. */
function parseRowRates(row: string[], cols: RateColumns): RowRates | null {
  const priceIn = parsePrice(row[cols.priceIn]);
  const priceOut = parsePrice(row[cols.priceOut]);
  const priceCacheR = parsePrice(row[cols.priceCacheR]);
  const priceCacheW5m = parsePrice(row[cols.priceCacheW5m]);
  const priceCacheW1h = parsePrice(row[cols.priceCacheW1h]);
  if (
    priceIn === null ||
    priceOut === null ||
    priceCacheR === null ||
    priceCacheW5m === null ||
    priceCacheW1h === null
  )
    return null;
  return { priceIn, priceOut, priceCacheR, priceCacheW5m, priceCacheW1h };
}

interface MarkdownTable {
  header: string[];
  rows: string[][];
}

/**
 * Finds the first pipe table starting at or after `from`, stopping (null) at the next `#`
 * heading. A table is a header row, a `---` separator row and the body rows that follow.
 */
function readFirstTable(lines: string[], from: number): MarkdownTable | null {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) return null;
    if (!line.startsWith('|')) continue;

    const separator = lines[i + 1]?.trim() ?? '';
    if (!/^\|[\s:|-]+\|?$/.test(separator) || !separator.includes('-'))
      return null;

    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const rowLine = lines[j].trim();
      if (!rowLine.startsWith('|')) break;
      rows.push(splitRow(rowLine));
    }
    return { header: splitRow(line), rows };
  }
  return null;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const MODEL_NAME_RE =
  /^Claude (Opus|Sonnet|Haiku|Fable|Mythos) (\d+)(?:\.(\d+))?$/;

/** Trailing `(for prompts up to N tokens)` / `(for prompts over N tokens)`; commas in N allowed. */
const PROMPT_BOUND_RE =
  /\s*\(\s*for\s+prompts\s+(up\s+to|over)\s+([\d,]+)\s+tokens\s*\)\s*$/i;

/** A model row's prompt-length bound, from its trailing `(for prompts …)` parenthetical. */
interface PromptBound {
  kind: 'upTo' | 'over';
  tokens: number;
}

/**
 * Maps a model cell to `{ id, bound }`, or null when it is not a recognised Claude model.
 * Links and `<sup>` notes are stripped first; then a trailing `(for prompts up to/over N tokens)`
 * is read into `bound` (null when absent), and any other trailing parenthetical is dropped.
 * Major ≥ 4: `claude-<family>-<major>[-<minor>]`; major < 4: `claude-<major>[-<minor>]-<family>`.
 */
function toModelId(
  cell: string,
): { id: string; bound: PromptBound | null } | null {
  let name = cell
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<sup>.*?<\/sup>/gi, '')
    .trim();
  let bound: PromptBound | null = null;
  const boundMatch = PROMPT_BOUND_RE.exec(name);
  if (boundMatch) {
    const tokens = Number(boundMatch[2].replace(/,/g, ''));
    if (!Number.isSafeInteger(tokens)) return null;
    bound = {
      kind: /^over$/i.test(boundMatch[1]) ? 'over' : 'upTo',
      tokens,
    };
    name = name.slice(0, boundMatch.index);
  }
  name = name
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = MODEL_NAME_RE.exec(name);
  if (!match) return null;
  const family = match[1].toLowerCase();
  const major = Number(match[2]);
  const version = match[3] !== undefined ? `${match[2]}-${match[3]}` : match[2];
  const id =
    major >= 4 ? `claude-${family}-${version}` : `claude-${version}-${family}`;
  return { id, bound };
}

/** `$N` amount; a minus sign before or right after the `$` marks it negative (and so invalid). */
const PRICE_RE = /(-?)\s*\$\s*(-?)([\d,]*\.?\d+)/;

/** The cell's first `$N` amount, rounded to 6 decimals; null when absent or not a valid rate. */
function parsePrice(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const match = PRICE_RE.exec(cell);
  if (!match) return null;
  const magnitude = Number(match[3].replace(/,/g, ''));
  const value = match[1] || match[2] ? -magnitude : magnitude;
  return isValidRate(value) ? round6(value) : null;
}

/**
 * USD per web-search request: the first "$N per 1,000 searches" (or the current wording
 * "$N USD per 1,000 searches") on the page, divided by 1000.
 */
function parseWebSearchPrice(markdown: string): number | null {
  const match = /\$([\d,]*\.?\d+)(?:\s+USD)? per 1,000 searches/.exec(markdown);
  if (!match) return null;
  const perRequest = Number(match[1].replace(/,/g, '')) / 1000;
  return isValidRate(perRequest) ? round6(perRequest) : null;
}
