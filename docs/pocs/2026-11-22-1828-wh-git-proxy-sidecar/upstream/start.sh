#!/bin/sh
/usr/sbin/sshd -e
exec lighttpd -D -f /etc/lighttpd/lighttpd.conf
