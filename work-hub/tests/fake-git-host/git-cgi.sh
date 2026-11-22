#!/bin/sh
# Fake HTTPS git host: accepts Basic scenario:<PAT from /etc/pat> (read on every request, so a
# scenario can revoke or rotate it with `docker exec`), then serves /srv/git with git http-backend.
want="Basic $(printf 'scenario:%s' "$(cat /etc/pat)" | base64 | tr -d '\n')"
if [ "${HTTP_AUTHORIZATION:-}" != "$want" ]; then
  printf 'Status: 401 Unauthorized\r\nWWW-Authenticate: Basic realm="fake-git-host"\r\nContent-Type: text/plain\r\n\r\nbad credentials\n'
  exit 0
fi
export GIT_PROJECT_ROOT=/srv/git GIT_HTTP_EXPORT_ALL=1 REMOTE_USER=scenario
exec git http-backend
