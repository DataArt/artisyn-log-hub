#!/usr/bin/env node
// Two checks over this plugin's skills and workflows, each encoding a mistake
// that has already been made once here.
//
// 1. A task-doc path spelled out instead of asked for from scripts/adlc-task.js.
//
// The whole point of the resolver is that `paths` in project-env.json can move
// the task docs and nothing breaks. One skill that still says
// "docs/tasks/todo/<task-id>-<slug>/impl-plan.md" quietly reintroduces the
// assumption for every project that moved them, and it reads as correct right
// up until someone's plan is written to a folder no other skill looks in.
//
// A bare `docs/tasks/` -- the default, named while explaining that it IS the
// default -- is fine. What is not fine is a path that reaches INTO the tree.
//
// 2. An argument placeholder inside an injected `` !`...` `` command. Claude Code
// substitutes $ARGUMENTS BEFORE running an injected command, so interpolating it
// works -- and a task id of `$(whoami)` then executes, unprompted, before Claude
// reads a word of the skill. Measured, not theorised: a probe skill whose
// allowed-tools was `Bash(echo *)` and whose body held `` !`echo "[$ARGUMENTS]"` ``
// printed the output of `whoami` when invoked as `/probe $(whoami)`. The
// operator-aware permission check does not catch it, because as a shell string it
// is a single `echo`. Inject only commands that carry no user input; resolve a
// task id with an ordinary Bash call, which is permission-checked and leaves the
// skill able to handle a bad one.
//
// 3. Progress-tracking wiring between the lifecycle skills and tracker. Every
// lifecycle skill carries a `## Progress tracking` section that POINTS at the
// shared rules in tracker/SKILL.md and carries a TaskCreate fallback line — the
// rules themselves live only in tracker. A missing section, a pointer at a
// section tracker no longer has, or a pasted copy of the shared rules (the
// distill-prompt.md mistake, repeated) are all silent breakage across nine
// skills at once, so they fail here.
//
// Usage: node scripts/lint-skills.js   (from the plugin root)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN = [
  { dir: path.join(ROOT, 'skills'), match: (f) => f.endsWith('.md') },
  { dir: path.join(ROOT, 'workflows'), match: (f) => f.endsWith('.js') },
];
const OFFENDING = /docs\/tasks\/(todo|done|\*|<|index)/;

function walk(dir, match, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, match, out);
    else if (match(entry.name)) out.push(full);
  }
  return out;
}

const ARGUMENT_PLACEHOLDER = /\$(ARGUMENTS|\d)/;
const INLINE_INJECTION = /!`[^`]*`/g;

// Lines inside a ```! fenced block are an injected command, exactly like the
// inline form; everything else on the page is prose.
function injectedCommands(text) {
  const out = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```!\s*$/.test(line)) { inFence = true; return; }
    if (inFence) {
      if (/^\s*```\s*$/.test(line)) { inFence = false; return; }
      out.push([i + 1, line]);
      return;
    }
    for (const match of line.match(INLINE_INJECTION) ?? []) out.push([i + 1, match]);
  });
  return out;
}

const hardcodedPaths = [];
const unsafeInjections = [];
for (const { dir, match } of SCAN) {
  for (const file of walk(dir, match)) {
    const relative = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      if (OFFENDING.test(line)) hardcodedPaths.push(`${relative}:${i + 1}: ${line.trim()}`);
    });
    if (!file.endsWith('.md')) continue;
    for (const [lineNumber, command] of injectedCommands(text)) {
      if (ARGUMENT_PLACEHOLDER.test(command)) {
        unsafeInjections.push(`${relative}:${lineNumber}: ${command.trim()}`);
      }
    }
  }
}

const LIFECYCLE_SKILLS = ['scratch', 'review', 'review-deep', 'plan', 'plan-deep',
  'implement', 'implement-deep', 'post-impl-check', 'archive'];
// A phrase that exists only in tracker's shared rules — its presence in a
// lifecycle skill means the rules were copied instead of pointed at.
const SHARED_RULES_MARKER = 'progress display, not a work queue';
const progressTracking = [];
for (const name of LIFECYCLE_SKILLS) {
  const file = path.join(ROOT, 'skills', name, 'SKILL.md');
  const relative = path.relative(ROOT, file);
  if (!fs.existsSync(file)) { progressTracking.push(`${relative}: file missing`); continue; }
  const text = fs.readFileSync(file, 'utf8');
  if (!/^## Progress tracking$/m.test(text)) {
    progressTracking.push(`${relative}: no "## Progress tracking" section`);
    continue;
  }
  if (!text.includes('skills/tracker/SKILL.md')) {
    progressTracking.push(`${relative}: Progress tracking does not point at tracker/SKILL.md`);
  }
  if (!text.includes('TaskCreate')) {
    progressTracking.push(`${relative}: no TaskCreate fallback line in Progress tracking`);
  }
  if (text.includes(SHARED_RULES_MARKER)) {
    progressTracking.push(`${relative}: contains a copy of tracker's shared rules — keep only the pointer`);
  }
}
const trackerFile = path.join(ROOT, 'skills', 'tracker', 'SKILL.md');
const trackerText = fs.existsSync(trackerFile) ? fs.readFileSync(trackerFile, 'utf8') : '';
if (!/^## Progress tracking$/m.test(trackerText) || !trackerText.includes(SHARED_RULES_MARKER)) {
  progressTracking.push('skills/tracker/SKILL.md: shared "## Progress tracking" rules section missing — nine skills point at it');
}

if (hardcodedPaths.length) {
  process.stderr.write('Hardcoded task-doc paths found. Use scripts/adlc-task.js instead:\n\n');
  for (const v of hardcodedPaths) process.stderr.write(`  ${v}\n`);
  process.stderr.write('\n');
}
if (unsafeInjections.length) {
  process.stderr.write('Argument placeholder inside an injected command: that is code execution\n' +
    'through the skill\'s own argument (see the note at the top of this file). Inject only\n' +
    'argument-free commands, and resolve an id with an ordinary Bash call:\n\n');
  for (const v of unsafeInjections) process.stderr.write(`  ${v}\n`);
  process.stderr.write('\n');
}
if (progressTracking.length) {
  process.stderr.write('Progress-tracking wiring broken (pointer in each lifecycle skill, shared rules only in tracker):\n\n');
  for (const v of progressTracking) process.stderr.write(`  ${v}\n`);
  process.stderr.write('\n');
}
if (hardcodedPaths.length || unsafeInjections.length || progressTracking.length) {
  process.stderr.write(`${hardcodedPaths.length + unsafeInjections.length + progressTracking.length} violation(s).\n`);
  process.exit(1);
}
process.stdout.write('OK: no hardcoded task-doc paths, no arguments in injected commands, progress-tracking wiring intact.\n');
