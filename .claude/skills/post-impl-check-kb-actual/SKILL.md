---
name: post-impl-check-kb-actual
description: "Knowledgebase audit: check that all knowledgebase reference existing code files"
argument-hint: <task-folder-name>
---

1. read list of knowledgebase articles
2. check that all articles are referenced in KB index
2. for articles in parallel subagent:
   1. check that all code files referenced in the article exist
   2. check that facts about these code files that are stated in the article are correct
   3. Correct if necessary, threat source code as source of truth
