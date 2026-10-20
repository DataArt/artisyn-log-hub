#!/usr/bin/env node
// Reads all sql-*.log files from a logs directory and generates an API SQL summary markdown.
// Usage: node scripts/api-2-sql-summary.js [outputPath] [logsDir]
// Defaults: outputPath=docs/api-sql-summary.md, logsDir=server/logs

const fs = require('fs');
const path = require('path');

const outputPath = process.argv[2] || path.join(__dirname, '..', 'doc', 'api-sql-summary.md');
const logsDir = process.argv[3] || path.join(__dirname, '..', 'server', 'logs');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMBER_SEGMENT_RE = /\/\d+(?=\/|$)/g;

function normalizeEndpoint(endpoint) {
  return endpoint
    .replace(UUID_RE, '$')
    .replace(NUMBER_SEGMENT_RE, '/$');
}

function normalizeSql(sql) {
  // Collapse whitespace for deduplication key
  return sql.replace(/\s+/g, ' ').trim();
}

// Read all sql-*.log files
const logFiles = fs.readdirSync(logsDir)
  .filter(f => /^sql-.*\.log$/.test(f))
  .map(f => path.join(logsDir, f));

if (logFiles.length === 0) {
  console.error('No sql-*.log files found in', logsDir);
  process.exit(1);
}

// endpoint -> { durations[], sqlCounts[], sqlMap: { normalizedSql -> {count, sample} } }
const apiMap = new Map();

for (const file of logFiles) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

  // Group by callUuid within this file pass
  const callGroups = new Map(); // callUuid -> { endpoint, sqls[], durations[] }

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.endpoint || !entry.callUuid) continue;

    const ep = normalizeEndpoint(entry.endpoint);
    const uuid = entry.callUuid;

    if (!callGroups.has(uuid)) {
      callGroups.set(uuid, { endpoint: ep, sqls: [], totalDuration: 0 });
    }
    const group = callGroups.get(uuid);
    group.sqls.push({ sql: entry.sql, duration: entry.durationMs || 0 });
    group.totalDuration += entry.durationMs || 0;
  }

  for (const [, group] of callGroups) {
    const ep = group.endpoint;
    if (!apiMap.has(ep)) {
      apiMap.set(ep, { durations: [], sqlCounts: [], sqlMap: new Map() });
    }
    const agg = apiMap.get(ep);
    agg.durations.push(group.totalDuration);
    agg.sqlCounts.push(group.sqls.length);

    for (const { sql } of group.sqls) {
      const key = normalizeSql(sql);
      if (!agg.sqlMap.has(key)) {
        agg.sqlMap.set(key, { count: 0, sample: sql });
      }
      agg.sqlMap.get(key).count++;
    }
  }
}

// Build markdown
const lines = ['# API SQL Summary\n'];

const sortedEndpoints = [...apiMap.keys()].sort();

for (const ep of sortedEndpoints) {
  const { durations, sqlCounts, sqlMap } = apiMap.get(ep);

  const minDur = Math.min(...durations);
  const maxDur = Math.max(...durations);
  const avgDur = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const minSql = Math.min(...sqlCounts);
  const maxSql = Math.max(...sqlCounts);

  lines.push(`## api: ${ep}`);
  lines.push(`min duration: ${minDur}ms`);
  lines.push(`max duration: ${maxDur}ms`);
  lines.push(`avg duration: ${avgDur}ms`);
  lines.push(`sql calls min: ${minSql}`);
  lines.push(`sql calls max: ${maxSql}`);
  lines.push('');
  lines.push('List of distinct sql calls:');
  lines.push('');
  lines.push('| sql call | count |');
  lines.push('| --- | --- |');

  const sortedSqls = [...sqlMap.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [, { count, sample }] of sortedSqls) {
    const safeSql = normalizeSql(sample).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${safeSql} | ${count} |`);
  }
  lines.push('');
}

const output = lines.join('\n');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, 'utf8');
console.log('Written:', outputPath);

// Also emit structured JSON for subagent consumption
const jsonPath = outputPath.replace(/\.md$/, '.json');
const structured = [];
for (const ep of sortedEndpoints) {
  const { durations, sqlCounts, sqlMap } = apiMap.get(ep);
  structured.push({
    endpoint: ep,
    minDuration: Math.min(...durations),
    maxDuration: Math.max(...durations),
    avgDuration: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    sqlCallsMin: Math.min(...sqlCounts),
    sqlCallsMax: Math.max(...sqlCounts),
    sqls: [...sqlMap.entries()].sort((a,b)=>b[1].count-a[1].count).map(([, {count, sample}]) => ({
      sql: normalizeSql(sample),
      count,
    })),
  });
}
fs.writeFileSync(jsonPath, JSON.stringify(structured, null, 2), 'utf8');
console.log('Written:', jsonPath);
