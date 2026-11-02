---
name: ui-components
description: "ALWAYS when I ask to change something on UI or plan chanegs that affects UI"
---

1. Read docs/knowledgebase/client-component-map.md (small, read it whole) — it names the folder for each area, the KB article with its details and the modules that are not where their name suggests. Do NOT glob docs/knowledgebase/ — if you need to discover other KB files, read docs/knowledgebase/index.md instead.
2. Find the exact file(s) inside that folder with grep/glob — the map deliberately does not list every file.
3. Read docs/knowledgebase/ui-principles.md for behavior patterns.
4. Read docs/knowledgebase/client-routing-and-layout.md for high-level SPA structure if needed.
5. After changes are done — update the area's own KB article and docs/knowledgebase/ui-principles.md if necessary. Touch client-component-map.md only when you added, removed or renamed a folder, an entry point or a cross-cutting module.
