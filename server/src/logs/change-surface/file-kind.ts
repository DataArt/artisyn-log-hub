/**
 * Change surface — the fixed file-kind taxonomy.
 *
 * `fileCategories` / `classifyFile()` in `claude-extractor.ts` are per-repository and
 * partly heuristic, which is fine for a single session's Read-path breakdown and
 * useless as a *comparable* axis: "40% tests" has to mean the same thing in a Java
 * repo and in this one. So this taxonomy is a closed set, hard-coded here,
 * server-side only — the kind travels per path in the API payload and there is no
 * client copy that could drift.
 *
 * The five rules are **ordered** and the order carries meaning:
 * `test` precedes `source` so `foo.test.ts` is a test rather than source, and `docs`
 * precedes `config` so a `.md` file is documentation rather than configuration.
 */
import { FileKind } from './change-surface.types';

/** Rule 1 — any path segment that marks the whole subtree as tests. */
const TEST_SEGMENTS = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'e2e',
]);

/** Rule 1 — `foo.test.ts`, `foo.spec.tsx`, `foo.e2e-spec.ts`. */
const TEST_BASENAME_RE = /\.(test|spec|e2e-spec)\.[a-z0-9]+$/;

/** Rule 2 — documentation extensions. */
const DOCS_EXTENSIONS = new Set(['md', 'mdx', 'rst', 'txt', 'adoc']);

/** Rule 2 — first-segment documentation roots. */
const DOCS_ROOT_SEGMENTS = new Set(['doc', 'docs']);

/** Rule 3 — configuration extensions. */
const CONFIG_EXTENSIONS = new Set([
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'conf',
  'cfg',
  'properties',
  'xml',
]);

/** Rule 3 — configuration files that carry no extension at all. */
const CONFIG_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
  '.npmrc',
]);

/** Rule 3 — dotfile families whose real name is a suffixed variant. */
const CONFIG_BASENAME_PREFIXES = ['.eslintrc', '.prettierrc', '.babelrc'];

/** Rule 4 — source extensions. */
const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'java',
  'kt',
  'kts',
  'scala',
  'py',
  'rb',
  'go',
  'rs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'swift',
  'm',
  'mm',
  'sql',
  'sh',
  'bash',
  'ps1',
  'css',
  'scss',
  'less',
  'html',
  'vue',
  'svelte',
]);

/**
 * The file's extension: lowercased, no dot, `''` when it has none.
 *
 * A leading dot does **not** start an extension — `.gitignore` is a name, not an
 * extension — and only the last dot counts, so `foo.test.ts` yields `ts`.
 * Exported because the same value is stored on every changed-path row and feeds the
 * display-only extension axis; deriving it twice invites the two to disagree.
 */
export function fileExtension(relPath: string | null | undefined): string {
  if (!relPath) return '';
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return '';
  return basename.slice(dot + 1).toLowerCase();
}

/**
 * Classify a repo-relative path into the fixed taxonomy.
 *
 * Returns `null` for a path that has no repo-relative form (outside the repo, or the
 * repo root was never learned) — the column is nullable for exactly that state, and a
 * guessed `'other'` there would be indistinguishable from a real classification.
 */
export function classifyFileKind(
  relPath: string | null | undefined,
): FileKind | null {
  if (relPath === null || relPath === undefined) return null;
  const folded = relPath.toLowerCase();
  if (folded.length === 0) return null;

  const segments = folded.split('/').filter((seg) => seg.length > 0);
  if (segments.length === 0) return null;
  const basename = segments[segments.length - 1];
  const extension = fileExtension(folded);

  // 1 — tests, before source, so `foo.test.ts` is not classified by its extension.
  if (segments.some((seg) => TEST_SEGMENTS.has(seg))) return 'test';
  if (TEST_BASENAME_RE.test(basename)) return 'test';

  // 2 — docs, before config, so `.md` is documentation and not configuration.
  if (DOCS_EXTENSIONS.has(extension)) return 'docs';
  if (DOCS_ROOT_SEGMENTS.has(segments[0])) return 'docs';

  // 3 — config.
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';
  if (CONFIG_BASENAMES.has(basename)) return 'config';
  if (CONFIG_BASENAME_PREFIXES.some((p) => basename.startsWith(p))) {
    return 'config';
  }

  // 4 — source.
  if (SOURCE_EXTENSIONS.has(extension)) return 'source';

  // 5 — everything else.
  return 'other';
}
