// Research script (plan-deep step 2.5): applies the FR-6 line-regex front-matter parse to every
// OKF bundle under a project root and reports meta size, hint counts and okf_version offsets.
// Usage: node meta-scan.mjs <projectRoot>
import fs from 'node:fs';
import path from 'node:path';

const READ_BYTES = 8192;
const CAP = 200;
const KEYS = ['type', 'status', 'superseded_by', 'stale_after'];
const root = path.resolve(process.argv[2] ?? '.');
const SKIP = new Set(['node_modules', '.git', 'dist', 'tmp', 'target']);

function walk(dir, rel, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), r, out); }
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(r);
  }
}

function scalar(raw) {
  let v = raw.trim();
  const hash = v.search(/\s#/);
  if (hash >= 0) v = v.slice(0, hash).trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
  if (v === '' || v === 'null' || v === '~') return null;
  return v.slice(0, CAP);
}

function parseHead(buf) {
  let text = buf.subarray(0, READ_BYTES).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const meta = { frontMatter: false, hasGenerated: false, hasTimestamp: false };
  const fields = {};
  if (lines[0]?.trim() !== '---') return { meta, fields };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') { meta.frontMatter = true; break; }
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;
    if (key === 'generated') meta.hasGenerated = true;
    if (key === 'timestamp') meta.hasTimestamp = true;
    if (KEYS.includes(key) || ['okf_version', 'title', 'description'].includes(key)) {
      const v = scalar(rest);
      if (v !== null) fields[key] = v;
    }
  }
  return { meta, fields };
}

const md = [];
walk(root, '', md);
const roots = new Map();
for (const f of md) {
  if (!/(^|\/)index\.md$/i.test(f)) continue;
  const buf = fs.readFileSync(path.join(root, f));
  const t = buf.subarray(0, READ_BYTES).toString('utf8');
  const lines = t.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') continue;
  let off = lines[0].length + 1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    if (/^okf_version\s*:/.test(lines[i])) { roots.set(f.replace(/\/?index\.md$/i, ''), { index: f, offset: off }); break; }
    off += Buffer.byteLength(lines[i], 'utf8') + 1;
  }
}

for (const [r, info] of roots) {
  const files = md.filter((f) => (r === '' || f.startsWith(`${r}/`)) && f !== info.index);
  const idx = parseHead(fs.readFileSync(path.join(root, info.index))).fields;
  let metaBytes = 0, maxMeta = 0;
  const hints = { noFrontMatter: 0, noType: 0, v01Timestamp: 0 };
  let withHint = 0, reserved = 0, dot = 0, deprecated = 0, staleAfter = 0;
  for (const f of files) {
    const relToRoot = r === '' ? f : f.slice(r.length + 1);
    if (/(^|\/)(index|log)\.md$/i.test(relToRoot)) { reserved++; continue; }
    if (relToRoot.split('/').some((s) => s.startsWith('.'))) { dot++; continue; }
    const { meta, fields } = parseHead(fs.readFileSync(path.join(root, f)));
    const m = { ...meta };
    for (const k of KEYS) if (fields[k] !== undefined) m[k] = fields[k];
    const bytes = Buffer.byteLength(JSON.stringify(m), 'utf8');
    metaBytes += bytes; maxMeta = Math.max(maxMeta, bytes);
    const h = [];
    if (!meta.frontMatter) h.push('noFrontMatter');
    if (fields.type === undefined) h.push('noType');
    if (meta.hasTimestamp && !meta.hasGenerated) h.push('v01Timestamp');
    for (const x of h) hints[x]++;
    if (h.length) withHint++;
    if ((fields.status ?? '').toLowerCase() === 'deprecated') deprecated++;
    if (fields.stale_after !== undefined) staleAfter++;
  }
  const articles = files.length - reserved - dot;
  console.log(JSON.stringify({
    root: r, okf_version: idx.okf_version ?? null, okf_version_offset: info.offset,
    title: idx.title ?? null, description: idx.description ? `${idx.description.length} chars` : null,
    files: files.length, reserved, dotPaths: dot, articles,
    metaBytesTotal: metaBytes, metaBytesAvg: articles ? +(metaBytes / articles).toFixed(1) : 0, metaBytesMax: maxMeta,
    withHint, hints, deprecated, staleAfter,
  }));
}
