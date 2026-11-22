# Work Hub git proxy sidecar: lighttpd + git http-backend in front of per-remote bare mirrors.
# One container per Work Hub instance; the server drives it only with `docker exec wh-git-ctl`.
FROM alpine:3.20
RUN apk add --no-cache git git-daemon openssh-client openssh-keygen lighttpd curl
COPY lighttpd.conf /etc/lighttpd/lighttpd.conf
COPY wh-git-cgi wh-git-ctl entry.sh /usr/local/bin/
COPY pre-receive /usr/local/share/wh-hooks/pre-receive
RUN chmod 755 /usr/local/bin/wh-git-cgi /usr/local/bin/wh-git-ctl /usr/local/bin/entry.sh \
      /usr/local/share/wh-hooks/pre-receive \
 && mkdir -p /srv/git /var/www && chown lighttpd:lighttpd /srv/git \
 && git config --system core.hooksPath /usr/local/share/wh-hooks \
 && git config --system safe.directory '*'
CMD ["/usr/local/bin/entry.sh"]
