# Fake git host: SSH (key auth, user git) and smart HTTP with a fixed "PAT".
FROM alpine:3.20
RUN apk add --no-cache git git-daemon openssh-server lighttpd
RUN adduser -D -s /bin/sh git && sed -i 's/^git:!/git:*/' /etc/shadow \
 && mkdir -p /home/git/.ssh && touch /home/git/.ssh/authorized_keys \
 && chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys \
 && ssh-keygen -A \
 && git config --system safe.directory '*' \
 && git init --bare -b main /home/git/repo.git \
 && git clone /home/git/repo.git /tmp/seed \
 && cd /tmp/seed && git -c user.name=seed -c user.email=seed@x commit --allow-empty -m seed \
 && echo hello > README && git add README \
 && git -c user.name=seed -c user.email=seed@x commit -m readme \
 && git push origin main && git switch -c dev && git -c user.name=seed -c user.email=seed@x commit --allow-empty -m dev \
 && git push origin dev && cd / && rm -rf /tmp/seed \
 && git -C /home/git/repo.git config http.receivepack true \
 && chown -R git:git /home/git && chmod -R a+rwX /home/git/repo.git
COPY lighttpd.conf /etc/lighttpd/lighttpd.conf
COPY upstream-cgi.sh start.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/upstream-cgi.sh /usr/local/bin/start.sh && echo secret-pat-1 > /etc/pat
CMD ["/usr/local/bin/start.sh"]
