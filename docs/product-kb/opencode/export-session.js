#!/usr/bin/env node
/**
 * Export an OpenCode session from the local SQLite DB to JSON + Markdown.
 *
 * Usage:
 *   node export-session.js [sessionId] [--db <path>]
 *
 * Without a session id it exports the most recently updated session.
 * Output goes to ./samples/<sessionId>.json and ./samples/<sessionId>.md.
 *
 * The DB path defaults to ~/.local/share/opencode/opencode.db and can be
 * overridden with --db or the OPENCODE_DB environment variable.
 *
 * Requires Node.js >= 22.5 (node:sqlite).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const OUT_DIR = path.join(__dirname, 'samples');

function parseArgs(argv) {
  const args = { sessionId: null, db: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      i += 1;
      if (i >= argv.length) throw new Error('--db requires a path');
      args.db = argv[i];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (args.sessionId) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      args.sessionId = arg;
    }
  }
  return args;
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : '';
}

function fence(lang, text) {
  const body = String(text === undefined || text === null ? '' : text);
  const runs = body.match(/`+/g) || [];
  const longest = Math.max(3, ...runs.map((run) => run.length + 1));
  const marker = '`'.repeat(longest);
  return `${marker}${lang}\n${body}\n${marker}`;
}

function truncate(text, limit) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated in markdown, full text in .json]`;
}

function modelLabel(session) {
  if (!session.model) return '';
  try {
    const model = JSON.parse(session.model);
    const variant = model.variant ? ` (${model.variant})` : '';
    return `${model.providerID}/${model.id}${variant}`;
  } catch {
    return session.model;
  }
}

function renderMarkdown(session, messages, exportedAt) {
  const out = [];
  out.push(`# OpenCode session sample — ${session.title || session.slug}`);
  out.push('');
  out.push(`- Session: \`${session.id}\``);
  out.push(`- Slug: \`${session.slug}\``);
  out.push(`- Directory: \`${session.directory}\``);
  out.push(`- Agent: \`${session.agent || ''}\`, model: \`${modelLabel(session)}\``);
  out.push(`- Created: ${iso(session.time_created)}`);
  out.push(`- Updated: ${iso(session.time_updated)}`);
  out.push(
    `- Tokens: input ${session.tokens_input}, output ${session.tokens_output}, ` +
      `reasoning ${session.tokens_reasoning}, cache read ${session.tokens_cache_read}`,
  );
  out.push(`- Cost: ${session.cost}`);
  out.push(`- Exported: ${exportedAt}`);
  out.push('');

  for (const message of messages) {
    const data = message.data;
    const when = iso(data.time && data.time.created ? data.time.created : message.time_created);

    if (message.type === 'user') {
      out.push(`## User — ${when}`);
      out.push('');
      out.push(data.text || '');
      if (data.files && data.files.length) {
        out.push('', `Files: ${data.files.map((file) => `\`${file}\``).join(', ')}`);
      }
      out.push('');
      continue;
    }

    if (message.type === 'idle') {
      out.push(`## Idle — ${when} (${data.outcome || 'unknown'})`);
      out.push('');
      continue;
    }

    if (message.type === 'assistant') {
      const model = data.model
        ? `${data.model.providerID}/${data.model.id}${data.model.variant ? ` (${data.model.variant})` : ''}`
        : 'unknown';
      out.push(`## Assistant — ${when} — \`${model}\``);
      out.push('');
      for (const part of data.content || []) {
        if (part.type === 'reasoning' && part.text && part.text.trim()) {
          out.push('<details><summary>Reasoning</summary>', '', truncate(part.text, 4000), '', '</details>', '');
        } else if (part.type === 'text' && part.text && part.text.trim()) {
          out.push(part.text, '');
        } else if (part.type === 'tool') {
          const state = part.state || {};
          out.push(`### Tool: \`${part.name}\` — ${state.status || 'unknown'}`);
          out.push('');
          if (state.input !== undefined) out.push(fence('json', JSON.stringify(state.input, null, 2)), '');
          const content = state.content || [];
          const textParts = content.filter((item) => item.type === 'text').map((item) => item.text);
          if (textParts.length) out.push(fence('text', truncate(textParts.join('\n\n'), 1500)), '');
          if (state.status === 'error' && state.error) {
            out.push(fence('json', JSON.stringify(state.error, null, 2)), '');
          }
        }
      }
      continue;
    }

    out.push(`## ${message.type} — ${when}`);
    out.push('');
    out.push(fence('json', JSON.stringify(data, null, 2)));
    out.push('');
  }

  return out.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node export-session.js [sessionId] [--db <path>]\n' +
        'Exports an OpenCode session to ./samples/<sessionId>.json and .md\n',
    );
    return;
  }

  const dbPath =
    args.db ||
    process.env.OPENCODE_DB ||
    path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

  if (!fs.existsSync(dbPath)) throw new Error(`OpenCode DB not found: ${dbPath}`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let sessionId = args.sessionId;
    if (!sessionId) {
      const latest = db.prepare('select id from session_v2 order by time_updated desc limit 1').get();
      if (!latest) throw new Error('no sessions found in DB');
      sessionId = latest.id;
    }

    const session = db.prepare('select * from session_v2 where id = ?').get(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);

    const messages = db
      .prepare('select * from session_message where session_id = ? order by seq asc')
      .all(sessionId)
      .map((message) => ({ ...message, data: JSON.parse(message.data) }));

    const exportedAt = new Date().toISOString();
    const raw = {
      exportedAt,
      source: dbPath,
      session: {
        ...session,
        metadata: session.metadata ? JSON.parse(session.metadata) : null,
      },
      messages,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const jsonPath = path.join(OUT_DIR, `${sessionId}.json`);
    const markdownPath = path.join(OUT_DIR, `${sessionId}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2), 'utf8');
    fs.writeFileSync(markdownPath, renderMarkdown(session, messages, exportedAt), 'utf8');

    process.stdout.write(`session: ${sessionId} (${session.title || session.slug})\n`);
    process.stdout.write(`messages: ${messages.length}\n`);
    process.stdout.write(`written: ${jsonPath}\n`);
    process.stdout.write(`written: ${markdownPath}\n`);
  } finally {
    db.close();
  }
}

try {
  main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`export-session error: ${err.message}\n`);
  process.exit(1);
}
