#!/bin/sh
# Fake HTTPS host: accepts Basic x-access-token:<PAT from /etc/pat>, like GitHub.
want="Basic $(printf 'x-access-token:%s' "$(cat /etc/pat)" | base64)"
if [ "${HTTP_AUTHORIZATION:-}" != "$want" ]; then
  printf 'Status: 401 Unauthorized\r\nWWW-Authenticate: Basic realm="fake"\r\nContent-Type: text/plain\r\n\r\nbad credentials\n'
  exit 0
fi
export GIT_PROJECT_ROOT=/home/git GIT_HTTP_EXPORT_ALL=1 REMOTE_USER=pat
exec git http-backend
