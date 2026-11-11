// Harness-entries survey (FR-6): reads Claude Code transcripts stored in a Log Hub Postgres
// container, read-only, and generates ../survey-table.md.
//
// Usage (from this folder):  LOGHUB_SURVEY_UNTIL=<ISO timestamp> node ./scan.mjs
// Env:
//   LOGHUB_SURVEY_UNTIL         required; cutoff timestamp, printed in the table header. A re-run
//                               with the same value reproduces the table byte for byte.
//   LOGHUB_SURVEY_DB_CONTAINER  optional; Postgres container (default artisyn-log-hub-db). The
//                               queries run as the container's own POSTGRES_USER / POSTGRES_DB.
//
// Raw rows go to <repo>/tmp/harness-survey/ (gitignored). The committed table holds aggregates
// only: no session ids, no emails, no paths, no text payloads.
//
// The file is ESM because the plan names it scan.mjs; otherwise it follows the nodejs-script
// conventions: synchronous, built-ins only, diagnostics on stderr, one top-level guard.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN_SESSIONS = 30;
const BATCH_SIZE = 20;
const MASK_BELOW = 3;
const MAX_FACET_COLUMNS = 10;
const HOOK_FLUSH_VERSION = [2, 8, 0];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const tableFile = path.resolve(scriptDir, '..', 'survey-table.md');
const consumersFile = path.join(scriptDir, 'consumers.json');
const sqlFile = path.join(scriptDir, 'queries.sql');

// Envelope fields every transcript line carries; left out of the Payload column of non-attachment
// lines so it shows what is specific to the entry.
const ENVELOPE_KEYS = new Set([
  'cwd', 'type', 'uuid', 'version', 'userType', 'gitBranch', 'sessionId', 'timestamp', 'entrypoint',
  'parentUuid', 'logicalParentUuid', 'isSidechain', 'slug', 'agentId', 'requestId', 'subtype', 'level',
]);
// Top-level line types that are not attachments, used to label consumers.json keys that the
// sample does not contain.
const LINE_TYPES = new Set([
  'user', 'assistant', 'summary', 'queue-operation', 'file-history-snapshot', 'progress',
  'custom-title', 'agent-name', 'tag', 'pr-link', 'last-prompt', 'permission-mode',
]);

const FACETS = [
  { id: 'entrypoint', title: 'entrypoint' },
  { id: 'ccVersion', title: 'CC version', sort: compareVersionLabels },
  { id: 'os', title: 'OS family' },
  { id: 'ide', title: 'IDE' },
  { id: 'diagSources', title: 'diagnostics sources' },
  { id: 'hooks', title: 'hooks (seen running)' },
  { id: 'mode', title: 'session mode (auto_mode)' },
];

// ---------------------------------------------------------------------------------------------
// Small helpers

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersionArrays(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function compareVersionLabels(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va && vb) return compareVersionArrays(va, vb);
  if (va) return -1;
  if (vb) return 1;
  return cmp(a, b);
}

function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no .git found above ${start}`);
    dir = parent;
  }
}

// RFC 4180 CSV as printed by `psql --csv` (quoted fields may hold commas, quotes and newlines).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows.shift();
  const records = rows.map((cells) => {
    const rec = {};
    header.forEach((h, i) => { rec[h] = cells[i] === undefined ? '' : cells[i]; });
    return rec;
  });
  return { header, records };
}

function loadSections(sqlText) {
  const sections = {};
  const parts = sqlText.split(/^-- @query (\w+)[ \t]*\r?$/m);
  for (let i = 1; i < parts.length; i += 2) sections[parts[i]] = parts[i + 1];
  for (const name of ['roots', 'lines', 'repos']) {
    if (!sections[name]) throw new Error(`queries.sql has no "-- @query ${name}" section`);
  }
  return sections;
}

function psql(container, sql, until, roots) {
  const script = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q --csv -v ON_ERROR_STOP=1 -v "until=$1" -v "roots=$2"';
  return execFileSync('docker', ['exec', '-i', container, 'sh', '-c', script, 'sh', until, roots], {
    input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, timeout: 180000,
  });
}

function parseJsonCell(text) {
  return text === '' ? null : JSON.parse(text);
}

// Anything that still looks like an email or a path is reduced to its shape before it can reach
// the committed table.
function safeLabel(value) {
  let s = String(value).replace(/[\r\n\t|]+/g, ' ').trim();
  s = s.replace(/[^\s@]+@[^\s@]+/g, '<email>');
  s = s.replace(/[A-Za-z]:[\\/][^\s]*/g, '<abs-win>');
  s = s.replace(/(^|\s)\/[^\s]*/g, '$1<abs-posix>');
  if (s.length > 60) s = `${s.slice(0, 57)}…`;
  return s || '(empty)';
}

function mdCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// ---------------------------------------------------------------------------------------------
// Facets (Design Decision 4)

// Hook identity: the first path-like token of the command (a leading interpreter such as `node`
// or `bash` is skipped), reduced to its basename without extension. A command without any
// path-like token (Claude Code shows a hook's status message there, e.g. "Uploading logs...")
// is `status-text`.
function hookIdentity(command) {
  const tokens = (String(command || '').match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map((t) => t.replace(/^["']|["']$/g, ''));
  const pathLike = tokens.find((t) => /[\\/]/.test(t) || /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(t));
  if (!pathLike) return 'status-text';
  const base = pathLike.split(/[\\/]/).filter(Boolean).pop() || '';
  const name = base.replace(/\.[^.]+$/, '');
  return name ? safeLabel(name) : 'status-text';
}

function osFamily(cwd) {
  if (/^[A-Za-z]:[\\/]/.test(cwd)) return 'windows';
  if (/^\/mnt\/[a-z]\//.test(cwd)) return 'wsl';
  if (/^\//.test(cwd)) return 'posix';
  return 'unknown';
}

function autoModeLabel(json) {
  if (!json || typeof json !== 'object') return 'not recorded';
  const flags = Object.keys(json).filter((k) => json[k] === true).sort(cmp);
  return flags.length ? flags.join('+') : 'no flags set';
}

function newSession() {
  return {
    entrypoint: null, ccVersion: null, cwd: null, ideNames: [], anyIde: false,
    diagSources: new Set(), hooks: new Set(), mode: null,
    subSessions: new Set(), mainLines: [], lineCount: 0,
  };
}

function readFacetFields(s, line) {
  if (s.entrypoint === null && line.entrypoint) s.entrypoint = line.entrypoint;
  if (s.ccVersion === null && line.cc_version) {
    const m = /^(\d+\.\d+\.\d+)/.exec(line.cc_version);
    if (m) s.ccVersion = m[1];
  }
  if (s.cwd === null && line.cwd) s.cwd = line.cwd;
  if (line.attachment_type && line.attachment_type.endsWith('_in_ide')) {
    s.anyIde = true;
    if (line.ide_name) s.ideNames.push(line.ide_name);
  }
  if (line.diag_sources !== '') {
    for (const src of parseJsonCell(line.diag_sources) || []) s.diagSources.add(src || 'other');
  }
  if (line.hook_cmds !== '') {
    for (const c of parseJsonCell(line.hook_cmds) || []) s.hooks.add(hookIdentity(c));
  }
  if (s.mode === null && line.auto_mode !== '') s.mode = autoModeLabel(parseJsonCell(line.auto_mode));
}

function finishFacets(s) {
  const setLabel = (set, empty) => (set.size ? [...set].map(safeLabel).sort(cmp).join(' + ') : empty);
  return {
    entrypoint: s.entrypoint ? safeLabel(s.entrypoint) : 'unknown',
    ccVersion: s.ccVersion || 'unknown',
    os: s.cwd ? osFamily(s.cwd) : 'unknown',
    ide: s.ideNames.length ? safeLabel(s.ideNames[0]) : (s.anyIde ? 'IDE, name not recorded' : 'none'),
    diagSources: setLabel(s.diagSources, 'none seen'),
    hooks: setLabel(s.hooks, 'none seen'),
    mode: s.mode || 'not recorded',
  };
}

// ---------------------------------------------------------------------------------------------
// Entry types

function typeOf(line) {
  if (line.line_type === 'attachment') return { key: line.attachment_type || '(no type)', kind: 'attachment' };
  if (line.line_type === 'system') return { key: `system:${line.subtype || '(no subtype)'}`, kind: 'system' };
  return { key: line.line_type || '(no type)', kind: 'line' };
}

function kindOfKey(key) {
  if (key.startsWith('system:')) return 'system';
  return LINE_TYPES.has(key) ? 'line' : 'attachment';
}

function payloadKeys(line, kind) {
  const keys = parseJsonCell(line.payload_keys) || [];
  return kind === 'attachment' ? keys.filter((k) => k !== 'type') : keys.filter((k) => !ENVELOPE_KEYS.has(k));
}

// Stop-time entries of the last turn (Design Decision 7): an entry belongs to the turn whose user
// prompt is the latest at or before its timestamp; Stop-time entries after the last assistant
// line stay in that turn. Only the main transcript is walked.
function lastTurnStopEntries(mainLines) {
  let promptIdx = -1;
  for (let i = 0; i < mainLines.length; i++) if (mainLines[i].is_prompt === 't') promptIdx = i;
  if (promptIdx === -1) return null;
  const promptTs = Date.parse(mainLines[promptIdx].ts);
  const found = { turnDuration: false, stopHookSummary: false, stopHookSuccess: false };
  for (let i = 0; i < mainLines.length; i++) {
    const l = mainLines[i];
    const ts = Date.parse(l.ts);
    const inTurn = Number.isNaN(ts) || Number.isNaN(promptTs) ? i > promptIdx : ts >= promptTs;
    if (!inTurn) continue;
    if (l.line_type === 'system' && l.subtype === 'turn_duration') found.turnDuration = true;
    if (l.line_type === 'system' && l.subtype === 'stop_hook_summary') found.stopHookSummary = true;
    if (l.attachment_type === 'hook_success' && /^Stop(?![A-Za-z])/.test(l.hook_event || '')) found.stopHookSuccess = true;
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Aggregation

function newCell() { return { count: 0, sessions: new Set() }; }

function addTo(map, key, root) {
  if (!map.has(key)) map.set(key, newCell());
  const c = map.get(key);
  c.count += 1;
  c.sessions.add(root);
}

function cellText(cell) {
  if (!cell || cell.count === 0) return '—';
  if (cell.sessions.size < MASK_BELOW) return 'n < 3';
  return `${cell.count} / ${cell.sessions.size}`;
}

function sessionsText(n) {
  if (n === 0) return '—';
  return n < MASK_BELOW ? 'n < 3' : String(n);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function aggregate(lines, sessions) {
  const types = new Map();
  const diag = new Map();
  const facetCells = new Map();
  for (const f of FACETS) facetCells.set(f.id, new Map());

  for (const line of lines) {
    const root = line.root_id;
    const facets = sessions.get(root).facets;
    const { key, kind } = typeOf(line);
    if (!types.has(key)) types.set(key, { key, kind, count: 0, sessions: new Set(), chars: [], keys: new Map() });
    const t = types.get(key);
    t.count += 1;
    t.sessions.add(root);
    t.chars.push(Number(line.line_chars) || 0);
    for (const k of payloadKeys(line, kind)) t.keys.set(k, (t.keys.get(k) || 0) + 1);

    const rowKeys = [key];
    if (line.diag_sources !== '') {
      const items = parseJsonCell(line.diag_sources) || [];
      const perSource = new Map();
      for (const src of items) {
        const s = safeLabel(src || 'other');
        perSource.set(s, (perSource.get(s) || 0) + 1);
      }
      if (perSource.size === 0) perSource.set('(no items)', 0);
      for (const [src, n] of perSource) {
        if (!diag.has(src)) diag.set(src, { entries: 0, items: 0, sessions: new Set() });
        const d = diag.get(src);
        d.entries += 1;
        d.items += n;
        d.sessions.add(root);
        rowKeys.push(`${key}\u0000${src}`);
      }
    }
    for (const f of FACETS) {
      const byRow = facetCells.get(f.id);
      for (const rk of rowKeys) addTo(byRow, `${rk}\u0001${facets[f.id]}`, root);
    }
  }
  return { types, diag, facetCells };
}

function facetValues(sessions) {
  const out = new Map();
  for (const f of FACETS) {
    const counts = new Map();
    for (const s of sessions.values()) counts.set(s.facets[f.id], (counts.get(s.facets[f.id]) || 0) + 1);
    out.set(f.id, counts);
  }
  return out;
}

function chooseColumns(facet, counts) {
  const sortFn = facet.sort || cmp;
  const all = [...counts.keys()];
  if (all.length <= MAX_FACET_COLUMNS) return { columns: all.sort(sortFn), other: [] };
  const ranked = all.slice().sort((a, b) => (counts.get(b) - counts.get(a)) || sortFn(a, b));
  const kept = ranked.slice(0, MAX_FACET_COLUMNS - 1);
  return { columns: kept.sort(sortFn), other: ranked.slice(MAX_FACET_COLUMNS - 1) };
}

function mergeCells(byRow, rowKey, values) {
  const merged = newCell();
  for (const v of values) {
    const c = byRow.get(`${rowKey}\u0001${v}`);
    if (!c) continue;
    merged.count += c.count;
    for (const s of c.sessions) merged.sessions.add(s);
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Stop-time statistics

function stopTimeStats(sessions, repos) {
  const groups = { all: [], interactive: [], print: [] };
  let noPrompt = 0;
  let printTotal = 0;
  let printNoTurnDuration = 0;
  for (const s of sessions.values()) {
    const isPrint = s.facets.entrypoint === 'sdk-cli';
    if (isPrint) {
      printTotal += 1;
      if (!s.mainLines.some((l) => l.line_type === 'system' && l.subtype === 'turn_duration')) printNoTurnDuration += 1;
    }
    const found = lastTurnStopEntries(s.mainLines);
    if (!found) { noPrompt += 1; continue; }
    groups.all.push(found);
    (isPrint ? groups.print : groups.interactive).push(found);
  }
  const buckets = { below: 0, atOrAbove: 0, unknown: 0 };
  const perVersion = new Map();
  for (const r of repos) {
    const v = parseVersion(r.hook_version);
    const label = v ? v.join('.') : 'unknown';
    perVersion.set(label, (perVersion.get(label) || 0) + 1);
    if (!v) buckets.unknown += 1;
    else if (compareVersionArrays(v, HOOK_FLUSH_VERSION) < 0) buckets.below += 1;
    else buckets.atOrAbove += 1;
  }
  return { groups, noPrompt, printTotal, printNoTurnDuration, buckets, perVersion };
}

// ---------------------------------------------------------------------------------------------
// Rendering

function loadConsumers() {
  if (!fs.existsSync(consumersFile)) return {};
  const text = fs.readFileSync(consumersFile, 'utf8').trim();
  if (!text) return {};
  const map = JSON.parse(text);
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('consumers.json must be an object');
  return map;
}

function payloadText(t) {
  const keys = [...t.keys.entries()].sort((a, b) => (b[1] - a[1]) || cmp(a[0], b[0])).map(([k]) => k);
  if (keys.length === 0) return '—';
  const shown = keys.slice(0, 12).map((k) => `\`${safeLabel(k)}\``).join(', ');
  return keys.length > 12 ? `${shown}, +${keys.length - 12} more` : shown;
}

function render(ctx) {
  const { until, sessions, subSessionCount, lines, agg, consumers, stop } = ctx;
  const out = [];
  const mainLineCount = lines.filter((l) => l.log_type === 'claude').length;
  out.push('# Harness entries survey — generated table');
  out.push('');
  out.push('> Generated by `research/survey/scan.mjs` from `research/survey/consumers.json`. Do not edit by hand:');
  out.push('> fix the script or the map and re-run with the same cutoff.');
  out.push('');
  out.push(`- **Cutoff** (\`LOGHUB_SURVEY_UNTIL\`): \`${mdCell(until)}\``);
  out.push(`- **Sample:** ${sessions.size} root sessions, ${subSessionCount} sub-agent sessions attributed to them, ${lines.length} transcript lines (${mainLineCount} main, ${lines.length - mainLineCount} sub-agent).`);
  out.push('- **Count / sessions:** entries, and root sessions with at least one (sub-agent lines count for their root session).');
  out.push('- **Line chars:** characters of the whole JSON line (`length(elem::text)`), median · p95 · max. Not the characters that reached the model context.');
  out.push('- **Payload:** field names only (attachment fields, or line fields outside the common envelope), most frequent first.');
  out.push(`- Facet cells with 1–${MASK_BELOW - 1} sessions print \`n < 3\`. Facets are defined in impl-plan.md Design Decision 4; hooks are hooks seen running, not hooks configured.`);
  out.push('');

  // Main table.
  out.push('## Entry types');
  out.push('');
  out.push('| Entry | Kind | Count / sessions | Line chars | Payload | Producer | Read by Log Hub today (client parser, anatomy, Raw Logs renderer, server extractor, DB table) |');
  out.push('|---|---|---|---|---|---|---|');
  const keys = new Set([...agg.types.keys(), ...Object.keys(consumers)]);
  for (const key of [...keys].sort(cmp)) {
    const t = agg.types.get(key);
    const c = consumers[key];
    const entry = `\`${mdCell(key)}\`${c && c.kbOnly ? ' (KB only)' : ''}`;
    const producer = c && c.producer ? mdCell(c.producer) : '—';
    const readBy = c && Array.isArray(c.consumers) && c.consumers.length ? mdCell(c.consumers.join('; ')) : (c ? 'none' : 'none — new');
    if (!t) {
      out.push(`| ${entry} | ${kindOfKey(key)} | rare / setup-dependent | — | — | ${producer} | ${readBy} |`);
      continue;
    }
    const chars = t.chars.slice().sort((a, b) => a - b);
    const charsText = `${percentile(chars, 50)} · ${percentile(chars, 95)} · ${chars[chars.length - 1]}`;
    out.push(`| ${entry} | ${t.kind} | ${t.count} / ${t.sessions.size} | ${charsText} | ${payloadText(t)} | ${producer} | ${readBy} |`);
    if (key === 'diagnostics') {
      for (const src of [...agg.diag.keys()].sort(cmp)) {
        const d = agg.diag.get(src);
        out.push(`| ↳ \`diagnostics\` · source \`${mdCell(src)}\` | attachment | ${d.entries} / ${d.sessions.size} (${d.items} items) | — | — | — | — |`);
      }
    }
  }
  out.push('');

  // Facet matrix: sessions per facet value.
  const values = facetValues(sessions);
  out.push('## Facet matrix (root sessions per facet value)');
  out.push('');
  out.push('| Facet | Value | Sessions |');
  out.push('|---|---|---|');
  for (const f of FACETS) {
    const counts = values.get(f.id);
    for (const v of [...counts.keys()].sort(f.sort || cmp)) {
      out.push(`| ${f.title} | ${mdCell(v)} | ${sessionsText(counts.get(v))} |`);
    }
  }
  out.push('');

  // Per-facet matrices: entry type × facet value.
  out.push('## Entry types per facet value (count / sessions)');
  out.push('');
  out.push(`At most ${MAX_FACET_COLUMNS} columns per facet: when a facet has more values, the ${MAX_FACET_COLUMNS - 1} with the most sessions are kept and the rest are merged into "other values".`);
  out.push('');
  const typeKeys = [...agg.types.keys()].sort(cmp);
  const diagKeys = [...agg.diag.keys()].sort(cmp);
  for (const f of FACETS) {
    const counts = values.get(f.id);
    const { columns, other } = chooseColumns(f, counts);
    const head = columns.map((v) => `${mdCell(v)} (${sessionsText(counts.get(v))})`);
    if (other.length) head.push(`other values (${other.length})`);
    const byRow = agg.facetCells.get(f.id);
    out.push(`### ${f.title}`);
    out.push('');
    out.push(`| Entry | ${head.join(' | ')} |`);
    out.push(`|---|${head.map(() => '---').join('|')}|`);
    const rowFor = (rowKey, label) => {
      const cells = columns.map((v) => cellText(byRow.get(`${rowKey}\u0001${v}`)));
      if (other.length) cells.push(cellText(mergeCells(byRow, rowKey, other)));
      out.push(`| ${label} | ${cells.join(' | ')} |`);
    };
    for (const key of typeKeys) {
      rowFor(key, `\`${mdCell(key)}\``);
      if (key === 'diagnostics') {
        for (const src of diagKeys) rowFor(`${key}\u0000${src}`, `↳ source \`${mdCell(src)}\``);
      }
    }
    out.push('');
  }

  // Stop-time section.
  const { groups } = stop;
  const missing = (list, field) => list.filter((g) => !g[field]).length;
  const none = (list) => list.filter((g) => !g.turnDuration && !g.stopHookSummary && !g.stopHookSuccess).length;
  out.push('## Stop-time entries');
  out.push('');
  out.push('The last turn of a root session is the main-transcript lines at or after its last user prompt (impl-plan.md Design Decision 7). Stop-time entries are written after Stop fires, so a missing one means the entry was not uploaded (no later upload, no SessionEnd flush) or was not produced.');
  out.push('');
  out.push(`| Last turn lacks | All root sessions with a prompt (${groups.all.length}) | Interactive (${groups.interactive.length}) | \`claude -p\` (${groups.print.length}) |`);
  out.push('|---|---|---|---|');
  out.push(`| \`system:turn_duration\` | ${missing(groups.all, 'turnDuration')} | ${missing(groups.interactive, 'turnDuration')} | ${missing(groups.print, 'turnDuration')} |`);
  out.push(`| \`system:stop_hook_summary\` | ${missing(groups.all, 'stopHookSummary')} | ${missing(groups.interactive, 'stopHookSummary')} | ${missing(groups.print, 'stopHookSummary')} |`);
  out.push(`| \`hook_success\` of a Stop hook | ${missing(groups.all, 'stopHookSuccess')} | ${missing(groups.interactive, 'stopHookSuccess')} | ${missing(groups.print, 'stopHookSuccess')} |`);
  out.push(`| all three | ${none(groups.all)} | ${none(groups.interactive)} | ${none(groups.print)} |`);
  out.push('');
  out.push(`- Root sessions without any user prompt line (not counted above): ${stop.noPrompt}.`);
  out.push(`- \`claude -p\` sessions (\`entrypoint = sdk-cli\`) without any \`system:turn_duration\`: ${stop.printNoTurnDuration} of ${stop.printTotal}.`);
  out.push('');
  out.push('### Repositories per current hook version');
  out.push('');
  out.push('`repositories.hook_version` is the latest version that reported for a repository; no per-session hook version is stored. The SessionEnd flush needs hook ≥ 2.8.0.');
  out.push('');
  out.push('| Bucket | Repositories |');
  out.push('|---|---|');
  out.push(`| < 2.8.0 | ${stop.buckets.below} |`);
  out.push(`| ≥ 2.8.0 | ${stop.buckets.atOrAbove} |`);
  out.push(`| unknown | ${stop.buckets.unknown} |`);
  out.push('');
  out.push('| hook_version | Repositories |');
  out.push('|---|---|');
  for (const v of [...stop.perVersion.keys()].sort(compareVersionLabels)) {
    out.push(`| ${mdCell(v)} | ${stop.perVersion.get(v)} |`);
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Main

try {
  const until = (process.env.LOGHUB_SURVEY_UNTIL || '').trim();
  if (!until) throw new Error('LOGHUB_SURVEY_UNTIL is required (an ISO timestamp, e.g. 2026-11-11T00:00:00Z)');
  if (!/^\d{4}-\d{2}-\d{2}/.test(until) || Number.isNaN(Date.parse(until))) {
    throw new Error(`LOGHUB_SURVEY_UNTIL is not an ISO timestamp: ${until}`);
  }
  const container = (process.env.LOGHUB_SURVEY_DB_CONTAINER || '').trim() || 'artisyn-log-hub-db';
  const repoRoot = findRepoRoot(scriptDir);
  const rawDir = path.join(repoRoot, 'tmp', 'harness-survey');
  fs.mkdirSync(rawDir, { recursive: true });

  const sections = loadSections(fs.readFileSync(sqlFile, 'utf8'));

  const rootsCsv = psql(container, sections.roots, until, '{}');
  fs.writeFileSync(path.join(rawDir, 'roots.csv'), rootsCsv, 'utf8');
  const rootIds = parseCsv(rootsCsv).records.map((r) => r.root_id);
  if (rootIds.length < MIN_SESSIONS) {
    throw new Error(`only ${rootIds.length} root sessions up to ${until}; the survey needs at least ${MIN_SESSIONS}`);
  }
  process.stderr.write(`${rootIds.length} root sessions up to ${until}\n`);

  const linesFile = path.join(rawDir, 'lines.csv');
  fs.writeFileSync(linesFile, '', 'utf8');
  const lines = [];
  for (let i = 0; i < rootIds.length; i += BATCH_SIZE) {
    const batch = rootIds.slice(i, i + BATCH_SIZE);
    const csv = psql(container, sections.lines, until, `{${batch.join(',')}}`);
    const { header, records } = parseCsv(csv);
    const body = csv.slice(csv.indexOf('\n') + 1);
    fs.appendFileSync(linesFile, i === 0 ? csv : body, 'utf8');
    if (header.length) for (const r of records) lines.push(r);
    process.stderr.write(`  lines: ${Math.min(i + BATCH_SIZE, rootIds.length)}/${rootIds.length} roots, ${lines.length} lines\n`);
  }

  const reposCsv = psql(container, sections.repos, until, '{}');
  fs.writeFileSync(path.join(rawDir, 'repos.csv'), reposCsv, 'utf8');
  const repos = parseCsv(reposCsv).records;

  // Per-session facets, read from the first line that carries each one (main transcript first).
  const sessions = new Map();
  for (const id of rootIds) sessions.set(id, newSession());
  for (const line of lines) {
    const s = sessions.get(line.root_id);
    if (!s) throw new Error(`line of unknown root session ${line.root_id}`);
    s.lineCount += 1;
    readFacetFields(s, line);
    if (line.log_type === 'claude' && line.session_key === line.root_id) s.mainLines.push(line);
    else s.subSessions.add(line.session_key);
  }
  let subSessionCount = 0;
  for (const s of sessions.values()) {
    s.facets = finishFacets(s);
    subSessionCount += s.subSessions.size;
  }

  const agg = aggregate(lines, sessions);
  const stop = stopTimeStats(sessions, repos);
  const consumers = loadConsumers();

  const rawSessions = [...sessions.entries()].map(([id, s]) => ({
    rootSessionKey: id, lines: s.lineCount, subAgentSessions: s.subSessions.size,
    facets: s.facets, lastTurn: lastTurnStopEntries(s.mainLines),
  }));
  fs.writeFileSync(path.join(rawDir, 'sessions.json'), JSON.stringify(rawSessions, null, 2), 'utf8');

  const md = render({ until, sessions, subSessionCount, lines, agg, consumers, stop });
  fs.writeFileSync(tableFile, md, 'utf8');

  // The facet matrix, also on stderr for a quick look.
  const values = facetValues(sessions);
  process.stderr.write('\nFacet matrix (root sessions per value):\n');
  for (const f of FACETS) {
    const counts = values.get(f.id);
    const parts = [...counts.keys()].sort(f.sort || cmp).map((v) => `${v}: ${sessionsText(counts.get(v))}`);
    process.stderr.write(`  ${f.title}: ${parts.join(', ')}\n`);
  }
  process.stderr.write(`\nwrote ${tableFile}\nraw rows in ${rawDir}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`scan error: ${err.message}\n`);
  process.exit(1);
}
