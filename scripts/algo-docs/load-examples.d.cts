/**
 * Types for `load-examples.cjs`, so TypeScript tests (server jest, client vitest) import the
 * loader with real types and without `allowJs`. Keep in sync with the `.cjs` exports.
 */

/**
 * One row of an algorithm doc's rows file `docs/algorithm-examples/<name>.json`.
 *
 * `I`/`E` type `input`/`expected` the way `JSON.parse` is typed: the loader checks the row
 * shape (`id`, `input`, `expected`, `note`), not the contents, so a test that names a shape
 * here is stating the doc's documented input/output format, and a doc row of another shape fails
 * that test's assertions.
 */
export interface AlgoExample<I = unknown, E = unknown> {
  /** Unique within the doc; used as the test title (`it.each(rows)('$id', ...)`). */
  id: string;
  /** Whatever shape the doc defines for the algorithm's input; the test maps it to a call. */
  input: I;
  /** The expected result (or the subset of it the doc pins). */
  expected: E;
  /** The independent derivation of `expected` from the doc's rules — never "what the code returned". */
  note: string;
  /** Extra keys a doc defines (e.g. `only`, `tol`) are passed through untouched. */
  [extra: string]: unknown;
}

export interface LoadExamplesOptions {
  /** Repo root override; by default the root is found by walking up from the loader's directory. */
  root?: string;
}

/** Loads the rows of algorithm doc `<name>` from `docs/algorithm-examples/<name>.json`, in file order. Throws on any malformed rows file. */
export function loadExamples<I = unknown, E = unknown>(
  name: string,
  options?: LoadExamplesOptions,
): AlgoExample<I, E>[];

/** Parses the rows of one rows file's JSON text; `source` labels error messages. */
export function parseExamples(json: string, source?: string): AlgoExample[];

/** 1-based lines of ```examples blocks still inside a doc's markdown (there must be none). */
export function findInlineExamplesBlocks(markdown: string, source?: string): number[];

/** The repo root: first ancestor with `.git`, else first ancestor with `docs/knowledgebase/algorithms/`. */
export function findRepoRoot(startDir?: string): string;
