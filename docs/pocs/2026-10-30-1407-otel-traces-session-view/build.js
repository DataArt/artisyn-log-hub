// Builds out/otel-tabs.html: runs facts.sql against a Log Hub Postgres container (read-only), loads
// the spans captured by capture.js and injects both into template.html.
//
// Usage: node build.js
// Env:   POC_DB_CONTAINER  Postgres container to query (default artisyn-log-hub-db); the query runs
//                          as the container's own POSTGRES_USER / POSTGRES_DB.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { newestTraceForPage } = require('./otlp');

const container = process.env.POC_DB_CONTAINER || 'artisyn-log-hub-db';
const outDir = path.join(__dirname, 'out');

// What each query_source is. In the product this dictionary lives on the server; an unknown
// source is shown as is and flagged as new.
const DICTIONARY = {
  repl_main_thread: 'Main conversation thread (interactive)',
  sdk: 'claude -p main thread, or a utility side call in interactive sessions',
  prompt_suggestion: 'Grey "next prompt" suggestion after each answer — sends the session context to the session model',
  agent_summary: 'Background agent status line (3–5 words), re-sends the agent transcript every ~30 s',
  generate_session_title: 'Session title generation',
  web_search_tool: 'WebSearch tool server call',
  web_fetch_apply: 'WebFetch: applies the prompt to the fetched page',
  compact: 'Conversation compaction',
  side_question: '/btw side question',
  hook_prompt: 'Prompt-type hook evaluation',
  hook_agent: 'Agent-type hook',
  auto_mode: 'Auto mode permission classifier',
  extract_memories: 'Automatic memory extraction',
  away_summary: 'Summary of what happened while you were away',
};
// Sources that never appear in a transcript (all their calls are utility calls).
const HIDDEN = ['prompt_suggestion', 'agent_summary', 'generate_session_title', 'web_search_tool',
  'web_fetch_apply', 'compact', 'side_question', 'hook_prompt', 'auto_mode', 'extract_memories', 'away_summary'];

function psql(sqlFile) {
  return execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q'], {
    input: fs.readFileSync(sqlFile, 'utf8'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
  });
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(',');
  const numeric = new Set(['repo', 'calls', 'input', 'output', 'cache_read', 'cache_write', 'micros', 'hidden_micros', 'hidden_calls']);
  return lines.map((l) => {
    const cells = l.split(',');
    const row = {};
    head.forEach((h, i) => { row[h] = numeric.has(h) ? Number(cells[i]) : cells[i]; });
    return row;
  });
}

try {
  fs.mkdirSync(outDir, { recursive: true });
  const facts = parseCsv(psql(path.join(__dirname, 'facts.sql')));
  const repoRows = parseCsv(execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q --csv'], {
    input: 'select id as repo, repo_url from repositories;', encoding: 'utf8', timeout: 60000,
  }));
  const repos = {};
  for (const r of repoRows) repos[r.repo] = r.repo_url.replace(/^https?:\/\/[^/]+\//, '');

  const traceSpans = newestTraceForPage(path.join(outDir, 'traces.jsonl'), path.join(outDir, 'logs.jsonl'));

  const data = { facts, repos, dictionary: DICTIONARY, hiddenSources: HIDDEN, trace: { spans: traceSpans } };
  const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const marker = '/*__DATA__*/';
  if (!template.includes(marker)) throw new Error('template has no data marker');
  const html = template.replace(marker, () => JSON.stringify(data).replace(/</g, '\\u003c'));
  const outFile = path.join(outDir, 'otel-tabs.html');
  fs.writeFileSync(outFile, html, 'utf8');
  process.stderr.write(`wrote ${outFile}: ${facts.length} fact rows, ${traceSpans.length} spans\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`build error: ${err.message}\n`);
  process.exit(1);
}
