---
type: "How-to"
title: "Local prod — the maintainer's own Log Hub at :5003"
description: "What \"local prod\" is (the Docker-deployed Log Hub in ../local-loghub that the maintainer's own Claude sessions report to, http://localhost:5003), how it differs from the dev server, and how to redeploy it from the working tree, check it and roll back."
tags:
  - deployment
  - docker
timestamp: "2026-10-22T15:00:00+04:00"
---

# Local prod

**Local prod** is the maintainer's own, long-lived Log Hub instance: a production Docker image of
this repo running next to it, outside the repo, at **http://localhost:5003**. The hooks of the
maintainer's real work projects report to it, so its data is real session history — that is what
makes it "prod". When the user says "local prod", "локальный прод" or "the server in
local-loghub", this is the instance.

It is **not** the dev server (`npm run start:dev`, :3000 / client :5173), not a Claude sandbox
(`scripts/claude-docker`, see `docker-dev-container.md`) and not the scenario stand.

| What | Value |
|---|---|
| Folder | `local-loghub/`, a sibling of the repo checkout (`<parent>/local-loghub`, next to `<parent>/_repo`) — not in git |
| Compose file | `local-loghub/docker-compose.yml` (a copy of the release bundle's compose) |
| Settings | `local-loghub/.env` — `AUTH_MODE=none`, `LOG_HUB_DATA_DIR=./loghub-db`, Postgres credentials. Never print or commit it |
| Data | `local-loghub/loghub-db/` — `pgdata/` (Postgres cluster), `logs/`, `upload-queue/`, `releases/` |
| Containers | `artisyn-log-hub` (app, image `artisyn-log-hub:latest`, `127.0.0.1:5003 → 3000`) and `artisyn-log-hub-db` (`postgres:18.2-alpine`) |
| Auth | Mode 1 (`none`): identify by email, e.g. `POST /api/v1/auth/identify {"email":"…"}`; a repository's sessions are visible only to its owner's email |

The compose file references the image by tag only (`image: artisyn-log-hub:latest`, no `build:`),
so redeploying means rebuilding that tag from the repo and recreating the `app` container. The DB
container and the data folder are left alone; migrations run automatically when the new app starts.

## Redeploy from the working tree

The image is built from the **working tree** (the Dockerfile copies `client/`, `server/`, `hook/`,
…), so uncommitted changes go in too — check `git status` first if that matters.

From the repo root (bash):

```sh
# 1. keep the running image for a rollback
docker tag artisyn-log-hub:latest artisyn-log-hub:prev

# 2. build (several minutes; run it in the background in an interactive session)
docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) \
  --build-arg RELEASE_STAMP=$(date -u +%Y%m%d-%H%M%S) \
  -t artisyn-log-hub:latest . > tmp/docker-build.log 2>&1

# 3. recreate only the app container (the db keeps running)
docker compose -f ../local-loghub/docker-compose.yml --project-directory ../local-loghub up -d app
```

`--project-directory` matters: `.env` and the relative `LOG_HUB_DATA_DIR=./loghub-db` resolve
against it. Running the compose from any other directory without it would start against an empty
data folder.

## Check

```sh
docker ps --filter name=artisyn-log-hub          # both Up, db (healthy)
docker logs --tail 50 artisyn-log-hub            # migrations applied, no crash loop
curl -s http://localhost:5003/health/version     # gitCommit / releaseStamp of the new build
curl -s http://localhost:5003/api/v1/auth/config # {"mode":"none"}
```

## Roll back

```sh
docker tag artisyn-log-hub:prev artisyn-log-hub:latest
docker compose -f ../local-loghub/docker-compose.yml --project-directory ../local-loghub up -d app
```

A rollback does not undo migrations the newer build applied; that is only safe while the newer
build added no migration the older code cannot live with.

## Rules

- Never run `docker compose down -v`, delete `loghub-db/` or touch the `artisyn-log-hub-db`
  container for a redeploy: that is the real session history.
- Do not point tests, e2e or the scenario suite at :5003 — they have their own DBs.
- Older images (`artisyn-log-hub:<other tags>`) are leftovers of earlier test builds; only
  `latest` and `prev` matter here.
