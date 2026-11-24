#!/bin/sh
# /run/wh is a tmpfs: connection credentials, capabilities and remote records written by the
# Work Hub server through `wh-git-ctl`. Nothing here survives a restart; the server re-pushes it.
set -eu
mkdir -p /run/wh/conns /run/wh/caps /run/wh/remotes /run/wh/home
chown -R lighttpd:lighttpd /run/wh
chmod 700 /run/wh /run/wh/conns /run/wh/caps /run/wh/remotes /run/wh/home
exec lighttpd -D -f /etc/lighttpd/lighttpd.conf
