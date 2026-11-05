#!/usr/bin/env node
// Morning check — result of the nightly security-scans run (published to the ci-reports branch),
// compared with the last result this check has seen (tmp/morning-check/nightly-scan.json), or, on
// the first run, with the previous ci-reports commit.
// Usage: node nightly-scan.js [--save]   (--save stores the current result as "seen")
// Output: JSON on stdout: run status, worsened/improved rows, new/resolved Snyk issues, staleness.
const { REPO, ghJson, tryGhJson, readFileFromBranch, readState, writeState, hasFlag } = require('./lib');

const STATE_FILE = 'nightly-scan.json';
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const STATUS_RANK = { pass: 0, skipped: 0, neutral: 1, pending: 1, warning: 2, findings: 3, error: 3 };

function loadAt(ref) {
  return {
    results: JSON.parse(readFileFromBranch('security-scan-results.json', ref)),
    issues: JSON.parse(readFileFromBranch('snyk-issues.json', ref)),
  };
}

function issueKeys(issues) {
  const map = {};
  for (const [scope, list] of Object.entries(issues || {})) {
    for (const i of list) map[`${scope}|${i.id}|${i.package}@${i.version}|${i.project || ''}`] = Object.assign({ scope }, i);
  }
  return map;
}

function compareRows(curRows, prevRows) {
  const prevBy = Object.fromEntries((prevRows || []).map((r) => [`${r.tool}/${r.scope}`, r]));
  const worsened = [];
  const improved = [];
  for (const r of curRows) {
    const p = prevBy[`${r.tool}/${r.scope}`];
    if (!p) {
      worsened.push({ row: `${r.tool}/${r.scope}`, label: r.label, change: 'new row', status: r.status, counts: r.counts, note: r.note });
      continue;
    }
    const countUp = SEVERITIES.filter((s) => (r.counts[s] || 0) > (p.counts[s] || 0));
    const countDown = SEVERITIES.filter((s) => (r.counts[s] || 0) < (p.counts[s] || 0));
    const rankDiff = (STATUS_RANK[r.status] || 0) - (STATUS_RANK[p.status] || 0);
    const entry = { row: `${r.tool}/${r.scope}`, label: r.label, from: { status: p.status, counts: p.counts }, to: { status: r.status, counts: r.counts }, note: r.note, link: r.link };
    if (rankDiff > 0 || countUp.length) worsened.push(entry);
    else if (rankDiff < 0 || countDown.length) improved.push(entry);
  }
  return { worsened, improved };
}

function main() {
  const cur = loadAt('ci-reports');
  const seen = readState(STATE_FILE);
  let baseline;
  let baselineSource;
  if (seen) {
    baseline = seen;
    baselineSource = `last morning check (${seen.results.date})`;
  } else {
    const commits = ghJson(`repos/${REPO}/commits?sha=ci-reports&per_page=2`);
    baseline = commits.length > 1 ? loadAt(commits[1].sha) : null;
    baselineSource = baseline ? `previous ci-reports commit ${commits[1].sha.slice(0, 7)}` : 'none';
  }

  const runs = tryGhJson(`repos/${REPO}/actions/workflows/security-scans.yml/runs?event=schedule&per_page=3`);
  const lastRun = runs.ok && runs.value.workflow_runs.length ? runs.value.workflow_runs[0] : null;
  const ageHours = Math.round((Date.now() - Date.parse(cur.results.date)) / 36e5);

  const curIssues = issueKeys(cur.issues);
  const prevIssues = baseline ? issueKeys(baseline.issues) : {};
  const rowDiff = compareRows(cur.results.rows, baseline ? baseline.results.rows : []);

  const out = {
    reportDate: cur.results.date,
    reportCommit: cur.results.commit,
    reportAgeHours: ageHours,
    stale: ageHours > 36,
    lastScheduledRun: lastRun
      ? { id: lastRun.id, status: lastRun.status, conclusion: lastRun.conclusion, createdAt: lastRun.created_at, url: lastRun.html_url }
      : (runs.ok ? null : { unavailable: runs.error }),
    baseline: baselineSource,
    rowsNotPass: cur.results.rows.filter((r) => r.status !== 'pass' && r.status !== 'skipped')
      .map((r) => ({ row: `${r.tool}/${r.scope}`, label: r.label, status: r.status, counts: r.counts, note: r.note, link: r.link })),
    worsened: rowDiff.worsened,
    improved: rowDiff.improved,
    newIssues: Object.keys(curIssues).filter((k) => !prevIssues[k]).map((k) => curIssues[k]),
    resolvedIssues: Object.keys(prevIssues).filter((k) => !curIssues[k]).map((k) => prevIssues[k]),
    openCriticalHigh: Object.values(curIssues),
    reportUrl: `https://github.com/${REPO}/blob/ci-reports/REPORT.md`,
  };

  if (hasFlag('--save')) {
    writeState(STATE_FILE, cur);
    out.saved = true;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

try {
  main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`nightly-scan error: ${err.message}\n`);
  process.exit(1);
}
