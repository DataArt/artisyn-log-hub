---
name: post-impl-check-release
description: "Post-implementation check: ensure release bundle is OK."
argument-hint: <task-folder-name>
---

Build release bundle `npm run release`

see it in release/ folder

run it dockerized on with the current local postgres server
but create a new database

start docker on some random free port

in folder C:\work\project  create new git repo
with playwright go to server from docker, API Keys, press give me string

install hook to new repo in C:\work\project 

then run the following sessions in that repo using claude -p 

1. ask claude to create requirements to NodeJS script that search for frist 30 prime numbers
2. ask claude to review requirements in a following way - use dymanic workflow, start review 3 times in subagents, then merge results from subagents
3. ask to implement NodeJS script that search for frist 30 prime numbers, run, test


After all done - go to this dockerized server with playwright and check
1. all 3 sessions data are there
2. no errors shown for hook, hook state is green
3. check each session enbsure that it looks consistently - click through all tabs

Do tear down. 
1. stop docker 
2. remove docker image 
3. rename repository to <timestampted name>

report results
