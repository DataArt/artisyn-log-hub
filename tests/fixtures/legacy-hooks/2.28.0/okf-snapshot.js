'use strict';
/**
 * Claude Code Hook helper — finds the OKF knowledge-base bundles of a repository and builds the
 * `okf-snapshot` NDJSON line plus its content-derived id (not a hook entry point itself).
 *
 * Plan `2026-10-27-okf-usage-tab`, DD-13 to DD-18 and DD-43:
 *   - A bundle is rooted by every `index.md` whose front matter (first
 *     `OKF_FRONT_MATTER_READ_BYTES` bytes, between `---` lines) carries an `okf_version:` key. Every
 *     `.md` file under a bundle root belongs to the deepest bundle root containing it. Links inside
 *     an index are never followed.
 *   - The walk starts at the project (git) root and skips `.git`, `node_modules`, symlinked
 *     directories, the built-in `OKF_DEFAULT_EXCLUDE` and every `config.okf.exclude` glob.
 *   - Each file's `ignored` flag comes from ONE `git check-ignore --stdin -z` call; exit 1 means
 *     "nothing ignored", any other failure marks every file ignored (fail closed — an ignored file
 *     is private and must never leak into a team view).
 *   - The id is sha256 over a sorted projection without mtime, so it is stable while the content
 *     is unchanged and changes as soon as any file's content, path or ignored flag changes.
 *
 * Never throws: any failure is logged and yields `null` (no OKF lines on this upload).
 *
 * @typedef {Object} OkfSnapshotFile
 * @property {string} path - repo-relative, `/`-separated
 * @property {boolean} ignored
 * @property {number} size - bytes on disk
 * @property {string} hash - sha256 hex of the file content
 *
 * @typedef {Object} OkfSnapshotBundle
 * @property {string} root - repo-relative folder of the bundle's `index.md` (`''` for the repo root)
 * @property {string} index - repo-relative path of the bundle's `index.md`
 * @property {boolean} ignored - the `index.md`'s own flag
 * @property {OkfSnapshotFile[]} files
 *
 * @typedef {Object} OkfSnapshot
 * @property {'okf-snapshot'} type
 * @property {string} okfSnapshotId - 64 lowercase hex
 * @property {number} schemaVersion
 * @property {OkfSnapshotBundle[]} bundles
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { gitWithInput } = require('./git-context');
const { readOkfHashCache, writeOkfHashCache } = require('./okf-state');

/** DD-13: bumped only on an incompatible change to the body shape. */
const OKF_SNAPSHOT_SCHEMA_VERSION = 1;

/** DD-18: more bundle files than this → no snapshot is sent (logged). */
const OKF_SNAPSHOT_MAX_FILES = 20000;

/** DD-18: how much of an `index.md` is read to look for the `okf_version:` front-matter key. */
const OKF_FRONT_MATTER_READ_BYTES = 512;

/** DD-18: budget of the single `git check-ignore` call. */
const OKF_CHECK_IGNORE_TIMEOUT_MS = 5000;

/** DD-18: detection taking longer than this is logged (measurement threshold, not a cut-off). */
const OKF_DETECTION_BUDGET_MS = 300;

/** DD-43: always excluded on top of `config.okf.exclude`, so a user list never removes it. */
const OKF_DEFAULT_EXCLUDE = ['tmp/**'];

/**
 * A file modified this recently is hashed but not cached: two writes inside one mtime tick with
 * the same size would otherwise leave a stale hash behind (the "racy file" case git also guards).
 */
const OKF_HASH_CACHE_MIN_AGE_MS = 2000;

/** Directory names never descended into, wherever they appear. */
const OKF_SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);

/** @param {string|Buffer} data @returns {string} */
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** @param {string} a @param {string} b @returns {number} plain code-unit order (locale-free) */
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Compile a repo-relative glob to a RegExp matched against `/`-separated repo-relative paths
 * (no leading `./` or `/`). Supported syntax only:
 *   - `**` — any number of path segments: `a/**` matches `a` itself and everything under it,
 *     `**\/b` matches `b` at any depth, `a/**\/b` matches `a/b`, `a/x/b`, …
 *   - `*` — any run of characters inside one segment
 *   - `?` — one character inside one segment
 * Everything else matches literally. A pattern without wildcards matches exactly that path, so
 * `docs/private` excludes that folder (and, since folders are pruned, everything under it).
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let g = String(glob).trim().replace(/\\/g, '/');
  while (g.startsWith('./')) g = g.slice(2);
  g = g.replace(/^\/+/, '').replace(/\/+$/, '');

  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/';
        const next = g[i + 2];
        if (atStart && next === '/') {
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (atStart && next === undefined) {
          // trailing `/**` (or a bare `**`): drop the `/` already emitted and make it optional, so
          // `a/**` also matches the folder `a` itself.
          if (re.endsWith('/')) {
            re = re.slice(0, -1) + '(?:/.*)?';
          } else {
            re += '.*';
          }
          i += 2;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string[]} globs
 * @returns {(relPath: string) => boolean}
 */
function compileExclude(globs) {
  const regexes = [];
  for (const g of globs) {
    if (typeof g !== 'string' || g.trim() === '') continue;
    regexes.push(globToRegExp(g));
  }
  return (relPath) => regexes.some((re) => re.test(relPath));
}

// ---------------------------------------------------------------------------
// Bundle detection
// ---------------------------------------------------------------------------

/**
 * Whether an `index.md`'s head declares an OKF bundle: the text starts with a `---` line and a
 * line `okf_version:` follows before the closing `---` (or before the read window ends).
 *
 * @param {string} head - the first `OKF_FRONT_MATTER_READ_BYTES` bytes, decoded as UTF-8
 * @returns {boolean}
 */
function hasOkfFrontMatter(head) {
  const text = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head; // drop a UTF-8 BOM
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length === 0 || lines[0].trim() !== '---') return false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return false;
    if (/^okf_version\s*:/.test(line)) return true;
  }
  return false;
}

/** @param {string} absFile @returns {string} the file head, or '' when unreadable */
function readHead(absFile) {
  let fd;
  try {
    fd = fs.openSync(absFile, 'r');
    const buf = Buffer.alloc(OKF_FRONT_MATTER_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, OKF_FRONT_MATTER_READ_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** @param {string} name @returns {boolean} */
function isMarkdownName(name) {
  return name.toLowerCase().endsWith('.md');
}

/**
 * Walk the tree under `projectRoot` and return every bundle root with its `.md` files (paths
 * only — no content is read except the `index.md` heads). Files outside every bundle are dropped.
 *
 * @param {string} projectRoot
 * @param {string[]} [exclude] - globs applied in addition to nothing else (the caller adds
 *   `OKF_DEFAULT_EXCLUDE`; see {@link buildOkfSnapshot})
 * @returns {Array<{ root: string, index: string, files: string[] }>} sorted by `root`, files sorted
 */
function detectOkfBundles(projectRoot, exclude = []) {
  const isExcluded = compileExclude(Array.isArray(exclude) ? exclude : []);
  /** @type {string[]} */
  const mdFiles = [];
  /** @type {Map<string, string>} bundle root folder ('' = repo root) → its index.md path */
  const roots = new Map();

  /** @param {string} absDir @param {string} relDir */
  function walk(absDir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        // Symlinked directories are never followed; a symlinked file is read like a file.
        try {
          const st = fs.statSync(path.join(absDir, e.name));
          isDir = false;
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (OKF_SKIP_DIR_NAMES.has(e.name)) continue;
        if (isExcluded(rel)) continue;
        walk(path.join(absDir, e.name), rel);
        continue;
      }
      if (!isFile || !isMarkdownName(e.name)) continue;
      if (isExcluded(rel)) continue;
      mdFiles.push(rel);
      if (e.name.toLowerCase() === 'index.md' && hasOkfFrontMatter(readHead(path.join(absDir, e.name)))) {
        roots.set(relDir, rel);
      }
    }
  }
  walk(projectRoot, '');

  if (roots.size === 0) return [];

  // Deepest root first, so the first match below is the deepest root containing the file.
  const byDepth = [...roots.keys()].sort((a, b) => b.length - a.length);
  /** @type {Map<string, { root: string, index: string, files: string[] }>} */
  const bundles = new Map();
  for (const [root, index] of roots) bundles.set(root, { root, index, files: [] });
  for (const file of mdFiles) {
    const owner = byDepth.find((root) => root === '' || file.startsWith(`${root}/`));
    if (owner === undefined) continue;
    bundles.get(owner).files.push(file);
  }

  return [...bundles.values()]
    .sort((a, b) => cmpStr(a.root, b.root))
    .map((b) => ({ ...b, files: b.files.sort(cmpStr) }));
}

// ---------------------------------------------------------------------------
// Ignored flags
// ---------------------------------------------------------------------------

/**
 * One `git check-ignore --stdin -z` over `relPaths` (DD-16).
 *
 * @param {string} projectRoot
 * @param {string[]} relPaths
 * @param {(line: string) => void} [log]
 * @returns {Set<string>|null} the ignored paths, or `null` when git failed (caller fails closed)
 */
function checkIgnored(projectRoot, relPaths, log) {
  if (relPaths.length === 0) return new Set();
  const input = relPaths.join('\0') + '\0';
  const { status, stdout } = gitWithInput(
    ['check-ignore', '--stdin', '-z'],
    projectRoot,
    input,
    OKF_CHECK_IGNORE_TIMEOUT_MS,
  );
  if (status === 1) return new Set();
  if (status !== 0) {
    if (log) log(`okf-snapshot: git check-ignore failed (status ${status}) — marking every KB file ignored`);
    return null;
  }
  return new Set(stdout.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')));
}

// ---------------------------------------------------------------------------
// Snapshot id
// ---------------------------------------------------------------------------

/**
 * DD-14: sha256 over `JSON.stringify` of the bundles sorted by `root`, each bundle's files sorted
 * by `path`, projected to `{root, index, ignored, files:[{path, ignored, size, hash}]}`. Input
 * order and any extra field (e.g. an mtime) never change the id.
 *
 * @param {OkfSnapshotBundle[]} bundles
 * @returns {string} 64-char lowercase hex
 */
function computeOkfSnapshotId(bundles) {
  const list = Array.isArray(bundles) ? bundles : [];
  const canon = [...list]
    .sort((a, b) => cmpStr(a.root, b.root))
    .map((b) => ({
      root: b.root,
      index: b.index,
      ignored: b.ignored === true,
      files: [...(Array.isArray(b.files) ? b.files : [])]
        .sort((x, y) => cmpStr(x.path, y.path))
        .map((f) => ({ path: f.path, ignored: f.ignored === true, size: f.size, hash: f.hash })),
    }));
  return sha256Hex(JSON.stringify(canon));
}

// ---------------------------------------------------------------------------
// Content hashes (with the optional mtime cache)
// ---------------------------------------------------------------------------

/**
 * Size and sha256 of every file in `relPaths`. With `workDir`, hashes are reused from the
 * `okf-state.json` cache for files whose `(mtimeMs, size)` did not change: the cache key is the
 * sorted `(path, mtimeMs, size)` list, so an untouched KB costs one `stat` per file instead of a
 * read + hash (Chunk 7: ~1.3 s → ~0.15 s for 5 000 files on Windows). The cache never holds
 * ignored flags — `git check-ignore` runs on every build, since `.gitignore` can change without
 * any KB file changing.
 *
 * @param {string} projectRoot
 * @param {string[]} relPaths
 * @param {string|undefined} workDir
 * @returns {Map<string, { size: number, hash: string }>} files that vanished or are unreadable are absent
 */
function hashFiles(projectRoot, relPaths, workDir) {
  /** @type {Map<string, { size: number, hash: string }>} */
  const out = new Map();
  const abs = (rel) => path.join(projectRoot, ...rel.split('/'));
  const readAndHash = (rel) => {
    try {
      const content = fs.readFileSync(abs(rel));
      return { size: content.length, hash: sha256Hex(content) };
    } catch {
      return null; // vanished or unreadable between the walk and now
    }
  };

  if (!workDir) {
    for (const rel of relPaths) {
      const r = readAndHash(rel);
      if (r) out.set(rel, r);
    }
    return out;
  }

  /** @type {Array<[string, number, number]>} */
  const stats = [];
  for (const rel of [...relPaths].sort(cmpStr)) {
    try {
      const st = fs.statSync(abs(rel));
      stats.push([rel, st.mtimeMs, st.size]);
    } catch {
      // vanished between the walk and now
    }
  }
  const treeKey = sha256Hex(JSON.stringify(stats));
  const cache = readOkfHashCache(workDir);
  const cached = cache ? cache.files : {};
  const now = Date.now();
  /** @type {Record<string, [number, number, string]>} */
  const nextFiles = {};
  for (const [rel, mtimeMs, size] of stats) {
    const hit = cached[rel];
    if (Array.isArray(hit) && hit[0] === mtimeMs && hit[1] === size && typeof hit[2] === 'string') {
      out.set(rel, { size, hash: hit[2] });
      nextFiles[rel] = hit;
      continue;
    }
    const r = readAndHash(rel);
    if (!r) continue;
    out.set(rel, r);
    if (r.size === size && now - mtimeMs >= OKF_HASH_CACHE_MIN_AGE_MS) nextFiles[rel] = [mtimeMs, size, r.hash];
  }
  if (!cache || cache.treeKey !== treeKey || Object.keys(cache.files).length !== Object.keys(nextFiles).length) {
    writeOkfHashCache(workDir, { treeKey, files: nextFiles });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full snapshot
// ---------------------------------------------------------------------------

/**
 * Detect the bundles under `projectRoot`, read and hash their files, flag the ignored ones and
 * return the full `okf-snapshot` line (DD-13). A repository without any bundle still gets a
 * snapshot with `bundles: []`, so the server can tell "no KB" from "hook too old to say".
 *
 * @param {{
 *   projectRoot: string,
 *   config?: Record<string, *>,
 *   log?: (line: string) => void,
 *   workDir?: string,
 * }} options - `workDir` (the hook's `.artisyn/ai_work_dir`) enables the content-hash cache in
 *   its `okf-state.json`; without it every file is read and hashed
 * @returns {OkfSnapshot|null} `null` on any failure or when the bundles exceed
 *   `OKF_SNAPSHOT_MAX_FILES` (logged)
 */
function buildOkfSnapshot({ projectRoot, config, log, workDir } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  try {
    if (typeof projectRoot !== 'string' || !projectRoot) return null;
    const started = Date.now();

    const okf = config && config.okf && typeof config.okf === 'object' ? config.okf : {};
    const userExclude = Array.isArray(okf.exclude) ? okf.exclude.filter((g) => typeof g === 'string') : [];
    const detected = detectOkfBundles(projectRoot, [...OKF_DEFAULT_EXCLUDE, ...userExclude]);

    const fileCount = detected.reduce((n, b) => n + b.files.length, 0);
    if (fileCount > OKF_SNAPSHOT_MAX_FILES) {
      say(`okf-snapshot: ${fileCount} KB files exceed the ${OKF_SNAPSHOT_MAX_FILES} cap — no snapshot sent`);
      return null;
    }

    const allFiles = detected.flatMap((b) => b.files);
    const ignoredSet = checkIgnored(projectRoot, allFiles, say);
    const isIgnored = (p) => ignoredSet === null || ignoredSet.has(p);
    const hashes = hashFiles(projectRoot, allFiles, typeof workDir === 'string' && workDir ? workDir : undefined);

    /** @type {OkfSnapshotBundle[]} */
    const bundles = [];
    for (const b of detected) {
      /** @type {OkfSnapshotFile[]} */
      const files = [];
      for (const rel of b.files) {
        const h = hashes.get(rel);
        if (!h) continue;
        files.push({ path: rel, ignored: isIgnored(rel), size: h.size, hash: h.hash });
      }
      bundles.push({ root: b.root, index: b.index, ignored: isIgnored(b.index), files });
    }

    const okfSnapshotId = computeOkfSnapshotId(bundles);
    const elapsed = Date.now() - started;
    if (elapsed > OKF_DETECTION_BUDGET_MS) {
      say(`okf-snapshot: detection took ${elapsed} ms (budget ${OKF_DETECTION_BUDGET_MS} ms, ${fileCount} files)`);
    }
    return { type: 'okf-snapshot', okfSnapshotId, schemaVersion: OKF_SNAPSHOT_SCHEMA_VERSION, bundles };
  } catch (err) {
    say(`okf-snapshot: failed (${err && err.message ? err.message : String(err)}) — no snapshot sent`);
    return null;
  }
}

/**
 * The cheap reference line sent on every root `artisyn` upload (DD-13).
 * @param {string} okfSnapshotId
 * @returns {{ type: 'okf-snapshot-ref', okfSnapshotId: string }}
 */
function buildOkfSnapshotRef(okfSnapshotId) {
  return { type: 'okf-snapshot-ref', okfSnapshotId };
}

module.exports = {
  OKF_SNAPSHOT_SCHEMA_VERSION,
  OKF_SNAPSHOT_MAX_FILES,
  OKF_FRONT_MATTER_READ_BYTES,
  OKF_CHECK_IGNORE_TIMEOUT_MS,
  OKF_DETECTION_BUDGET_MS,
  OKF_DEFAULT_EXCLUDE,
  globToRegExp,
  hasOkfFrontMatter,
  detectOkfBundles,
  computeOkfSnapshotId,
  buildOkfSnapshot,
  buildOkfSnapshotRef,
};
