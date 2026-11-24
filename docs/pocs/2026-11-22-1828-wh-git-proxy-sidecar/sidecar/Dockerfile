# WH git proxy sidecar: lighttpd + git http-backend in front of per-remote bare mirrors.
FROM alpine:3.20
RUN apk add --no-cache git git-daemon openssh-client openssh-keygen lighttpd curl
COPY lighttpd.conf /etc/lighttpd/lighttpd.conf
COPY wh-git-cgi wh-git-ctl wh-msg-cgi entry.sh /usr/local/bin/
COPY pre-receive /usr/local/share/wh-hooks/pre-receive
RUN chmod +x /usr/local/bin/* /usr/local/share/wh-hooks/pre-receive \
 && mkdir -p /srv/git && chown lighttpd:lighttpd /srv/git \
 && git config --system core.hooksPath /usr/local/share/wh-hooks \
 && git config --system safe.directory '*'
CMD ["/usr/local/bin/entry.sh"]
