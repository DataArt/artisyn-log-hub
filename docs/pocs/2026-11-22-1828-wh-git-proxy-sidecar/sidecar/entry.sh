#!/bin/sh
# /run/wh is a tmpfs: credentials, capabilities and remote configs written by the WH server.
mkdir -p /run/wh/conns /run/wh/caps /run/wh/remotes /run/wh/home
chown -R lighttpd:lighttpd /run/wh && chmod 700 /run/wh
exec lighttpd -D -f /etc/lighttpd/lighttpd.conf
