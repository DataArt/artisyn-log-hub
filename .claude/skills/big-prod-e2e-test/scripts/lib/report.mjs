// Run report: an in-memory model (API changes → "Report model"), the overall / exit-code rules
// and the report.json + index.md + index.html writer (index.html: report-html.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { COMPOSE_PROJECT_PREFIX, STAND_URL } from './config.mjs';
import { renderIndexHtml } from './report-html.mjs';
import { CHECKS } from './verify.mjs';

export function createReport({ stamp, runDir, image, keep = false, standUrl = STAND_URL } = {}) {
  return {
    stamp: stamp ?? null,
    runDir: runDir ?? null,
    image: image ?? null,
    keep: Boolean(keep),
    standUrl,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    overall: 'FAIL',
    infra: [],
    acChecks: [],
    sessions: [],
    cases: [],
    visibility: [],
  };
}

function upsert(list, key, value) {
  const i = list.findIndex((e) => e[key] === value[key]);
  if (i >= 0) list[i] = value;
  else list.push(value);
  return value;
}

function errorText(error) {
  if (error == null) return null;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function recordInfra(report, step, status, error = null, detail = null) {
  return upsert(report.infra, 'step', { step, status, error: errorText(error), detail: detail ?? null });
}

export function recordAc(report, id, status, detail = '') {
  return upsert(report.acChecks, 'id', { id, status, detail: detail ?? '' });
}

/**
 * The verdict's per-field outcome, kept small for report.json: `{ <field>: { status, note } }`.
 * `status` is pass | fail | skipped; `skipped` (cost only) counts as neither pass nor fail.
 */
function fieldSummary(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const out = {};
  for (const [key, f] of Object.entries(fields)) {
    if (!f || typeof f !== 'object') continue;
    out[key] = { status: f.status ?? null, note: f.note ?? '' };
  }
  return out;
}

export function recordSession(report, s) {
  const attempts = Array.isArray(s.attempts) ? s.attempts.length : (s.attempts ?? 0);
  const sessionIds =
    s.sessionIds ?? (Array.isArray(s.attempts) ? s.attempts.map((a) => a.session_id).filter(Boolean) : []);
  const prev = report.sessions.find((e) => e.id === s.id);
  return upsert(report.sessions, 'id', {
    id: s.id,
    title: s.title ?? null,
    repo: s.repo ?? null,
    owner: s.owner ?? null,
    model: s.model ?? null,
    status: s.status,
    attempts,
    sessionIds,
    isolation: s.isolation ?? { status: 'fail', detail: 'not checked' },
    error: s.error ?? null,
    checked: s.checked ?? null,
    // Verifier check ids the session runs (scenario.verifyChecks) and the verdict field outcomes.
    checks: Array.isArray(s.checks) ? [...s.checks] : (prev?.checks ?? []),
    fields: s.fields === undefined ? (prev?.fields ?? null) : fieldSummary(s.fields),
    evidence: Array.isArray(s.evidence) ? s.evidence : [],
    mismatches: Array.isArray(s.mismatches) ? s.mismatches : [],
  });
}

/** Verdict field counts over every session: `skipped` is its own bucket, neither pass nor fail. */
export function fieldCounts(report) {
  const counts = { pass: 0, fail: 0, skipped: 0 };
  for (const s of report.sessions) {
    for (const f of Object.values(s.fields ?? {})) {
      if (Object.prototype.hasOwnProperty.call(counts, f.status)) counts[f.status]++;
    }
  }
  return counts;
}

const FIELD_MARK = Object.freeze({ pass: '✓', fail: '✗', skipped: 'skipped' });

/** "model ✓, cost skipped, bash ✗": one session's verdict fields in check order. */
function fieldsCell(s) {
  const entries = Object.entries(s.fields ?? {});
  if (entries.length === 0) return null;
  return entries.map(([k, f]) => `${k} ${FIELD_MARK[f.status] ?? f.status ?? '?'}`).join(', ');
}

/**
 * A feature check that is neither a session nor a visibility row (`FC`, the file
 * categories check). `problems` are the "what is wrong" lines; `evidence` the screenshots.
 */
export function recordCase(report, c) {
  if (!Array.isArray(report.cases)) report.cases = [];
  return upsert(report.cases, 'id', {
    id: c.id,
    title: c.title ?? null,
    status: c.status,
    detail: c.detail ?? '',
    checked: c.checked ?? null,
    problems: Array.isArray(c.problems) ? c.problems : [],
    evidence: Array.isArray(c.evidence) ? c.evidence : [],
  });
}

export function recordVisibility(report, row) {
  return upsert(report.visibility, 'id', {
    id: row.id,
    viewer: row.viewer ?? null,
    view: row.view ?? null,
    shouldSee: row.shouldSee ?? [],
    shouldNotSee: row.shouldNotSee ?? [],
    prompts: row.prompts ?? null,
    status: row.status,
    detail: row.detail ?? '',
    screenshot: row.screenshot ?? null,
    failScreenshot: row.failScreenshot ?? null,
  });
}

/** PASS only when every infra step, AC check, session and visibility row passed. */
export function computeOverall(report) {
  const ok =
    report.infra.every((r) => r.status === 'pass') &&
    report.acChecks.every((r) => r.status === 'pass') &&
    report.sessions.every((r) => r.status === 'pass') &&
    (report.cases ?? []).every((r) => r.status === 'pass') &&
    report.visibility.every((r) => r.status === 'pass');
  return ok ? 'PASS' : 'FAIL';
}

/** 0 on PASS, 2 on any infra failure, 1 otherwise. */
export function exitCodeFor(report) {
  if (report.infra.some((r) => r.status !== 'pass')) return 2;
  return computeOverall(report) === 'PASS' ? 0 : 1;
}

// ---- Markdown ---------------------------------------------------------------------------------

function cell(v) {
  if (v == null || v === '') return '—';
  const s = Array.isArray(v) ? v.join(', ') || '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of rows) lines.push(`| ${r.map(cell).join(' | ')} |`);
  return lines.join('\n');
}

// Screenshot paths are stored relative to `_report/`; links use forward slashes.
function link(p) {
  const rel = String(p).replace(/\\/g, '/');
  return `[${rel}](${encodeURI(rel)})`;
}

export function standCommands(report) {
  const project = report.stamp ? `${COMPOSE_PROJECT_PREFIX}${report.stamp}` : '<project>';
  const logHub = report.runDir ? path.join(report.runDir, '_log_hub') : '<run-dir>/_log_hub';
  const compose = path.join(logHub, 'docker-compose.yml');
  const env = path.join(logHub, '.env');
  return {
    down: `docker compose -p ${project} -f "${compose}" --env-file "${env}" down`,
    imageRm: report.image ? `docker image rm ${report.image}` : null,
  };
}

export function renderIndexMd(report) {
  const overall = computeOverall(report);
  const out = [];
  out.push(`# Big pre-prod e2e test — ${overall}`);
  out.push('');
  out.push(`- Stamp: \`${report.stamp ?? '—'}\``);
  out.push(`- Run dir: \`${report.runDir ?? '—'}\``);
  out.push(`- Image: \`${report.image ?? '—'}\``);
  out.push(`- Started: ${report.startedAt ?? '—'}; finished: ${report.finishedAt ?? '(running)'}`);
  out.push(`- Keep stand: ${report.keep ? 'yes' : 'no'}`);
  out.push('');

  out.push('## Infra');
  out.push('');
  const infra = [...report.infra.filter((r) => r.status !== 'pass'), ...report.infra.filter((r) => r.status === 'pass')];
  out.push(
    infra.length
      ? table(['Step', 'Status', 'Error / detail'], infra.map((r) => [r.step, r.status, r.error ?? r.detail]))
      : '_No steps recorded._',
  );
  out.push('');

  out.push('## AC checks');
  out.push('');
  out.push(
    report.acChecks.length
      ? table(['AC', 'Status', 'Detail'], report.acChecks.map((r) => [r.id, r.status, r.detail]))
      : '_No AC checks recorded._',
  );
  out.push('');

  out.push('## Sessions');
  out.push('');
  out.push(
    report.sessions.length
      ? table(
          ['Session', 'Repo', 'Owner', 'Model', 'Status', 'Attempts', 'Session ids', 'Isolation', 'Verdict fields'],
          report.sessions.map((s) => [
            s.id,
            s.repo,
            s.owner,
            s.model,
            s.status,
            s.attempts,
            s.sessionIds,
            s.isolation ? `${s.isolation.status}${s.isolation.detail ? `: ${s.isolation.detail}` : ''}` : null,
            fieldsCell(s),
          ]),
        )
      : '_No sessions recorded._',
  );
  out.push('');
  if (report.sessions.some((s) => s.fields)) {
    const c = fieldCounts(report);
    out.push(
      `Verdict fields: ${c.pass} pass, ${c.fail} fail, ${c.skipped} skipped ` +
        '(`skipped` = nothing comparable, e.g. the telemetry cost did not arrive in time; neither pass nor fail).',
    );
    out.push('');
  }

  out.push('## Feature checks');
  out.push('');
  const cases = report.cases ?? [];
  out.push(
    cases.length
      ? table(['Check', 'Title', 'Status', 'Detail'], cases.map((c) => [c.id, c.title, c.status, c.detail]))
      : '_No feature checks recorded._',
  );
  out.push('');

  out.push('## Visibility');
  out.push('');
  out.push(
    report.visibility.length
      ? table(
          ['Row', 'Viewer', 'View', 'Must see', 'Must not see', 'Status', 'Detail', 'Screenshot'],
          report.visibility.map((v) => [
            v.id,
            v.viewer,
            v.view,
            v.shouldSee,
            v.shouldNotSee,
            v.status,
            v.detail,
            v.screenshot ? link(v.screenshot) : null,
          ]),
        )
      : '_No visibility rows recorded._',
  );
  out.push('');

  out.push('## Mismatches');
  out.push('');
  const mism = [];
  for (const s of report.sessions) {
    for (const m of s.mismatches || []) {
      mism.push(`- **${s.id}** \`${m.field}\`: ${m.note || '(no note)'}${m.screenshot ? ` — ${link(m.screenshot)}` : ''}`);
    }
  }
  for (const s of report.sessions) {
    if (s.status !== 'pass' && !(s.mismatches || []).length) {
      mism.push(`- **${s.id}**: ${s.status}${s.error ? ` — ${s.error}` : ''}`);
    }
  }
  for (const c of report.cases ?? []) {
    if (c.status !== 'pass') {
      const problems = c.problems.length ? c.problems.join('; ') : c.detail || '(no detail)';
      mism.push(`- **${c.id}**: ${problems}`);
    }
  }
  for (const v of report.visibility) {
    if (v.status !== 'pass') {
      const shot = v.failScreenshot || v.screenshot;
      mism.push(`- **${v.id}**: ${v.detail || '(no detail)'}${shot ? ` — ${link(shot)}` : ''}`);
    }
  }
  out.push(mism.length ? mism.join('\n') : '_None._');
  out.push('');

  const cmds = standCommands(report);
  out.push('## Stand');
  out.push('');
  out.push(`- URL: ${report.standUrl ?? STAND_URL}${report.keep ? ' (kept running)' : ''}`);
  out.push(`- Stop: \`${cmds.down}\``);
  if (cmds.imageRm) out.push(`- Remove image: \`${cmds.imageRm}\``);
  out.push('');

  out.push(...renderEvidenceGallery(report));
  return out.join('\n');
}

// ---- Evidence gallery (always the last section) -----------------------------------------------

function image(label, p) {
  const rel = String(p).replace(/\\/g, '/');
  return `![${label}](${encodeURI(rel)})`;
}

function inline(v) {
  if (v === undefined) return '—';
  return `\`${JSON.stringify(v)}\``;
}

export function sessionChecked(s) {
  if (s.checked) return s.checked;
  if (s.checks?.length) {
    const skipped = Object.entries(s.fields ?? {})
      .filter(([, f]) => f.status === 'skipped')
      .map(([k]) => k);
    return (
      `UI checks ${s.checks.join(', ')} for session ${(s.sessionIds || []).slice(-1)[0] ?? '—'}; ` +
      `isolation ${s.isolation?.status ?? '—'}${skipped.length ? `; skipped (not judged): ${skipped.join(', ')}` : ''}.`
    );
  }
  return (
    `UI shows the expected model, skills, rules, workflows, subagents, MCP servers and prompt for session ` +
    `${(s.sessionIds || []).slice(-1)[0] ?? '—'}; isolation ${s.isolation?.status ?? '—'}.`
  );
}

function sessionCase(s) {
  const pass = s.status === 'pass';
  const lines = [`### ${pass ? '🟢' : '🔴'} ${s.id} — ${s.title ?? s.repo ?? 'session'} — ${pass ? 'PASS' : 'FAIL'}`, ''];
  const evidence = Array.isArray(s.evidence) ? s.evidence : [];
  const mismatches = Array.isArray(s.mismatches) ? s.mismatches : [];
  if (pass) {
    lines.push(`Checked: ${sessionChecked(s)}`, '');
  } else {
    lines.push('What is wrong:', '');
    lines.push(`- status: \`${s.status}\`${s.error ? ` — ${s.error}` : ''}`);
    if (s.isolation && s.isolation.status !== 'pass') {
      lines.push(`- isolation: ${s.isolation.status}${s.isolation.detail ? ` — ${s.isolation.detail}` : ''}`);
    }
    for (const m of mismatches) {
      lines.push(
        `- \`${m.field}\`: expected ${inline(m.expected)}, observed ${inline(m.observed)}${m.note ? ` — ${m.note}` : ''}`,
      );
    }
    lines.push('');
    for (const m of mismatches) {
      if (m.screenshot) lines.push(image(`${m.field} mismatch`, m.screenshot), '');
    }
  }
  const shown = new Set(pass ? [] : mismatches.map((m) => m.screenshot).filter(Boolean));
  const regular = evidence.filter((e) => e && e.path && !shown.has(e.path));
  lines.push(...checkGalleries(s, regular));
  if (regular.length === 0 && shown.size === 0) {
    lines.push(`_No screenshot: ${s.error || s.status || 'the case produced no evidence'}._`, '');
  }
  return lines;
}

/**
 * Regular evidence grouped per verifier check (`s.checks`; the shot file stems come from CHECKS),
 * each group led by a bold line with the check's field outcomes. Evidence no check claims comes
 * last. Bold lines, not headings: `###` is reserved for the case headings.
 */
function checkGalleries(s, regular) {
  const lines = [];
  for (const g of checkGroups(s, regular)) {
    if (g.id) {
      const outcomes = g.outcomes.map((o) => `${o.field} ${o.status}${o.status === 'skipped' && o.note ? ` (${o.note})` : ''}`);
      lines.push(`**Check \`${g.id}\`**${outcomes.length ? ` — ${outcomes.join('; ')}` : ''}`, '');
    }
    for (const e of g.shots) lines.push(image(e.label || 'evidence', e.path), '');
  }
  return lines;
}

/**
 * `regular` evidence split per verifier check: `[{ id, outcomes: [{ field, status, note }], shots }]`
 * in `s.checks` order, then `{ id: null, outcomes: [], shots }` for evidence no check claims.
 * Shared by the index.md and index.html renderers.
 */
export function checkGroups(s, regular) {
  const groups = [];
  const left = [...regular];
  const take = (stem) => {
    const i = left.findIndex((e) => e.label === stem);
    return i >= 0 ? left.splice(i, 1)[0] : null;
  };
  for (const id of s.checks ?? []) {
    const def = CHECKS[id];
    if (!def) continue;
    const shots = def.shots.map((f) => take(f.replace(/\.[^.]+$/, ''))).filter(Boolean);
    const outcomes = def.fields
      .filter((k) => s.fields?.[k])
      .map((k) => ({ field: k, status: s.fields[k].status, note: s.fields[k].note ?? '' }));
    if (shots.length === 0 && outcomes.length === 0) continue;
    groups.push({ id, outcomes, shots });
  }
  if (left.length) groups.push({ id: null, outcomes: [], shots: left });
  return groups;
}

function featureCase(c) {
  const pass = c.status === 'pass';
  const lines = [`### ${pass ? '🟢' : '🔴'} ${c.id} — ${c.title ?? 'check'} — ${pass ? 'PASS' : 'FAIL'}`, ''];
  if (pass) {
    lines.push(`Checked: ${c.checked || c.detail || 'as specified'}`, '');
  } else {
    lines.push('What is wrong:', '');
    const problems = c.problems.length ? c.problems : [c.detail || '(no detail)'];
    for (const p of problems) lines.push(`- ${p}`);
    lines.push('');
  }
  const evidence = (c.evidence || []).filter((e) => e && e.path);
  for (const e of evidence) lines.push(image(e.label || 'evidence', e.path), '');
  if (evidence.length === 0) lines.push(`_No screenshot: ${c.detail || 'the check produced no evidence'}._`, '');
  return lines;
}

function visibilityCase(v) {
  const pass = v.status === 'pass';
  const lines = [`### ${pass ? '🟢' : '🔴'} ${v.id} — ${v.viewer ?? '—'} ${v.view ?? ''} — ${pass ? 'PASS' : 'FAIL'}`, ''];
  if (pass) {
    lines.push(`Checked: ${v.detail || 'visibility as specified'}`, '');
  } else {
    lines.push('What is wrong:', '', `- ${v.detail || '(no detail)'}`, '');
    if (v.failScreenshot) lines.push(image(`${v.id} failure`, v.failScreenshot), '');
  }
  if (v.screenshot) lines.push(image(v.id, v.screenshot), '');
  if (!v.screenshot && !(!pass && v.failScreenshot)) {
    lines.push(`_No screenshot: ${v.detail || 'the row produced no evidence'}._`, '');
  }
  return lines;
}

function renderEvidenceGallery(report) {
  const out = ['## Evidence', ''];
  const cases = report.cases ?? [];
  if (report.sessions.length === 0 && cases.length === 0 && report.visibility.length === 0) {
    out.push('_No cases were checked._', '');
    return out;
  }
  for (const s of report.sessions) out.push(...sessionCase(s));
  for (const c of cases) out.push(...featureCase(c));
  for (const v of report.visibility) out.push(...visibilityCase(v));
  return out;
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** Recomputes `overall`, then writes report.json, index.md and index.html into `reportDir`. */
export function writeReport(report, reportDir) {
  report.overall = computeOverall(report);
  fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'report.json');
  const mdPath = path.join(reportDir, 'index.md');
  const htmlPath = path.join(reportDir, 'index.html');
  writeAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeAtomic(mdPath, renderIndexMd(report));
  writeAtomic(htmlPath, renderIndexHtml(report));
  return { jsonPath, mdPath, htmlPath };
}
