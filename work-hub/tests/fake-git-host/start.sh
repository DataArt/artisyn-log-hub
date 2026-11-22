#!/bin/sh
# sshd in the background (logs to stderr), lighttpd in the foreground as PID 1's child.
/usr/sbin/sshd -e
exec lighttpd -D -f /etc/lighttpd/lighttpd.conf
