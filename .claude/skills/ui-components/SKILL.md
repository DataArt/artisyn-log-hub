---
name: ui-components
description: "ALWAYS when I ask to change something on UI or plan chanegs that affects UI"
---

1. Read docs/knowledgebase/client-component-map.md — it has the file-to-purpose lookup table. Use it to identify the exact file(s) to change. Do NOT glob docs/knowledgebase/ — if you need to discover other KB files, read docs/knowledgebase/index.md instead.
2. Read docs/knowledgebase/ui-principles.md for behavior patterns.
3. Read docs/knowledgebase/client-routing-and-layout.md for high-level SPA structure if needed.
4. If the component is not listed in the KB, use grep/glob as a fallback — then update client-component-map.md with what you found.
5. After changes are done — update docs/knowledgebase/client-component-map.md and docs/knowledgebase/ui-principles.md if necessary.
