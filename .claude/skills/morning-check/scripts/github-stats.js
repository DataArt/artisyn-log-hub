#!/usr/bin/env node
// Morning check — GitHub stats of the repo: stars, forks, watchers, issues, PRs, release downloads,
// with the delta against the last snapshot taken on an earlier day.
// Usage: node github-stats.js [--save]   (--save appends today's snapshot to tmp/morning-check/github-stats.json)
// Output: JSON on stdout. Read-only token by design: no traffic (views/clones), stargazer list or
// security alerts — those endpoints need push / security-events access and are not queried.
const { REPO, ghJson, tryGhJson, readState, writeState, today, hasFlag } = require('./lib');

const STATE_FILE = 'github-stats.json';

function searchCount(q) {
  const res = tryGhJson(`search/issues?q=${encodeURIComponent(q)}&per_page=1`);
  return res.ok ? res.value.total_count : null;
}

function listItems(kind, since) {
  // kind: 'issue' | 'pr'; items created or updated since the given ISO date.
  const q = `repo:${REPO} is:${kind} updated:>=${since.slice(0, 10)}`;
  const res = tryGhJson(`search/issues?q=${encodeURIComponent(q)}&per_page=50&sort=updated`);
  if (!res.ok) return { error: res.error };
  return res.value.items.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    author: i.user && i.user.login,
    created: i.created_at,
    updated: i.updated_at,
    isNew: i.created_at >= since,
    url: i.html_url,
  }));
}

function main() {
  const repo = ghJson(`repos/${REPO}`);
  const releases = ghJson(`repos/${REPO}/releases?per_page=30`);
  const releaseRows = releases.map((r) => ({
    tag: r.tag_name,
    published: r.published_at,
    downloads: r.assets.reduce((s, a) => s + a.download_count, 0),
    assets: Object.fromEntries(r.assets.map((a) => [a.name, a.download_count])),
  }));

  const snapshot = {
    date: today(),
    takenAt: new Date().toISOString(),
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.subscribers_count,
    openIssues: searchCount(`repo:${REPO} is:issue is:open`),
    openPrs: searchCount(`repo:${REPO} is:pr is:open`),
    totalDownloads: releaseRows.reduce((s, r) => s + r.downloads, 0),
    releases: Object.fromEntries(releaseRows.map((r) => [r.tag, r.downloads])),
  };

  const history = readState(STATE_FILE) || { snapshots: [] };
  const prev = history.snapshots.filter((s) => s.date < snapshot.date).pop() || null;
  const since = prev ? prev.takenAt : new Date(Date.now() - 7 * 864e5).toISOString();

  const delta = prev ? {
    since: prev.takenAt,
    stars: snapshot.stars - prev.stars,
    forks: snapshot.forks - prev.forks,
    watchers: snapshot.watchers - prev.watchers,
    openIssues: snapshot.openIssues === null || prev.openIssues === null ? null : snapshot.openIssues - prev.openIssues,
    openPrs: snapshot.openPrs === null || prev.openPrs === null ? null : snapshot.openPrs - prev.openPrs,
    totalDownloads: snapshot.totalDownloads - prev.totalDownloads,
    releases: Object.fromEntries(Object.entries(snapshot.releases)
      .map(([tag, n]) => [tag, n - (prev.releases[tag] || 0)])
      .filter(([, d]) => d !== 0)),
  } : null;

  const out = {
    repo: REPO,
    snapshot,
    previousSnapshot: prev ? prev.takenAt : null,
    delta,
    activitySince: since,
    issues: listItems('issue', since),
    prs: listItems('pr', since),
    latestReleases: releaseRows.slice(0, 3),
  };

  if (hasFlag('--save')) {
    history.snapshots = history.snapshots.filter((s) => s.date !== snapshot.date).concat([snapshot]).slice(-120);
    writeState(STATE_FILE, history);
    out.saved = true;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

try {
  main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`github-stats error: ${err.message}\n`);
  process.exit(1);
}
