#!/bin/sh
# Laptop layer install script (FROM <project image>) (runs as root at image build time, Debian/Ubuntu or Alpine).
set -e
SSH_USER="${SSHUSER:-}"
[ -n "$SSH_USER" ] || SSH_USER=claude

if command -v apk >/dev/null 2>&1; then
  apk add --no-cache openssh-server openssh-sftp-server libstdc++ libgcc ripgrep bash git
  SFTP=/usr/lib/ssh/sftp-server
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends openssh-server git ca-certificates procps >/dev/null
  rm -rf /var/lib/apt/lists/*
  SFTP=/usr/lib/openssh/sftp-server
else
  echo "agentbook: unsupported base image (no apk/apt-get)" >&2
  exit 1
fi

if [ "$SSH_USER" != root ] && ! id "$SSH_USER" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/sh "$SSH_USER"; else adduser -D -s /bin/sh "$SSH_USER"; fi
fi
# Alpine creates users with a locked password ('!'); sshd refuses locked accounts even for keys.
sed -i "s/^$SSH_USER:!/$SSH_USER:*/" /etc/shadow || true

if [ "$SSH_USER" = root ]; then ROOTLOGIN=prohibit-password; else ROOTLOGIN=no; fi
mkdir -p /usr/local/share/agentbook /etc/ssh
cat > /etc/ssh/sshd_agentbook_config <<EOF
Port 22
HostKey /run/agentbook/ssh_host_ed25519_key
AuthorizedKeysFile /run/agentbook/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin $ROOTLOGIN
AllowUsers $SSH_USER
Subsystem sftp $SFTP
ForceCommand /usr/local/share/agentbook/session.sh
PidFile /run/agentbook/sshd.pid
EOF

cat > /usr/local/share/agentbook/entry.sh <<'EOF'
#!/bin/sh
# Feature entrypoint: start sshd, then hand over to the original command.
mkdir -p /run/agentbook && chmod 755 /run/agentbook   # tmpfs is 1777; sshd StrictModes refuses it
cp /opt/agentbook/key/ssh_host_ed25519_key /run/agentbook/ssh_host_ed25519_key
cp /opt/agentbook/key/authorized_keys /run/agentbook/authorized_keys
chmod 600 /run/agentbook/ssh_host_ed25519_key
chmod 644 /run/agentbook/authorized_keys
mkdir -p /run/sshd
/usr/sbin/sshd -f /etc/ssh/sshd_agentbook_config -E /run/agentbook/sshd.log
exec "$@"
EOF

cat > /usr/local/share/agentbook/session.sh <<'EOF'
#!/bin/sh
# ForceCommand wrapper: load the tool-delivered variables (tmpfs), then run what the client asked.
if [ -r /run/agentbook/env/session.env ]; then set -a; . /run/agentbook/env/session.env; set +a; fi
if [ -n "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"; fi
exec "${SHELL:-/bin/sh}" -l
EOF
chmod 755 /usr/local/share/agentbook/entry.sh /usr/local/share/agentbook/session.sh
echo "agentbook laptop layer installed for user $SSH_USER"
