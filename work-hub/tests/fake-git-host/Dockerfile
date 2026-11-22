# Fake git host for the Work Hub scenarios (adapted from the PoC
# docs/pocs/2026-11-22-1828-wh-git-proxy-sidecar/upstream/).
#
# - Repositories /srv/git/app.git (branches main, dev) and /srv/git/empty.git (no commits).
# - SSH: user `git`, key auth only; scenarios append keys to /home/git/.ssh/authorized_keys
#   with `docker exec`. Clone URL: ssh://git@git.test/srv/git/app.git.
# - Smart HTTP: http://git.test/git/<repo>.git, Basic `scenario:<PAT from /etc/pat>`;
#   scenarios change the PAT with `docker exec ... sh -c 'echo <pat> > /etc/pat'`.
# - lighttpd runs as `git`, so pushes over HTTP and SSH write the same files.
FROM alpine:3.20
RUN apk add --no-cache git git-daemon openssh-server lighttpd
RUN adduser -D -s /bin/sh git && sed -i 's/^git:!/git:*/' /etc/shadow \
 && mkdir -p /home/git/.ssh /srv/git /var/www && touch /home/git/.ssh/authorized_keys \
 && chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys \
 && ssh-keygen -A \
 && git config --system safe.directory '*' \
 && git config --system init.defaultBranch main \
 && git init --bare -b main /srv/git/app.git \
 && git init --bare -b main /srv/git/empty.git \
 && git clone /srv/git/app.git /tmp/seed \
 && cd /tmp/seed \
 && echo "# app" > README.md && git add README.md \
 && git -c user.name=seed -c user.email=seed@git.test commit -m "Initial commit" \
 && git push origin main \
 && git switch -c dev \
 && echo dev > DEV.md && git add DEV.md \
 && git -c user.name=seed -c user.email=seed@git.test commit -m "Dev branch" \
 && git push origin dev \
 && cd / && rm -rf /tmp/seed \
 && git -C /srv/git/app.git config http.receivepack true \
 && git -C /srv/git/empty.git config http.receivepack true \
 && chown -R git:git /home/git /srv/git
COPY lighttpd.conf /etc/lighttpd/lighttpd.conf
COPY git-cgi.sh start.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/git-cgi.sh /usr/local/bin/start.sh /etc/lighttpd/lighttpd.conf \
 && chmod 755 /usr/local/bin/git-cgi.sh /usr/local/bin/start.sh \
 && echo scenario-pat-1 > /etc/pat && chmod 644 /etc/pat
EXPOSE 22 80
CMD ["/usr/local/bin/start.sh"]
