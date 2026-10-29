Session: `88e8…` (id shortened)
Total startup context (first API call): **55513 tokens** = input 2 + cache write 23450 + cache read 32061
Token estimate per part: chars / 3.7

```
|█████▓█▓▓▓▓▓▓▓▓▓▓▓▓▓███████████▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░|
P1 3.2 %  P3 1.9 %  P4 0.9 %  P5 1.2 %  P6 13.0 %  P7 9.7 %  P9 1.2 %  P10 0.0 %  U 68.9 %
```

## Partition table

| # | Partition | Source | Chars | ≈ Tokens | Share | Measured |
|---|---|---|---:|---:|---:|---|
| P1 | System prompt (harness core) | Claude Code binary | 6500 | 1757 | 3.2 % | exact text length |
| P2 | Tool definitions (JSON schemas) | Claude Code + MCP servers | 0 | 0 | 0.0 % | not in transcript → in Unallocated |
| P3 | Deferred tool names (119) | Claude Code + MCP servers | 3814 | 1031 | 1.9 % | exact list length |
| P4 | MCP server instructions | MCP servers | 1893 | 512 | 0.9 % | exact block length |
| P5 | Subagent types (6) | Claude Code + .claude/agents | 2527 | 683 | 1.2 % | exact line length |
| P6 | Skill listing (78) | project / user / plugin / org / built-in | 26675 | 7209 | 13.0 % | exact per-skill listing length |
| P7 | Instruction files | CLAUDE.md family + rules | 20001 | 5406 | 9.7 % | exact content length |
| P8 | Memory index | auto-memory dir | 0 | 0 | 0.0 % | file size |
| P9 | System reminders & environment | Claude Code runtime | 2364 | 639 | 1.2 % | exact / ≈ for JSON-only attachments |
| P10 | First user prompt | user | 82 | 22 | 0.0 % | exact |
| U | **Unallocated** (tool schemas, wrappers, tags) | Claude Code | — | 38254 | 68.9 % | total − attributed |
| | **Total** | | | 55513 | 100 % | API usage (exact) |

### P1 System prompt (harness core)

| Item | Origin | Chars | ≈ Tokens |
|---|---|---:|---:|
| untitled block #0 | Claude Code | 1603 | 433 |
| dynamic boundary marker | Claude Code | 34 | 9 |
| untitled block #2 | Claude Code | 94 | 25 |
| untitled block #3 | Claude Code | 357 | 96 |
| untitled block #4 | Claude Code | 520 | 141 |
| Session-specific guidance | Claude Code | 422 | 114 |
| Memory | Claude Code | 2084 | 563 |
| Environment | Claude Code | 598 | 162 |
| Context management | Claude Code | 280 | 76 |
| untitled block #9 | Claude Code | 277 | 75 |
| untitled block #10 | Claude Code | 231 | 62 |

### P3 Deferred tool names (119)

| Item | Origin | Chars | ≈ Tokens |
|---|---|---:|---:|
| Claude Code built-in — 23 names | Claude Code built-in | 302 | 82 |
| MCP claude_ai_Artisyn_Transform — 2 names | MCP claude_ai_Artisyn_Transform | 105 | 28 |
| MCP claude_ai_Atlassian_Rovo — 2 names | MCP claude_ai_Atlassian_Rovo | 99 | 27 |
| MCP claude_ai_Canva — 2 names | MCP claude_ai_Canva | 81 | 22 |
| MCP claude_ai_Claude_Docs — 8 names | MCP claude_ai_Claude_Docs | 275 | 74 |
| MCP claude_ai_Figma — 2 names | MCP claude_ai_Figma | 81 | 22 |
| MCP claude_ai_HubSpot — 2 names | MCP claude_ai_HubSpot | 85 | 23 |
| MCP claude_ai_Microsoft_365 — 2 names | MCP claude_ai_Microsoft_365 | 97 | 26 |
| MCP claude_ai_Miro — 2 names | MCP claude_ai_Miro | 79 | 21 |
| MCP claude_ai_PresalesHub — 2 names | MCP claude_ai_PresalesHub | 93 | 25 |
| MCP claude_ai_Salesforce_CRM — 2 names | MCP claude_ai_Salesforce_CRM | 99 | 27 |
| MCP playwright — 25 names | MCP playwright | 881 | 238 |
| MCP postgres — 1 names | MCP postgres | 21 | 6 |
| MCP webstorm — 44 names | MCP webstorm | 1516 | 410 |
| MCP comfyui — FAILED (CONNECTION_CLOSED) | MCP config | 0 | 0 |

### P4 MCP server instructions

| Item | Origin | Chars | ≈ Tokens |
|---|---|---:|---:|
| claude.ai Claude Docs | MCP server | 1893 | 512 |

### P5 Subagent types (6)

| Item | Origin | Chars | ≈ Tokens |
|---|---|---:|---:|
| claude | built-in | 132 | 36 |
| claude-code-guide | built-in | 1072 | 290 |
| Explore | built-in | 539 | 146 |
| general-purpose | built-in | 309 | 84 |
| Plan | built-in | 364 | 98 |
| statusline-setup | built-in | 111 | 30 |

### P6 Skill listing (78)

| Item | Origin | Chars | ≈ Tokens | File | File size, B | Git |
|---|---|---:|---:|---|---:|---|
| adlc-scripting | project | 80 | 22 | `.claude/skills/adlc-scripting/SKILL.md` | 390 | tracked |
| architect-assistant | project | 113 | 31 | `.claude/skills/architect-assistant/SKILL.md` | 10867 | tracked |
| big-prod-e2e-test | project | 706 | 191 | `.claude/skills/big-prod-e2e-test/SKILL.md` | 8366 | tracked |
| ce | project | 322 | 87 | `.claude/skills/ce/SKILL.md` | 3160 | tracked |
| changelog | project | 206 | 56 | `.claude/skills/changelog/SKILL.md` | 2623 | tracked |
| check-fix-build | project | 62 | 17 | `.claude/skills/check-fix-build/SKILL.md` | 1046 | tracked |
| git-branching | project | 121 | 33 | `.claude/skills/git-branching/SKILL.md` | 1893 | tracked |
| github-issues | project | 507 | 137 | `.claude/skills/github-issues/SKILL.md` | 4573 | tracked |
| hook-debugging | project | 87 | 24 | `.claude/skills/hook-debugging/SKILL.md` | 345 | tracked |
| migrations-data-integrity | project | 110 | 30 | `.claude/skills/migrations-data-integrity/SKILL.md` | 1473 | tracked |
| nodejs-script | project | 111 | 30 | `.claude/skills/nodejs-script/SKILL.md` | 4000 | tracked |
| open-questions-ru | project | 445 | 120 | `.claude/skills/open-questions-ru/SKILL.md` | 2870 | ignored |
| poc | project | 541 | 146 | `.claude/skills/poc/SKILL.md` | 6352 | tracked |
| post-impl-check-client-component-size | project | 149 | 40 | `.claude/skills/post-impl-check-client-component-size/SKILL.md` | 1030 | tracked |
| post-impl-check-cost-calc-no-auto | project | 62 | 17 | `.claude/skills/post-impl-check-cost-calc-no-auto/SKILL.md` | 604 | tracked |
| post-impl-check-indexes | project | 142 | 38 | `.claude/skills/post-impl-check-indexes/SKILL.md` | 3020 | tracked |
| post-impl-check-kb-actual | project | 109 | 29 | `.claude/skills/post-impl-check-kb-actual/SKILL.md` | 532 | tracked |
| post-impl-check-migrations | project | 71 | 19 | `.claude/skills/post-impl-check-migrations/SKILL.md` | 307 | tracked |
| post-impl-check-performance-no-auto | project | 191 | 52 | `.claude/skills/post-impl-check-performance-no-auto/SKILL.md` | 3692 | tracked |
| post-impl-check-security-no-auto | project | 188 | 51 | `.claude/skills/post-impl-check-security-no-auto/SKILL.md` | 3382 | tracked |
| security-check | project | 293 | 79 | `.claude/skills/security-check/SKILL.md` | 5616 | tracked |
| server-e2e-tests | project | 54 | 15 | `.claude/skills/server-e2e-tests/SKILL.md` | 1382 | tracked |
| session-kb-suggest | project | 156 | 42 | `.claude/skills/session-kb-suggest/SKILL.md` | 3985 | tracked |
| sql-review | project | 86 | 23 | `.claude/skills/sql-review/SKILL.md` | 1405 | tracked |
| ui-components | project | 93 | 25 | `.claude/skills/ui-components/SKILL.md` | 823 | tracked |
| update-install-instructions | project | 70 | 19 | `.claude/skills/update-install-instructions/SKILL.md` | 1935 | tracked |
| use-playwright | project | 183 | 49 | `.claude/skills/use-playwright/SKILL.md` | 638 | tracked |
| web-storm-mcp | project | 75 | 20 | `.claude/skills/web-storm-mcp/SKILL.md` | 236 | tracked |
| adlc-lh:check-health-wf | plugin adlc-lh@1.3.1 | 187 | 51 | `adlc-lh@1.3.1/workflows/check-health-wf.js` | 14744 | outside repo |
| adlc-lh:implement-deep-wf | plugin adlc-lh@1.3.1 | 199 | 54 | `adlc-lh@1.3.1/workflows/implement-deep-wf.js` | 13753 | outside repo |
| adlc-lh:post-impl-check-wf | plugin adlc-lh@1.3.1 | 213 | 58 | `adlc-lh@1.3.1/workflows/post-impl-check-wf.js` | 6951 | outside repo |
| adlc-lh:review-deep-wf | plugin adlc-lh@1.3.1 | 291 | 79 | `adlc-lh@1.3.1/workflows/review-deep-wf.js` | 14806 | outside repo |
| adlc-lh:review-dimensions-wf | plugin adlc-lh@1.3.1 | 219 | 59 | `adlc-lh@1.3.1/workflows/review-dimensions-wf.js` | 10589 | outside repo |
| adlc-lh:archive | plugin adlc-lh@1.3.1 | 121 | 33 | `adlc-lh@1.3.1/skills/archive/SKILL.md` | 4698 | outside repo |
| adlc-lh:check-health | plugin adlc-lh@1.3.1 | 103 | 28 | `adlc-lh@1.3.1/skills/check-health/SKILL.md` | 5498 | outside repo |
| adlc-lh:implement | plugin adlc-lh@1.3.1 | 260 | 70 | `adlc-lh@1.3.1/skills/implement/SKILL.md` | 9495 | outside repo |
| adlc-lh:implement-deep | plugin adlc-lh@1.3.1 | 181 | 49 | `adlc-lh@1.3.1/skills/implement-deep/SKILL.md` | 11834 | outside repo |
| adlc-lh:plan | plugin adlc-lh@1.3.1 | 248 | 67 | `adlc-lh@1.3.1/skills/plan/SKILL.md` | 9669 | outside repo |
| adlc-lh:plan-deep | plugin adlc-lh@1.3.1 | 173 | 47 | `adlc-lh@1.3.1/skills/plan-deep/SKILL.md` | 16101 | outside repo |
| adlc-lh:post-impl-check | plugin adlc-lh@1.3.1 | 219 | 59 | `adlc-lh@1.3.1/skills/post-impl-check/SKILL.md` | 7006 | outside repo |
| adlc-lh:post-impl-check-docker-build | plugin adlc-lh@1.3.1 | 112 | 30 | `adlc-lh@1.3.1/skills/post-impl-check-docker-build/SKILL.md` | 1207 | outside repo |
| adlc-lh:reply-format | plugin adlc-lh@1.3.1 | 88 | 24 | `adlc-lh@1.3.1/skills/reply-format/SKILL.md` | 933 | outside repo |
| adlc-lh:review | plugin adlc-lh@1.3.1 | 234 | 63 | `adlc-lh@1.3.1/skills/review/SKILL.md` | 8580 | outside repo |
| adlc-lh:review-deep | plugin adlc-lh@1.3.1 | 234 | 63 | `adlc-lh@1.3.1/skills/review-deep/SKILL.md` | 7985 | outside repo |
| adlc-lh:scratch | plugin adlc-lh@1.3.1 | 299 | 81 | `adlc-lh@1.3.1/skills/scratch/SKILL.md` | 14032 | outside repo |
| adlc-lh:tracker | plugin adlc-lh@1.3.1 | 212 | 57 | `adlc-lh@1.3.1/skills/tracker/SKILL.md` | 10807 | outside repo |
| adlc-lh:workcycle | plugin adlc-lh@1.3.1 | 209 | 56 | `adlc-lh@1.3.1/skills/workcycle/SKILL.md` | 2904 | outside repo |
| dataviz | built-in (Claude Code) | 1448 | 391 | — | — | — |
| artifact-design | built-in (Claude Code) | 198 | 54 | — | — | — |
| artifact-diagramming | built-in (Claude Code) | 206 | 56 | — | — | — |
| artifact-capabilities | built-in (Claude Code) | 661 | 179 | — | — | — |
| update-config | built-in (Claude Code) | 708 | 191 | — | — | — |
| keybindings-help | built-in (Claude Code) | 249 | 67 | — | — | — |
| code-review | built-in (Claude Code) | 502 | 136 | — | — | — |
| simplify | built-in (Claude Code) | 189 | 51 | — | — | — |
| fewer-permission-prompts | built-in (Claude Code) | 192 | 52 | — | — | — |
| loop | built-in (Claude Code) | 345 | 93 | — | — | — |
| schedule | built-in (Claude Code) | 382 | 103 | — | — | — |
| claude-api | built-in (Claude Code) | 1083 | 293 | — | — | — |
| workflow-authoring | built-in (Claude Code) | 253 | 68 | — | — | — |
| run | built-in (Claude Code) | 369 | 100 | — | — | — |
| init | built-in (Claude Code) | 68 | 18 | — | — | — |
| security-review | built-in (Claude Code) | 91 | 25 | — | — | — |
| anthropic-skills:aws-funding | org-synced (anthropic-skills) | 938 | 254 | `~/.claude/skills/synced/<org>/aws-funding/SKILL.md` | 93339 | outside repo |
| anthropic-skills:da-security | org-synced (anthropic-skills) | 470 | 127 | `~/.claude/skills/synced/<org>/da-security/SKILL.md` | 15911 | outside repo |
| anthropic-skills:deck-design-corporate | org-synced (anthropic-skills) | 724 | 196 | `~/.claude/skills/synced/<org>/deck-design-corporate/SKILL.md` | 43414 | outside repo |
| anthropic-skills:docs | org-synced (anthropic-skills) | 1030 | 278 | `~/.claude/skills/synced/<org>/docs/SKILL.md` | 1249 | outside repo |
| anthropic-skills:docx | org-synced (anthropic-skills) | 960 | 259 | `~/.claude/skills/synced/<org>/docx/SKILL.md` | 7639 | outside repo |
| anthropic-skills:extract-document-text | org-synced (anthropic-skills) | 994 | 269 | `~/.claude/skills/synced/<org>/extract-document-text/SKILL.md` | 83680 | outside repo |
| anthropic-skills:google-workspace | org-synced (anthropic-skills) | 979 | 265 | `~/.claude/skills/synced/<org>/google-workspace/SKILL.md` | 15360 | outside repo |
| anthropic-skills:import-memory | org-synced (anthropic-skills) | 174 | 47 | `~/.claude/skills/synced/<org>/import-memory/SKILL.md` | 10689 | outside repo |
| anthropic-skills:morning | org-synced (anthropic-skills) | 368 | 99 | `~/.claude/skills/synced/<org>/morning/SKILL.md` | 18163 | outside repo |
| anthropic-skills:partnership-manager-assistant | org-synced (anthropic-skills) | 718 | 194 | `~/.claude/skills/synced/<org>/partnership-manager-assistant/SKILL.md` | 76420 | outside repo |
| anthropic-skills:pdf | org-synced (anthropic-skills) | 462 | 125 | `~/.claude/skills/synced/<org>/pdf/SKILL.md` | 8072 | outside repo |
| anthropic-skills:pptx | org-synced (anthropic-skills) | 986 | 266 | `~/.claude/skills/synced/<org>/pptx/SKILL.md` | 28872 | outside repo |
| anthropic-skills:presales-proposal-drafter | org-synced (anthropic-skills) | 466 | 126 | `~/.claude/skills/synced/<org>/presales-proposal-drafter/SKILL.md` | 19689 | outside repo |
| anthropic-skills:skill-creator | org-synced (anthropic-skills) | 354 | 96 | `~/.claude/skills/synced/<org>/skill-creator/SKILL.md` | 36447 | outside repo |
| anthropic-skills:xlsx | org-synced (anthropic-skills) | 973 | 263 | `~/.claude/skills/synced/<org>/xlsx/SKILL.md` | 8598 | outside repo |

### P7 Instruction files

| Item | Origin | Chars | ≈ Tokens | File | File size, B | Git |
|---|---|---:|---:|---|---:|---|
| CLAUDE.md | Project | 18075 | 4885 | `CLAUDE.md` | 18751 | tracked, modified |
| CLAUDE.local.md | Local | 1926 | 521 | `CLAUDE.local.md` | 1950 | ignored |
| CLAUDE.md | User — not present | 0 | 0 | `~/.claude/CLAUDE.md` | — | missing |
| client.md | rule — path-scoped, loaded on demand (not at start) | 0 | 0 | `.claude/rules/client.md` | 5856 | tracked |
| db-migration.md | rule — path-scoped, loaded on demand (not at start) | 0 | 0 | `.claude/rules/db-migration.md` | 3725 | tracked |
| hook.md | rule — path-scoped, loaded on demand (not at start) | 0 | 0 | `.claude/rules/hook.md` | 2423 | tracked |
| installer.md | rule — path-scoped, loaded on demand (not at start) | 0 | 0 | `.claude/rules/installer.md` | 773 | tracked |
| server.md | rule — path-scoped, loaded on demand (not at start) | 0 | 0 | `.claude/rules/server.md` | 4616 | tracked |

### P8 Memory index

| Item | Origin | Chars | ≈ Tokens | File | File size, B | Git |
|---|---|---:|---:|---|---:|---|
| MEMORY.md | memory dir — not present | 0 | 0 | `~/.claude/projects/<project-slug>/memory/MEMORY.md` | — | missing |

### P9 System reminders & environment

| Item | Origin | Chars | ≈ Tokens |
|---|---|---:|---:|
| userEmail | account | 274 | 74 |
| gitStatus | git status at start | 908 | 245 |
| environment | Claude Code (JSON size ≈ rendered) | 443 | 120 |
| model | Claude Code (JSON size ≈ rendered) | 282 | 76 |
| language | Claude Code (JSON size ≈ rendered) | 40 | 11 |
| date | Claude Code (JSON size ≈ rendered) | 35 | 9 |
| auto_mode | Claude Code (JSON size ≈ rendered) | 123 | 33 |
| remote_session_change | Claude Code (JSON size ≈ rendered) | 259 | 70 |

### P10 First user prompt

| Item | Origin | Chars | ≈ Tokens |
|---|---|---:|---:|
| prompt text | user | 82 | 22 |

