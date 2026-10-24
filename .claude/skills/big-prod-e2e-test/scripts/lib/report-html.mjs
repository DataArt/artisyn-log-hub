// index.html: the same report model as index.md, rendered as one self-contained page (inline CSS
// and JS, no network). Screenshots are <img> tags with paths relative to `_report/`, so opening
// `_report/index.html` in a browser shows every evidence picture inline; a click enlarges it.
import { STAND_URL } from './config.mjs';
import { checkGroups, computeOverall, fieldCounts, sessionChecked, standCommands } from './report.mjs';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function text(v) {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// Screenshot paths are stored relative to `_report/`; URLs use forward slashes.
function src(p) {
  return encodeURI(String(p).replace(/\\/g, '/'));
}

function statusClass(status) {
  if (status === 'pass') return 'pass';
  if (status === 'skipped') return 'skip';
  if (status == null) return 'none';
  return 'fail';
}

function pill(status, label = status) {
  return `<span class="pill ${statusClass(status)}">${esc(label ?? '—')}</span>`;
}

function anchor(id) {
  return `case-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function caseLink(id) {
  return `<a href="#${anchor(id)}">${esc(id)}</a>`;
}

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function shot(label, p) {
  return (
    `<figure><a class="shot" href="${src(p)}" target="_blank" rel="noopener">` +
    `<img loading="lazy" src="${src(p)}" alt="${esc(label)}"></a>` +
    `<figcaption>${esc(label)}</figcaption></figure>`
  );
}

function gallery(items) {
  return items.length ? `<div class="gallery">${items.map((e) => shot(e.label, e.path)).join('')}</div>` : '';
}

function failedFirst(list) {
  return [...list.filter((r) => r.status !== 'pass'), ...list.filter((r) => r.status === 'pass')];
}

// ---- Summary ----------------------------------------------------------------------------------

function tile(title, list, href) {
  const failed = list.filter((r) => r.status !== 'pass').length;
  const cls = list.length === 0 ? 'none' : failed ? 'fail' : 'pass';
  return (
    `<a class="tile ${cls}" href="#${href}"><span class="tile-title">${esc(title)}</span>` +
    `<span class="tile-num">${list.length - failed}/${list.length}</span>` +
    `<span class="tile-sub">${failed ? `${failed} failed` : list.length ? 'all pass' : 'none recorded'}</span></a>`
  );
}

/** One entry per failing item, with its reason and the screenshot that shows it. */
function failures(report) {
  const items = [];
  for (const r of report.infra) {
    if (r.status !== 'pass') items.push({ kind: 'Infra', id: r.step, reason: r.error ?? r.detail, shots: [] });
  }
  for (const r of report.acChecks) {
    if (r.status !== 'pass') items.push({ kind: 'AC', id: r.id, reason: r.detail, shots: [] });
  }
  for (const s of report.sessions) {
    if (s.status === 'pass') continue;
    const mism = s.mismatches || [];
    const reason = mism.length
      ? mism.map((m) => `${m.field}: ${m.note || 'mismatch'}`).join('; ')
      : `${s.status}${s.error ? ` — ${s.error}` : ''}`;
    items.push({
      kind: 'Session',
      id: s.id,
      link: true,
      reason,
      shots: mism.filter((m) => m.screenshot).map((m) => ({ label: `${m.field} mismatch`, path: m.screenshot })),
    });
  }
  for (const c of report.cases ?? []) {
    if (c.status === 'pass') continue;
    items.push({ kind: 'Feature', id: c.id, link: true, reason: c.problems.length ? c.problems.join('; ') : c.detail, shots: [] });
  }
  for (const v of report.visibility) {
    if (v.status === 'pass') continue;
    const p = v.failScreenshot || v.screenshot;
    items.push({ kind: 'Visibility', id: v.id, link: true, reason: v.detail, shots: p ? [{ label: `${v.id} failure`, path: p }] : [] });
  }
  return items;
}

function renderFailures(report) {
  const items = failures(report);
  if (!items.length) return '<p class="ok-note">Nothing failed.</p>';
  return `<ul class="failures">${items
    .map(
      (f) =>
        `<li><div class="f-head"><span class="kind">${esc(f.kind)}</span> ` +
        `<strong>${f.link ? caseLink(f.id) : esc(f.id)}</strong></div>` +
        `<div class="f-reason">${esc(text(f.reason))}</div>${gallery(f.shots)}</li>`,
    )
    .join('\n')}</ul>`;
}

// ---- Tables -----------------------------------------------------------------------------------

function fieldPills(s) {
  const entries = Object.entries(s.fields ?? {});
  if (!entries.length) return '—';
  return entries.map(([k, f]) => pill(f.status, k)).join(' ');
}

function sessionsTable(report) {
  if (!report.sessions.length) return '<p class="muted">No sessions recorded.</p>';
  const rows = report.sessions.map((s) => [
    caseLink(s.id),
    esc(text(s.title)),
    esc(text(s.repo)),
    esc(text(s.owner)),
    esc(text(s.model)),
    pill(s.status),
    esc(text(s.attempts)),
    `<code>${esc(text(s.sessionIds))}</code>`,
    s.isolation ? `${pill(s.isolation.status)} ${esc(s.isolation.detail ?? '')}` : '—',
    fieldPills(s),
  ]);
  let out = table(['Session', 'Title', 'Repo', 'Owner', 'Model', 'Status', 'Attempts', 'Session ids', 'Isolation', 'Verdict fields'], rows);
  if (report.sessions.some((s) => s.fields)) {
    const c = fieldCounts(report);
    out +=
      `<p class="muted">Verdict fields: ${c.pass} pass, ${c.fail} fail, ${c.skipped} skipped ` +
      '(skipped = nothing comparable, e.g. the telemetry cost did not arrive in time; neither pass nor fail).</p>';
  }
  return out;
}

function visibilityTable(report) {
  if (!report.visibility.length) return '<p class="muted">No visibility rows recorded.</p>';
  return table(
    ['Row', 'Viewer', 'View', 'Must see', 'Must not see', 'Status', 'Detail'],
    report.visibility.map((v) => [
      caseLink(v.id),
      esc(text(v.viewer)),
      esc(text(v.view)),
      esc(text(v.shouldSee)),
      esc(text(v.shouldNotSee)),
      pill(v.status),
      esc(text(v.detail)),
    ]),
  );
}

// ---- Evidence ---------------------------------------------------------------------------------

function caseHead(id, title, status) {
  const pass = status === 'pass';
  return `<h3>${pill(status, pass ? 'PASS' : 'FAIL')} ${esc(id)} — ${esc(title)}</h3>`;
}

function wrong(lines) {
  return `<div class="wrong"><strong>What is wrong</strong><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>`;
}

function sessionCase(s) {
  const pass = s.status === 'pass';
  const evidence = (s.evidence || []).filter((e) => e && e.path);
  const mismatches = s.mismatches || [];
  const out = [caseHead(s.id, s.title ?? s.repo ?? 'session', s.status)];
  if (pass) {
    out.push(`<p class="checked">Checked: ${esc(sessionChecked(s))}</p>`);
  } else {
    const lines = [`status: <code>${esc(s.status)}</code>${s.error ? ` — ${esc(s.error)}` : ''}`];
    if (s.isolation && s.isolation.status !== 'pass') {
      lines.push(`isolation: ${esc(s.isolation.status)}${s.isolation.detail ? ` — ${esc(s.isolation.detail)}` : ''}`);
    }
    for (const m of mismatches) {
      lines.push(
        `<code>${esc(m.field)}</code>: expected <code>${esc(JSON.stringify(m.expected))}</code>, ` +
          `observed <code>${esc(JSON.stringify(m.observed))}</code>${m.note ? ` — ${esc(m.note)}` : ''}`,
      );
    }
    out.push(wrong(lines));
    out.push(gallery(mismatches.filter((m) => m.screenshot).map((m) => ({ label: `${m.field} mismatch`, path: m.screenshot }))));
  }
  const shown = new Set(pass ? [] : mismatches.map((m) => m.screenshot).filter(Boolean));
  const regular = evidence.filter((e) => !shown.has(e.path));
  for (const g of checkGroups(s, regular)) {
    if (g.id) {
      const outcomes = g.outcomes
        .map((o) => `${pill(o.status, o.field)}${o.status !== 'pass' && o.note ? ` <span class="note">${esc(o.note)}</span>` : ''}`)
        .join(' ');
      out.push(`<h4>Check <code>${esc(g.id)}</code> ${outcomes}</h4>`);
    } else {
      out.push('<h4>Other evidence</h4>');
    }
    out.push(gallery(g.shots));
  }
  if (regular.length === 0 && shown.size === 0) {
    out.push(`<p class="muted">No screenshot: ${esc(s.error || s.status || 'the case produced no evidence')}.</p>`);
  }
  return out;
}

function featureCase(c) {
  const pass = c.status === 'pass';
  const out = [caseHead(c.id, c.title ?? 'check', c.status)];
  if (pass) out.push(`<p class="checked">Checked: ${esc(c.checked || c.detail || 'as specified')}</p>`);
  else out.push(wrong((c.problems.length ? c.problems : [c.detail || '(no detail)']).map(esc)));
  const evidence = (c.evidence || []).filter((e) => e && e.path);
  out.push(gallery(evidence));
  if (!evidence.length) out.push(`<p class="muted">No screenshot: ${esc(c.detail || 'the check produced no evidence')}.</p>`);
  return out;
}

function visibilityCase(v) {
  const pass = v.status === 'pass';
  const out = [caseHead(v.id, `${v.viewer ?? '—'} ${v.view ?? ''}`, v.status)];
  const shots = [];
  if (pass) out.push(`<p class="checked">Checked: ${esc(v.detail || 'visibility as specified')}</p>`);
  else {
    out.push(wrong([esc(v.detail || '(no detail)')]));
    if (v.failScreenshot) shots.push({ label: `${v.id} failure`, path: v.failScreenshot });
  }
  if (v.screenshot) shots.push({ label: v.id, path: v.screenshot });
  out.push(gallery(shots));
  if (!shots.length) out.push(`<p class="muted">No screenshot: ${esc(v.detail || 'the row produced no evidence')}.</p>`);
  return out;
}

function caseSection(id, status, lines) {
  const cls = status === 'pass' ? 'pass' : 'fail';
  return `<section class="case ${cls}" id="${anchor(id)}">\n${lines.filter(Boolean).join('\n')}\n</section>`;
}

function renderEvidence(report) {
  const cases = report.cases ?? [];
  if (!report.sessions.length && !cases.length && !report.visibility.length) return '<p class="muted">No cases were checked.</p>';
  return [
    ...report.sessions.map((s) => caseSection(s.id, s.status, sessionCase(s))),
    ...cases.map((c) => caseSection(c.id, c.status, featureCase(c))),
    ...report.visibility.map((v) => caseSection(v.id, v.status, visibilityCase(v))),
  ].join('\n');
}

// ---- Page -------------------------------------------------------------------------------------

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#5f6b7a;--line:#dde2e8;--pass:#1f7a3f;--pass-bg:#e3f4e8;
--fail:#b42318;--fail-bg:#fde7e5;--skip:#8a5a00;--skip-bg:#fff2d6;--none:#5f6b7a;--none-bg:#eceff3;--link:#1f5fbf;--code:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--fg:#e4e8ee;--muted:#9aa5b3;--line:#323844;
--pass:#6fd394;--pass-bg:#173523;--fail:#ff8a7e;--fail-bg:#3e1c1a;--skip:#f2c26b;--skip-bg:#3a2e14;--none:#9aa5b3;--none-bg:#2a2f38;--link:#7fb0ff;--code:#272c35}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--link)}
code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:12.5px;word-break:break-word}
nav{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:8px 16px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
nav a{text-decoration:none;font-weight:500}
nav label{margin-left:auto;color:var(--muted);cursor:pointer;user-select:none}
main{max-width:1400px;margin:0 auto;padding:16px}
h1{margin:8px 0 4px;font-size:24px;display:flex;gap:10px;align-items:center}
h2{margin:28px 0 10px;font-size:19px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{margin:0 0 8px;font-size:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
h4{margin:14px 0 6px;font-size:13.5px;font-weight:600;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.meta{color:var(--muted);margin:0 0 12px;display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}
.meta dt{font-weight:600}.meta dd{margin:0;word-break:break-all}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.pass{color:var(--pass);background:var(--pass-bg)}.pill.fail{color:var(--fail);background:var(--fail-bg)}
.pill.skip{color:var(--skip);background:var(--skip-bg)}.pill.none{color:var(--none);background:var(--none-bg)}
.badge{font-size:15px;padding:3px 12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
.tile{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-left:5px solid var(--none);border-radius:8px;padding:10px 12px;text-decoration:none;color:var(--fg)}
.tile.pass{border-left-color:var(--pass)}.tile.fail{border-left-color:var(--fail)}
.tile-title{color:var(--muted);font-size:12.5px}.tile-num{font-size:22px;font-weight:700}.tile-sub{font-size:12.5px}
.tile.fail .tile-sub{color:var(--fail)}
.failures{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.failures li{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--fail);border-radius:8px;padding:8px 12px}
.kind{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.f-reason{margin-top:2px;word-break:break-word}
.ok-note{color:var(--pass);font-weight:600}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12.5px;color:var(--muted);font-weight:600;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
td{word-break:break-word;max-width:520px}
.muted{color:var(--muted)}
.case{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--pass);border-radius:8px;padding:12px 14px;margin:0 0 14px;scroll-margin-top:56px}
.case.fail{border-left-color:var(--fail)}
.checked{margin:0 0 6px;color:var(--muted)}
.wrong{background:var(--fail-bg);border-radius:6px;padding:8px 12px;margin:0 0 10px}
.wrong ul{margin:4px 0 0;padding-left:18px}
.note{color:var(--muted);font-weight:400;font-size:12.5px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(460px,1fr));gap:10px;margin:6px 0 4px}
figure{margin:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--bg)}
figure img{display:block;width:100%;height:auto;max-height:420px;object-fit:contain;object-position:top;cursor:zoom-in}
figcaption{font-size:12px;color:var(--muted);padding:3px 8px;border-top:1px solid var(--line)}
body.only-failed .case.pass{display:none}
dialog{border:0;padding:0;max-width:96vw;max-height:96vh;background:transparent}
dialog::backdrop{background:rgba(0,0,0,.8)}
dialog img{display:block;max-width:96vw;max-height:90vh;cursor:zoom-out}
dialog p{margin:6px 0 0;color:#fff;text-align:center}
@media (max-width:600px){.gallery{grid-template-columns:1fr}main{padding:12px}}
`;

const JS = `
const dlg=document.getElementById('lb');
document.addEventListener('click',e=>{const a=e.target.closest('a.shot');if(!a||!dlg.showModal)return;e.preventDefault();
dlg.querySelector('img').src=a.getAttribute('href');dlg.querySelector('p').textContent=a.querySelector('img').alt;dlg.showModal();});
dlg.addEventListener('click',()=>dlg.close());
const cb=document.getElementById('only-failed');cb.addEventListener('change',()=>document.body.classList.toggle('only-failed',cb.checked));
`;

export function renderIndexHtml(report) {
  const overall = computeOverall(report);
  const cases = report.cases ?? [];
  const cmds = standCommands(report);
  const failedSessions = report.sessions.filter((s) => s.status !== 'pass').length;
  const out = [];
  out.push('<!doctype html>', '<html lang="en"><head><meta charset="utf-8">');
  out.push('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">');
  out.push(`<title>Big test ${esc(report.stamp ?? '')} — ${overall}</title>`);
  out.push(`<style>${CSS}</style></head>`);
  out.push('<body>');
  out.push(
    '<nav><a href="#summary">Summary</a><a href="#failures">Failures</a><a href="#infra">Infra</a>' +
      '<a href="#ac">AC checks</a><a href="#sessions">Sessions</a><a href="#features">Feature checks</a>' +
      '<a href="#visibility">Visibility</a><a href="#stand">Stand</a><a href="#evidence">Evidence</a>' +
      '<label><input type="checkbox" id="only-failed"> evidence: failed only</label></nav>',
  );
  out.push('<main>');
  out.push(`<h1 id="summary">Big pre-prod e2e test ${pill(overall === 'PASS' ? 'pass' : 'fail', overall).replace('class="pill', 'class="pill badge')}</h1>`);
  out.push('<dl class="meta">');
  for (const [k, v] of [
    ['Stamp', report.stamp],
    ['Run dir', report.runDir],
    ['Image', report.image],
    ['Started', report.startedAt],
    ['Finished', report.finishedAt ?? '(running)'],
    ['Keep stand', report.keep ? 'yes' : 'no'],
  ]) {
    out.push(`<dt>${esc(k)}</dt><dd>${esc(text(v))}</dd>`);
  }
  out.push('</dl>');
  out.push(
    `<div class="tiles">${tile('Infra', report.infra, 'infra')}${tile('AC checks', report.acChecks, 'ac')}` +
      `${tile('Sessions', report.sessions, 'sessions')}${tile('Feature checks', cases, 'features')}` +
      `${tile('Visibility', report.visibility, 'visibility')}</div>`,
  );

  out.push(`<h2 id="failures">Failures</h2>`, renderFailures(report));

  out.push('<h2 id="infra">Infra</h2>');
  out.push(
    report.infra.length
      ? table(['Step', 'Status', 'Error / detail'], failedFirst(report.infra).map((r) => [esc(r.step), pill(r.status), esc(text(r.error ?? r.detail))]))
      : '<p class="muted">No steps recorded.</p>',
  );
  out.push('<h2 id="ac">AC checks</h2>');
  out.push(
    report.acChecks.length
      ? table(['AC', 'Status', 'Detail'], report.acChecks.map((r) => [esc(r.id), pill(r.status), esc(text(r.detail))]))
      : '<p class="muted">No AC checks recorded.</p>',
  );
  out.push(`<h2 id="sessions">Sessions${failedSessions ? ` <span class="muted">(${failedSessions} failed)</span>` : ''}</h2>`, sessionsTable(report));
  out.push('<h2 id="features">Feature checks</h2>');
  out.push(
    cases.length
      ? table(['Check', 'Title', 'Status', 'Detail'], cases.map((c) => [caseLink(c.id), esc(text(c.title)), pill(c.status), esc(text(c.detail))]))
      : '<p class="muted">No feature checks recorded.</p>',
  );
  out.push('<h2 id="visibility">Visibility</h2>', visibilityTable(report));

  out.push('<h2 id="stand">Stand</h2><ul>');
  out.push(`<li>URL: ${esc(report.standUrl ?? STAND_URL)}${report.keep ? ' (kept running)' : ''}</li>`);
  out.push(`<li>Stop: <code>${esc(cmds.down)}</code></li>`);
  if (cmds.imageRm) out.push(`<li>Remove image: <code>${esc(cmds.imageRm)}</code></li>`);
  out.push('</ul>');

  out.push('<h2 id="evidence">Evidence</h2>', renderEvidence(report));
  out.push('</main>');
  out.push('<dialog id="lb"><img alt=""><p></p></dialog>');
  out.push(`<script>${JS}</script>`);
  out.push('</body></html>', '');
  return out.join('\n');
}
