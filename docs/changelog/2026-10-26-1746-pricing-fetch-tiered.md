# Long-context tiered pricing and a fixed Anthropic price fetch

- The Anthropic price fetch works again with the current pricing page, including its new
  web-search wording and the "prompts up to / over N tokens" rows.
- A model can now carry long-context price tiers. Each LLM call is priced by its own prompt
  length, utility calls included, and the Admin price dialog can edit the tiers.
- A session's cost is now always what Log Hub computes from its own price table: the session,
  its sub-agents and its utility calls. The figure Claude Code reports through telemetry is only
  a cross-check, and its warning explains the gap and what to do. If a model has no price, the
  cost shows `$???` with a hint naming the model to add, never a partial sum or another model's
  price. The list, the session header, Active Sessions and the reports all show the same figure.
- The Model Pricing table shows one full row of rates per prompt range. A
  "Fetch Anthropic prices now" button runs the daily check on demand, and the status line says
  when the next check is due.
- The session Context Growth chart marks with a red "+cost tier" arrow the call where the prompt
  crossed into a pricier tier.
- The server and the web UI now share one pricing implementation.
