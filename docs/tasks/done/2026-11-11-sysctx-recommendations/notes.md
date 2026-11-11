# Notes: Startup Context Recommendations

## 2026-11-11: evidence moved from requirements.md

- FR-8 evidence: on local prod all 5,229 `prompt_snapshot` `tools[]` items have top-level keys
  `description, name, schema` and `schema` keys `description, eager_input_streaming, input_schema,
  name`, with the same description in both.
- Why FR-8 landed as name + description + `JSON.stringify(schema.input_schema)` in
  `2026-11-10-sysctx-prompt-viewer` rather than `JSON.stringify(schema)`: the whole object's JSON
  counts the description's escapes (~2 % more) and pushed 10 of 18 measured sessions over the exact
  total (see `consistency-fix-plan.md` in that task).
