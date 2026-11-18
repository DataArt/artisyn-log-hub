#!/usr/bin/env node
'use strict';

// PoC analysis: what a monitoring tool sees of a Code Mode session.
//
// Modes:
//   node analyze.cjs
//     Reads capture/hooks.jsonl (written by dump-hook.cjs), takes `transcript_path` from the
//     payloads, copies each transcript into capture/ and prints a report to stdout:
//       1. hook events per hook_event_name x tool_name, and the payload keys of each pair;
//       2. PreToolUse calls with no PostToolUse (matched by tool_use_id);
//       3. per transcript: line types, tool_use blocks per tool name, the input keys of `REPL`,
//          tool_result count, and which hook-seen tool calls are absent from the transcript;
//       4. token usage summed over assistant lines (deduplicated by message id).
//
// Exit codes: 0 on success, 1 when capture/hooks.jsonl is missing or unreadable.

const fs = require('fs');
const path = require('path');

const CAPTURE = path.join(__dirname, 'capture');
const REPL = 'REPL';

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ unparsed: true });
    }
  }
  return out;
}

function bump(map, key, n) {
  map.set(key, (map.get(key) || 0) + (n === undefined ? 1 : n));
}

function printMap(title, map) {
  process.stdout.write(`\n${title}\n`);
  if (map.size === 0) process.stdout.write('  (none)\n');
  for (const [k, v] of [...map.entries()].sort()) process.stdout.write(`  ${String(v).padStart(5)}  ${k}\n`);
}

function hookReport(events) {
  const counts = new Map();
  const keys = new Map();
  const pre = new Map();
  const post = new Set();
  for (const { payload } of events) {
    if (!payload || typeof payload !== 'object') continue;
    const name = `${payload.hook_event_name || '?'} / ${payload.tool_name || '-'}`;
    bump(counts, name);
    const seen = keys.get(name) || new Set();
    for (const k of Object.keys(payload)) seen.add(k);
    if (payload.tool_input && typeof payload.tool_input === 'object') {
      for (const k of Object.keys(payload.tool_input)) seen.add(`tool_input.${k}`);
    }
    keys.set(name, seen);
    const id = payload.tool_use_id;
    if (payload.hook_event_name === 'PreToolUse') pre.set(id || `no-id-${pre.size}`, payload.tool_name);
    if (payload.hook_event_name === 'PostToolUse' && id) post.add(id);
  }
  printMap('1. Hook events (event / tool_name)', counts);
  process.stdout.write('\n   Payload keys per pair\n');
  for (const [name, set] of [...keys.entries()].sort()) process.stdout.write(`  ${name}: ${[...set].sort().join(', ')}\n`);

  const unmatched = new Map();
  for (const [id, tool] of pre) if (!post.has(id)) bump(unmatched, tool || '?');
  printMap('2. PreToolUse with no PostToolUse (by tool_name)', unmatched);
  return pre;
}

function transcriptReport(file, preCalls) {
  const lines = readJsonl(file);
  const types = new Map();
  const toolUses = new Map();
  const replKeys = new Set();
  const usage = new Map();
  const seenMessages = new Set();
  const transcriptIds = new Set();
  let toolResults = 0;
  for (const line of lines) {
    bump(types, line.type || '?');
    const msg = line.message;
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        bump(toolUses, block.name || '?');
        transcriptIds.add(block.id);
        if (block.name === REPL && block.input) for (const k of Object.keys(block.input)) replKeys.add(k);
      }
      if (block.type === 'tool_result') toolResults += 1;
    }
    if (line.type === 'assistant' && msg && msg.usage && !seenMessages.has(msg.id)) {
      seenMessages.add(msg.id);
      for (const [k, v] of Object.entries(msg.usage)) if (typeof v === 'number') bump(usage, k, v);
    }
  }
  process.stdout.write(`\n3. Transcript ${path.basename(file)} (${lines.length} lines)\n`);
  printMap('   Line types', types);
  printMap('   tool_use blocks (by tool name)', toolUses);
  process.stdout.write(`\n   ${REPL} input keys: ${[...replKeys].sort().join(', ') || '(no REPL call)'}\n`);
  process.stdout.write(`   tool_result blocks: ${toolResults}\n`);

  const hidden = new Map();
  for (const [id, tool] of preCalls) if (!transcriptIds.has(id)) bump(hidden, tool || '?');
  printMap('   Tool calls seen by PreToolUse but absent from the transcript (by tool_name)', hidden);
  printMap('4. Token usage (assistant lines, one per message id)', usage);
}

try {
  const hooksFile = path.join(CAPTURE, 'hooks.jsonl');
  if (!fs.existsSync(hooksFile)) {
    process.stderr.write('analyze: capture/hooks.jsonl not found — run the session first (see README.md)\n');
    process.exit(1);
  }
  const events = readJsonl(hooksFile);
  const preCalls = hookReport(events);
  const transcripts = new Set();
  for (const { payload } of events) if (payload && payload.transcript_path) transcripts.add(payload.transcript_path);
  if (transcripts.size === 0) process.stdout.write('\n3. No transcript_path in the hook payloads.\n');
  for (const src of transcripts) {
    if (!fs.existsSync(src)) {
      process.stdout.write(`\n3. Transcript not found: ${path.basename(src)}\n`);
      continue;
    }
    const copy = path.join(CAPTURE, path.basename(src));
    fs.copyFileSync(src, copy);
    transcriptReport(copy, preCalls);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`analyze error: ${err.message}\n`);
  process.exit(1);
}
