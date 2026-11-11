# Turn-End Cost Advisor gives only number-backed advice

- The advisor now sees what each subagent, workflow agent and user prompt cost, the context size at
  each prompt, cache rebuilds and tiny one-command agents, so its summary names the prompt or agent
  that cost the money.
- Advice is limited to three solid kinds: start a fresh session at the prompt where the topic
  changed, add a rule for a correction that keeps recurring, run tiny one-command agents as one
  scripted step. Generic tips and "use a cheaper model" are no longer given, and a cheap or
  efficient session gets no advice at all.
- Prompts typed while Claude was busy now count as prompts for the advisor and for AI Attribute
  Extraction.
