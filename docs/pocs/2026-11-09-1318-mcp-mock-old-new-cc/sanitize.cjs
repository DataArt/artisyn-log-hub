#!/usr/bin/env node
// Turns the raw (ignored) transcripts under raw/ into committed fixtures under fixtures/: keeps
// only conversation entries (user / assistant / system / queue-operation), drops thinking,
// cwd, git branch, account/org ids, request ids and file paths, masks e-mail addresses and
// replaces session ids with placeholders. Usage: node sanitize.cjs
'use strict';

const fs = require('fs');
const path = require('path');

const raw = path.join(__dirname, 'raw');
const outDir = path.join(__dirname, 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const CAPTURES = ['old-full', 'mid-full', 'new-full', 'new-live', 'new-kill', 'new-close'];
const KEEP_TYPES = new Set(['user', 'assistant', 'system', 'queue-operation']);
const DROP_KEYS = new Set(['cwd', 'gitBranch', 'entrypoint', 'userType', 'requestRef', 'requestId',
  'wireToolInputs', 'accountUuid', 'organizationUuid', 'transcript_path', 'output_file', 'slug',
  'promptCacheRequested', 'advisorModel', 'permission_suggestions', 'credential_expires_at']);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const WIN_PATH = /[A-Za-z]:[\\/][^"\s]*/g;
const POSIX_HOME = /\/(?:home|Users)\/[^"\s/]+[^"\s]*/g;

function scrub(v, sessionMap) {
  if (typeof v === 'string') {
    let s = v.replace(EMAIL, '<email>').replace(WIN_PATH, '<path>').replace(POSIX_HOME, '<path>');
    for (const [id, ph] of sessionMap) s = s.split(id).join(ph);
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, sessionMap));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (DROP_KEYS.has(k)) continue;
      o[k] = k === 'signature' ? '<signature>' : scrub(val, sessionMap);
    }
    return o;
  }
  return v;
}

for (const name of CAPTURES) {
  const src = path.join(raw, `${name}.transcript.jsonl`);
  if (!fs.existsSync(src)) { process.stdout.write(`skip ${name}: no raw capture\n`); continue; }
  const all = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ids = [...new Set(all.map((e) => e.sessionId).filter((s) => typeof s === 'string'))];
  const map = new Map(ids.map((id, i) => [id, `<session-${name}${i ? `-${i}` : ''}>`]));
  const rows = all.filter((e) => KEEP_TYPES.has(e.type)).map((e) => {
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      e.message.content = e.message.content.filter((b) => b.type !== 'thinking');
    }
    return scrub(e, map);
  });
  fs.writeFileSync(path.join(outDir, `${name}.transcript.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  process.stdout.write(`fixtures/${name}.transcript.jsonl: ${rows.length} lines\n`);
}
