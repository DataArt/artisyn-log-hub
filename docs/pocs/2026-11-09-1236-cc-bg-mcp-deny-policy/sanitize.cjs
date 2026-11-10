#!/usr/bin/env node
// Turns the raw (gitignored) captures under raw/ into committed fixtures under fixtures/:
// keeps only the conversation entries (user / assistant / system / queue-operation) and the
// fields Log Hub reads, drops attachments, API request snapshots, account/org ids, cwd, paths,
// thinking signatures and e-mail addresses, and replaces session ids with placeholders.
// Usage: node sanitize.cjs
'use strict';

const fs = require('fs');
const path = require('path');

const raw = path.join(__dirname, 'raw');
const outDir = path.join(__dirname, 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const KEEP_TYPES = new Set(['user', 'assistant', 'system', 'queue-operation']);
const DROP_KEYS = new Set(['cwd', 'gitBranch', 'entrypoint', 'userType', 'requestRef', 'wireToolInputs',
  'accountUuid', 'organizationUuid', 'transcript_path', 'output_file', 'promptCacheRequested',
  'advisorModel', 'last_assistant_message', 'permission_suggestions', 'credential_expires_at']);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const WIN_PATH = /[A-Za-z]:\\\\?[^"\s]*/g;

function scrub(v, sessionMap) {
  if (typeof v === 'string') {
    let s = v.replace(EMAIL, '<email>').replace(WIN_PATH, '<path>');
    for (const [id, ph] of sessionMap) s = s.split(id).join(ph);
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, sessionMap));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (DROP_KEYS.has(k)) continue;
      if (k === 'signature') { o[k] = '<signature>'; continue; }
      o[k] = scrub(val, sessionMap);
    }
    return o;
  }
  return v;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function sessionMapOf(entries, label) {
  const ids = new Set();
  for (const e of entries) {
    if (typeof e.sessionId === 'string') ids.add(e.sessionId);
    if (typeof e.session_id === 'string') ids.add(e.session_id);
    if (e.payload && typeof e.payload.session_id === 'string') ids.add(e.payload.session_id);
  }
  return new Map([...ids].map((id, i) => [id, `<session-${label}${i ? `-${i}` : ''}>`]));
}

function writeJsonl(name, rows) {
  fs.writeFileSync(path.join(outDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.stdout.write(`fixtures/${name}: ${rows.length} lines\n`);
}

function transcript(src, dst, label) {
  const all = readJsonl(src);
  const map = sessionMapOf(all, label);
  const rows = all
    .filter((e) => KEEP_TYPES.has(e.type))
    .map((e) => {
      if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
        e.message.content = e.message.content.filter((b) => b.type !== 'thinking');
      }
      return scrub(e, map);
    });
  writeJsonl(dst, rows);
}

function hooks(src, dst, label) {
  const all = readJsonl(src);
  const map = sessionMapOf(all, label);
  writeJsonl(dst, all.map((e) => scrub(e, map)));
}

function stream(src, dst, label) {
  const all = readJsonl(src).filter((e) => !(e.type === 'system' && e.subtype === 'init')
    && e.type !== 'rate_limit_event' && e.subtype !== 'thinking_tokens');
  const map = sessionMapOf(all, label);
  writeJsonl(dst, all.map((e) => {
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      e.message.content = e.message.content.filter((b) => b.type !== 'thinking');
    }
    return scrub(e, map);
  }));
}

transcript(path.join(raw, 's3', 'transcript.jsonl'), 'bg-mcp.transcript.jsonl', 'bg-mcp');
hooks(path.join(raw, 's3', 'hooks.jsonl'), 'bg-mcp.hooks.jsonl', 'bg-mcp');
stream(path.join(raw, 's3', 's3-bg-mcp.stdout.jsonl'), 'bg-mcp.stream.jsonl', 'bg-mcp');
transcript(path.join(raw, 's5', 'transcript.jsonl'), 'deny-policy.transcript.jsonl', 'deny');
hooks(path.join(raw, 's5', 'hooks.jsonl'), 'deny-policy.hooks.jsonl', 'deny');
stream(path.join(raw, 's5', 's5-deny.stdout.jsonl'), 'deny-policy.stream.jsonl', 'deny');
process.exit(0);
