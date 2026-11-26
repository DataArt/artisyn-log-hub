FROM alpine:3.20

# libstdc++/libgcc: needed by the musl build of Claude Code; ripgrep: its search tool.
RUN apk add --no-cache openssh-server openssh-sftp-server bash git ca-certificates curl libstdc++ libgcc ripgrep procps

# Alpine locks new accounts with '!' which blocks key login without PAM; '*' = no password, not locked.
RUN adduser -D -s /bin/bash claude \
 && sed -i 's/^claude:!/claude:*/' /etc/shadow \
 && mkdir -p /work /home/claude/.ssh /home/claude/.claude \
 && chown -R claude:claude /work /home/claude \
 && chmod 700 /home/claude/.ssh

RUN ssh-keygen -A \
 && printf '\nSubsystem sftp /usr/lib/ssh/sftp-server\n' >> /etc/ssh/sshd_config
COPY sshd_config /etc/ssh/sshd_config.d/poc.conf
RUN grep -q '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
