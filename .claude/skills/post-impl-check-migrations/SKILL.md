---
name: post-impl-check-migrations
description: "Check that DB migrations run on clean DB"
---

start new fresh postgres DB In container on some free port
in another container start server and point to this DB
read logs ensure that it runs without errors 
AND especially that all migrations were applied.
