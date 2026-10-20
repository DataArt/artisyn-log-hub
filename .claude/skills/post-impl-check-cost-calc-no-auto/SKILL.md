---
name: post-impl-check-cost-calc-no-auto
description: "Check skill calculations"
---

open URL http://localhost:5173/#/repos/1 using playwright 

choose Plain list from drop down
wait for list of session

walk trhough latest 50 sessions in subagent
for each session take cost from session summary header in the top
then take cost of each turn, sum turn cost and comapre with cost from header
if it mismatch - record session id as broken. 

once you finish with session walk if list of broken sessions is not empty
for each session take data from DB and investigate why numbers differ
