import { MAX_RATE, MIN_PARSED_MODELS } from './model-pricing.constants';
import { round6 } from './model-pricing-rates';
import type { ModelPricingRates } from './model-pricing.types';

/**
 * Pure parser of the Anthropic pricing page's markdown rendering.
 *
 * Reads the first markdown table after the `## Model pricing` heading, locating columns by
 * header text, and the page's first "$N per 1,000 searches" web-search price. Returns null —
 * so the whole fetch fails and writes nothing — when the layout no longer matches: a missing
 * heading/table/column, fewer than {@link MIN_PARSED_MODELS} models, no web-search price, or
 * any price that is not finite, negative or above {@link MAX_RATE}.
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

  const result = new Map<string, ModelPricingRates>();
  for (const row of table.rows) {
    const modelId = toModelId(row[cols.model] ?? '');
    if (!modelId || result.has(modelId)) continue;

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

    result.set(modelId, {
      priceIn,
      priceOut,
      priceCacheR,
      priceCacheW5m,
      priceCacheW1h,
      priceWebSearch: webSearch,
      charsPerToken: null,
      contextLength: null,
    });
  }

  return result.size >= MIN_PARSED_MODELS ? result : null;
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

/**
 * Maps a model cell to a model id, or null when it is not a recognised Claude model.
 * Links, `<sup>` notes and a trailing parenthetical are stripped first.
 * Major ≥ 4: `claude-<family>-<major>[-<minor>]`; major < 4: `claude-<major>[-<minor>]-<family>`.
 */
function toModelId(cell: string): string | null {
  const name = cell
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<sup>.*?<\/sup>/gi, '')
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = MODEL_NAME_RE.exec(name);
  if (!match) return null;
  const family = match[1].toLowerCase();
  const major = Number(match[2]);
  const version = match[3] !== undefined ? `${match[2]}-${match[3]}` : match[2];
  return major >= 4
    ? `claude-${family}-${version}`
    : `claude-${version}-${family}`;
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

function isValidRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_RATE;
}

/** USD per web-search request: the first "$N per 1,000 searches" on the page, divided by 1000. */
function parseWebSearchPrice(markdown: string): number | null {
  const match = /\$([\d,]*\.?\d+) per 1,000 searches/.exec(markdown);
  if (!match) return null;
  const perRequest = Number(match[1].replace(/,/g, '')) / 1000;
  return isValidRate(perRequest) ? round6(perRequest) : null;
}
