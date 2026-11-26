FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server git ca-certificates curl procps less \
 && rm -rf /var/lib/apt/lists/*

# Non-root user for the Desktop SSH session; '*' = no password, but not locked (key login allowed).
RUN useradd -m -s /bin/bash claude \
 && usermod -p '*' claude \
 && mkdir -p /run/sshd /work /home/claude/.ssh /home/claude/.claude \
 && chown -R claude:claude /work /home/claude \
 && chmod 700 /home/claude/.ssh

# Host keys generated once per image build -> stable host key for this image.
RUN ssh-keygen -A
COPY sshd_config /etc/ssh/sshd_config.d/poc.conf

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
