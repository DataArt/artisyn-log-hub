# Consistency fix: one story for the anatomy tab and the View system prompt modal

Status: implemented 2026-11-11 (after a three-agent review: facts vs local-prod data, plan vs
code/tests, screens/wording). Follow-up of the user's report on local prod, session
`bb53ff20-2507-463a-b68a-04ccd273ced8` (repo 1, model `claude-opus-5-5`, Claude Code 2.1.314).

## 1. The problem as the user saw it

- Anatomy tab header: first request **66,568 tokens** (exact, from usage).
- Anatomy row "System prompt (harness core)": 6,488 B, ≈ 2,403 tokens, 3.6 %.
- View system prompt modal header: 13 parts · 18 tools · 155,799 B · **≈ 57,703 tokens**.
- Nothing said how 57.7 K relates to 66.6 K or to the 2.4 K row; "System prompt" had three
  meanings (harness core; core + memory; core + memory + tools).

## 2. What the first request really contained (measured on the wire)

The transcript keeps the request as sent: `api-request-shape` (`shape.system[]`, `shape.tools[]`),
`api-request` (`shapeHash`, `querySource`, `tail` = message blob hashes) and `api-request-blob`.
First main request of the session (shape line 526, request line 529):

| Wire part | Content | UTF-8 B | ≈ tok at 2.7 |
|---|---|---|---|
| `system[]` | 57 B billing line + 2,996 B shared + 5,572 B session-specific | 8,625 | 3,194 |
| `tools[]` | 18 tools (name + description + input-schema JSON); 2 `defer_loading` stubs not counted | 91,100 | 33,741 |
| messages | CLAUDE.md reminder 23,359 · userEmail/gitStatus 3,341 · attribution 583 · `/clear` caveat + command 395 · slash command 327 · skill body 9,425 · system message (environment, skills listing, agent listing, MCP instructions, deferred names) 45,320 · 3 `tool_addition` 1,900 | 84,650 | 31,352 |
| **Sum** | | **184,375** | **68,287** |

Exact total 66,568 → **2.770 B/token** for this request; 18 sessions ≥ 2.1.312 on local prod gave
2.66–2.79. The configured 2.7 is right; the ratio was never the problem (an early chat diagnosis
said otherwise and was wrong).

## 3. Root causes

1. **Bug — the modal counted every tool description twice.** A real `prompt_snapshot.tools[]`
   item is `{name, description, schema}` where `schema` is the whole wire tool
   `{name, description, input_schema, eager_input_streaming}` (36/36 sampled local-prod sessions,
   2.1.280–2.1.322). The modal sized a tool as name + description + `JSON.stringify(schema)`.
2. **No tools row on the anatomy tab.** The tools sat in "Harness internals" (34,228 tok here), so
   internals was mostly tools without saying so.
3. **"System prompt" with three meanings and no visible link**, plus the 34 B boundary marker
   counted by the anatomy only.

## 4. What was changed

- **Shared tool resolver** `sysctx-anatomy/tool-definitions.ts` (`findToolDefinitions`), used by
  both the anatomy and the modal: the `api-request-shape` of the first main `api-request` of the
  startup block (2.1.312+), else the first `prompt_snapshot` with tools (2.1.280+), else none.
  `defer_loading` tools dropped. Size = name + description + `JSON.stringify(inputSchema)`, where
  `inputSchema` = `schema.input_schema` (real shape), else `input_schema`, else `schema`.
  Reviewer finding adopted: the JSON of the whole definition (first idea) counts the description's
  escapes (+2 %) and put 10/18 sessions over the exact total; this formula puts 0/18 over.
- **Anatomy**: new partition `tool-definitions` ("Tool definitions", lime) after Memory index, one
  row per tool (source `built-in` / `MCP server`); `toolSource` on the result; the boundary marker
  and blank blocks no longer count as system prompt; the Harness internals hint lists Tool
  definitions only when the session logged none.
- **Modal**: tools from the same resolver (Schema pane shows the input schema only); header line
  `First request 66,568 tokens (exact) = System prompt ≈ 3,165 (13 parts) + Tool definitions
  ≈ 33,741 (18 tools) + ≈ 29,662 everything else (opening messages — see the anatomy table)`;
  prompt toolbar adds `= harness core X B + memory index Y B`, the `# Memory` part is tagged
  "Memory index row"; the tools summary says it is the Tool definitions row and where it was read
  from.

Result on session `bb53ff20` (2.7 B/tok): system prompt 2,390 + memory index 775 + tool definitions
33,741 + environment 480 + deferred names 114 + MCP 3,052 + subagent types 1,674 + skills 10,495 +
instruction files 8,484 + reminders 1,123 + first prompt 3,740 = 66,068; Harness internals 500
(0.8 %) = 66,568. The modal's System prompt (3,165) = core + memory; its Tool definitions
(33,741) = the row.

## 5. Tests (policy: algorithm rows + scenario steps only)

- Algorithm: `sysctx-anatomy.json` — `tool-definitions` in every `kinds` list, new SA-TD1 (wire
  source, deferred tool, `mcp__` tool, marker and blank block skipped), SA-GS05 re-derived;
  `system-prompt-view.json` — `tools.source` on every row, new SPV-14 (wire beats snapshot) and
  SPV-15 (real `schema` shape).
- Golden: GS-05 `gs05-0003p` switched to the real `schema` shape; `expected.json` anatomy
  (system prompt 3116/890, tool definitions 378/108, attributed 3027, internals 5773) and
  `check-arithmetic.mjs` (`firstRequestTools`, same rules, independent code).
- Scenario: `s-sess-03` step 8 (Tool definitions row and drill-down, the hint without a tools
  bullet) and 8a2 (header line, toolbar split, tools summary; modal figures = anatomy rows).

## 6. Left as is, on purpose

- The 57 B billing line, the attribution reminder (583 B), the `tool_addition` MCP definitions
  (1,900 B) and the wrappers around the CLAUDE.md / userEmail reminders are in no partition; they
  stay in Harness internals (named in its hint as "short texts the log does not keep").
- Environment is sized from attachment JSON (1,296 B) while the rendered text is ~4.1 KB; the hint
  says Environment usually under-counts. Measuring it from the wire system message is a separate
  change.
- One 2.1.280 session (`8d647979`, three prompts before the first reply) is already over the total
  today; it stays an `over-total` warning.
- The modal's system prompt still comes from the snapshot (it has the part split and the boundary);
  the wire `system[]` differs only by the 57 B billing line and joining separators.
