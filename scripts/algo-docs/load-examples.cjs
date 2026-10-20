'use strict';

/**
 * Loads the worked examples of an algorithm doc so a table-driven test can run them.
 *
 * An algorithm doc lives at `docs/knowledgebase/algorithms/<name>.md` (format: that directory's
 * README.md). Its `## Examples` section holds exactly one fenced block tagged `examples`: a JSON
 * array of `{id, input, expected, note}` objects. The test does
 * `it.each(loadExamples('<name>'))`, so the numbers live only in the doc: editing a row changes
 * the test without touching test code, and changing the code without the doc breaks it.
 *
 * Pure CommonJS on `fs`/`path` only, so all three runners can load it as-is:
 * - server jest (ts-jest): a plain `import`/`require` of this `.cjs` file. The jest transform only
 *   matches `.ts`/`.js`, so node loads it untransformed, and no `allowJs` is needed — types come
 *   from `load-examples.d.cts`.
 * - client vitest: `createRequire(import.meta.url)`.
 * - hook `node --test`: `require`.
 *
 * Every malformed doc throws with the file path in the message, so a broken table fails the test
 * loudly instead of turning into zero cases.
 */

const fs = require('fs');
const path = require('path');

const ALGORITHMS_REL = path.join('docs', 'knowledgebase', 'algorithms');
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const EXAMPLES_HEADING_RE = /^##\s+Examples\s*$/;
const ANY_SECTION_HEADING_RE = /^#{1,2}\s/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Walks up from `startDir` to the repo root: the first directory holding `.git` (a directory, or a
 * file in a git worktree). Without a `.git` anywhere above (e.g. an exported source tree), the
 * first directory holding `docs/knowledgebase/algorithms/` is the root. Throws if neither exists.
 *
 * @param {string} [startDir]
 * @returns {string}
 */
function findRepoRoot(startDir) {
  const start = path.resolve(startDir || __dirname);
  const byGit = walkUp(start, (dir) => fs.existsSync(path.join(dir, '.git')));
  if (byGit) return byGit;
  const byDocs = walkUp(start, (dir) => isDirectory(path.join(dir, ALGORITHMS_REL)));
  if (byDocs) return byDocs;
  throw new Error(
    `load-examples: no repo root above ${start} (looked for .git, then ${ALGORITHMS_REL.split(path.sep).join('/')}/)`,
  );
}

function walkUp(start, matches) {
  let dir = start;
  for (;;) {
    if (matches(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds every fenced code block in the doc. A fence closes on a line of the same character, at
 * least as long as the opener, with nothing after it (CommonMark). Headings inside a fence are
 * not headings, which is why sections are resolved over this list.
 *
 * @returns {{info: string, openLine: number, closeLine: number, body: string}[]}
 */
function scanFences(lines, source) {
  const fences = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      const close = line.trim();
      if (close.length >= open.marker.length && close === open.marker[0].repeat(close.length)) {
        fences.push({
          info: open.info,
          openLine: open.line,
          closeLine: i,
          body: lines.slice(open.line + 1, i).join('\n'),
        });
        open = null;
      }
      continue;
    }
    const m = FENCE_OPEN_RE.exec(line);
    if (m) open = { marker: m[1], info: m[2].trim().split(/\s+/)[0], line: i };
  }
  if (open) {
    throw new Error(`load-examples: ${source}: fence opened on line ${open.line + 1} is never closed`);
  }
  return fences;
}

function insideAnyFence(fences, lineIndex) {
  return fences.some((f) => lineIndex > f.openLine && lineIndex < f.closeLine);
}

/**
 * Parses the examples table of one algorithm doc's markdown text.
 *
 * @param {string} markdown the doc text (LF or CRLF)
 * @param {string} [source] a label for error messages, normally the doc path
 * @returns {{id: string, input: unknown, expected: unknown, note: string}[]} rows in doc order
 */
function parseExamples(markdown, source) {
  const label = source || '<markdown>';
  const lines = String(markdown).split(/\r?\n/);
  const fences = scanFences(lines, label);

  const examplesFences = fences.filter((f) => f.info === 'examples');
  if (examplesFences.length === 0) {
    throw new Error(`load-examples: ${label}: no \`\`\`examples block`);
  }
  if (examplesFences.length > 1) {
    const at = examplesFences.map((f) => f.openLine + 1).join(', ');
    throw new Error(`load-examples: ${label}: ${examplesFences.length} \`\`\`examples blocks (lines ${at}), expected exactly one`);
  }
  const block = examplesFences[0];

  const headingLine = lastHeadingBefore(lines, fences, block.openLine);
  if (headingLine === -1 || !EXAMPLES_HEADING_RE.test(lines[headingLine])) {
    throw new Error(`load-examples: ${label}: the \`\`\`examples block (line ${block.openLine + 1}) is not under a "## Examples" heading`);
  }

  let rows;
  try {
    rows = JSON.parse(block.body);
  } catch (err) {
    throw new Error(`load-examples: ${label}: the \`\`\`examples block (line ${block.openLine + 1}) is not valid JSON: ${err.message}`);
  }
  validateRows(rows, label);
  return rows;
}

function lastHeadingBefore(lines, fences, lineIndex) {
  for (let i = lineIndex - 1; i >= 0; i--) {
    if (ANY_SECTION_HEADING_RE.test(lines[i]) && !insideAnyFence(fences, i)) return i;
  }
  return -1;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateRows(rows, label) {
  if (!Array.isArray(rows)) {
    throw new Error(`load-examples: ${label}: the \`\`\`examples block must be a JSON array of rows`);
  }
  if (rows.length === 0) {
    throw new Error(`load-examples: ${label}: the \`\`\`examples block has no rows`);
  }
  const seen = new Set();
  rows.forEach((row, i) => {
    const where = `${label}: row ${i + 1}`;
    if (!isPlainObject(row)) {
      throw new Error(`load-examples: ${where} is not an object`);
    }
    if (typeof row.id !== 'string' || row.id.trim() === '') {
      throw new Error(`load-examples: ${where} has no string "id"`);
    }
    if (seen.has(row.id)) {
      throw new Error(`load-examples: ${where}: duplicate id "${row.id}"`);
    }
    seen.add(row.id);
    for (const key of ['input', 'expected']) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) {
        throw new Error(`load-examples: ${where} ("${row.id}") has no "${key}"`);
      }
    }
    if (typeof row.note !== 'string' || row.note.trim() === '') {
      throw new Error(`load-examples: ${where} ("${row.id}") has no "note" (the independent derivation of "expected")`);
    }
  });
}

/**
 * Loads the examples of `docs/knowledgebase/algorithms/<name>.md`.
 *
 * @param {string} name the doc slug, e.g. `change-surface-concentration`
 * @param {{root?: string}} [options] `root` overrides the repo root (tests use a temp dir)
 * @returns {{id: string, input: unknown, expected: unknown, note: string}[]} rows in doc order;
 *   a fresh copy on every call, so a test may mutate its rows freely
 */
function loadExamples(name, options) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`load-examples: invalid doc name ${JSON.stringify(name)} (expected a slug like "cost-formula")`);
  }
  const root = (options && options.root) || findRepoRoot(__dirname);
  const file = path.join(root, ALGORITHMS_REL, `${name}.md`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`load-examples: cannot read ${file}: ${err.message}`);
  }
  return parseExamples(text, file);
}

module.exports = { loadExamples, parseExamples, findRepoRoot };
