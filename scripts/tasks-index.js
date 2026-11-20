#!/usr/bin/env node
'use strict';

// Task index generator.
//
// Rebuilds docs/tasks/todo/index.md from the open task folders, one line per folder:
//   - [<folder>] <title> — <description>
// `title` and `description` come from the OKF front matter of the task's requirements.md
// (`type: "Task"`, see .claude/repo_config/requirements-template.md). A task without it falls back
// to its H1 (minus the `<id>: ` prefix) and the first sentence of `## Description`, with a warning.
// Legacy folders that hold a single `<slug>.md` instead of requirements.md are read the same way.
//
// Run after adlc-lh:scratch and adlc-lh:archive (CLAUDE.md "task tracking"):
//   npm run tasks:index
// The done index is left alone: adlc-lh:archive appends to it, and archived tasks have no front
// matter to rebuild it from.

const fs = require('fs');
const path = require('path');

const TODO_DIR = path.resolve(__dirname, '..', 'docs', 'tasks', 'todo');
const INDEX_FILE = path.join(TODO_DIR, 'index.md');
const SIDE_FILES = new Set(['index.md', 'open_questions_ru.md', 'impl-plan.md', 'notes.md']);

/** The task's main document: requirements.md, or the only other top-level .md of a legacy folder. */
function taskFile(dir) {
  const req = path.join(dir, 'requirements.md');
  if (fs.existsSync(req)) return req;
  const mds = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !SIDE_FILES.has(f));
  return mds.length === 1 ? path.join(dir, mds[0]) : null;
}

/** Top-level `key: value` pairs of a leading `---` block; double-quoted values are JSON strings. */
function readFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value);
    } else if (value.startsWith('\'') && value.endsWith('\'')) {
      value = value.slice(1, -1).replace(/''/g, '\'');
    }
    out[kv[1]] = value;
  }
  return out;
}

function firstDescriptionSentence(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Description\b/i.test(l));
  if (start === -1) return '';
  const para = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#/.test(line)) break;
    if (!line.trim()) {
      if (para.length) break;
      continue;
    }
    para.push(line.trim());
  }
  const joined = para.join(' ').replace(/^Raw idea:\s*/i, '');
  const end = joined.search(/[.!?](\s|$)/);
  return end > 0 ? joined.slice(0, end + 1) : joined;
}

function entryFor(folder, warnings) {
  const file = taskFile(path.join(TODO_DIR, folder));
  if (!file) {
    warnings.push(`${folder}: no requirements.md`);
    return `- [${folder}]`;
  }
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const fm = readFrontMatter(text);
  const h1 = /^#\s+(.+)$/m.exec(text);
  const title = fm.title || (h1 ? h1[1].replace(/^[A-Za-z0-9._-]+:\s*/, '').trim() : folder);
  let description = fm.description;
  if (!fm.title || !description) {
    warnings.push(`${folder}: no front matter ${fm.title ? 'description' : 'title/description'}, used the document text`);
    description = description || firstDescriptionSentence(text);
  }
  return `- [${folder}] ${title}${description ? ` — ${description}` : ''}`;
}

function main() {
  const folders = fs.readdirSync(TODO_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
  const warnings = [];
  const lines = folders.map((f) => entryFor(f, warnings));
  const next = `# Tasks\n\n${lines.join('\n')}\n`;
  const prev = fs.existsSync(INDEX_FILE) ? fs.readFileSync(INDEX_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
  if (prev !== next) fs.writeFileSync(INDEX_FILE, next, 'utf8');
  for (const w of warnings) process.stderr.write(`tasks-index: ${w}\n`);
  process.stdout.write(`tasks-index: ${folders.length} open tasks, index ${prev === next ? 'unchanged' : 'rewritten'}\n`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`tasks-index error: ${err.message}\n`);
  process.exit(1);
}
