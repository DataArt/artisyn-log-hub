---
name: sql-review
description: "This is manually activated command, never load it unless run explicitly"
---

IMPORTANT: Never read sql log `server/logs/sql-*.log` file directly. SQL log is huge JSONL, use JS script to explore it structure.

Steps:

# Step 1

check if exists script `scripts\api-2-sql-summary.sql`, if not create it 
script should read all `sql-*` files files from server/logs 
all record with "endpoint":"..." and build md file see example below

```md

## api: /api/endpoint
min duration: 10ms
max duration: 100ms
avg duration: 50ms
sql calls min: 1
sql calls max: 10

List of distinct sql calls:

| sql call | count |
| --- | --- |
| SELECT * FROM table | 10 |
| INSERT INTO table VALUES (?, ?, ?) | 5 |
| UPDATE table SET column = ? WHERE id = ? | 3 |

```

script should treat in API endpoints like /api/v1/teams/3/members

3 as parameter - do it by reaplacing any path element which is number OR uuid with $

JS script shuold generate MD file directly from script. Check that script capture enough data to generate MD file.

# Step 2

For each API call in subagent
for each SQL statement - check using postgresql MCP if this statement if using index
If execution plan has full scan - suggest to add index, return suggestion from subagent

# Step 3

collect on info on suggested indices into `doc\suggested-indices-<timestamp>.md`
