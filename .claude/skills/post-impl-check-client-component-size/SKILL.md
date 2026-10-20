---
name: post-impl-check-client-component-size
description: "Post-implementation check: React component file size — split components exceeding the configured threshold."
argument-hint: <task-folder-name>
---

You are performing a non-functional code review of the code changes introduced by a task.
Only applies if the task touched React components — otherwise report "no components changed" and stop.

Task: $ARGUMENTS

## Steps

1. Find all React components touched by the task: check git uncommitted changes and the task's
   `impl-plan.md`.
2. Use a small Node.js snippet to list the component file sizes. Thresholds: consider splitting
   above 10 KB (soft, matches `.claude/rules/client.md`); must split above 20 KB (hard).
3. For each component larger than 20 KB, invoke a subagent to suggest how to split it into
   smaller components with clear purposes.
4. In another subagent, implement the suggested changes.
5. Verify with the build/lint/test checks from `.claude/repo_config/repo-health-checks.json` as needed.
