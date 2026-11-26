#!/bin/sh
# AgentBook laptop layer install script. Runs as root at image build time (FROM <base image>) on a
# Debian/Ubuntu (apt-get) or Alpine (apk) base. Installs sshd + SFTP, creates the SSH user when
# needed, writes the tool's sshd config and installs entry.sh / session.sh next to it.
#
# Input: SSHUSER (the resolved SSH user; empty = the tool's `claude` user). Files: entry.sh and
# session.sh in the same folder as this script.
#
# Failure marker: AGENTBOOK-LAYER-UNSUPPORTED on stderr when the base has neither apt-get nor apk;
# the engine maps it to the plain "cannot add the laptop layer" message.
set -e

HERE=$(dirname "$0")
SSH_USER="${SSHUSER:-}"
[ -n "$SSH_USER" ] || SSH_USER=claude
SHARE=/usr/local/share/agentbook

if command -v apk >/dev/null 2>&1; then
  echo "agentbook: Alpine base, installing: openssh-server openssh-sftp-server libstdc++ libgcc ripgrep bash git"
  # libstdc++/libgcc: the Claude Code CLI's musl build needs them; ripgrep/bash/git: what it calls.
  apk add --no-cache openssh-server openssh-sftp-server libstdc++ libgcc ripgrep bash git
  SFTP=/usr/lib/ssh/sftp-server
  LIBC=musl
elif command -v apt-get >/dev/null 2>&1; then
  echo "agentbook: Debian/Ubuntu base, installing: openssh-server git ca-certificates procps"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends openssh-server git ca-certificates procps
  rm -rf /var/lib/apt/lists/*
  SFTP=/usr/lib/openssh/sftp-server
  LIBC=glibc
else
  echo "AGENTBOOK-LAYER-UNSUPPORTED: the base image has neither apt-get nor apk" >&2
  exit 3
fi
[ -x "$SFTP" ] || SFTP=internal-sftp

# The SSH user. An explicit root is kept; any other user is created when the image lacks it.
if [ "$SSH_USER" != root ] && ! id "$SSH_USER" >/dev/null 2>&1; then
  USER_SHELL=/bin/sh
  [ -x /bin/bash ] && USER_SHELL=/bin/bash
  if command -v useradd >/dev/null 2>&1; then
    useradd -m -s "$USER_SHELL" "$SSH_USER"
  else
    adduser -D -s "$USER_SHELL" "$SSH_USER"
  fi
fi
# Alpine creates users with a locked password ('!'); sshd refuses locked accounts even for keys.
# '*' keeps password login impossible but the account usable with a key.
if [ -f /etc/shadow ]; then
  sed -i "s/^$SSH_USER:![^:]*:/$SSH_USER:*:/" /etc/shadow || true
fi

if [ "$SSH_USER" = root ]; then ROOTLOGIN=prohibit-password; else ROOTLOGIN=no; fi

mkdir -p "$SHARE" /etc/ssh
cat > /etc/ssh/sshd_agentbook_config <<EOF
# Written by the AgentBook laptop layer. Key-only login for $SSH_USER.
Port 22
HostKey /run/agentbook/ssh_host_ed25519_key
AuthorizedKeysFile /run/agentbook/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin $ROOTLOGIN
AllowUsers $SSH_USER
Subsystem sftp $SFTP
ForceCommand $SHARE/session.sh
PidFile /run/agentbook/sshd.pid
EOF

cp "$HERE/entry.sh" "$SHARE/entry.sh"
cp "$HERE/session.sh" "$SHARE/session.sh"
chmod 755 "$SHARE/entry.sh" "$SHARE/session.sh"
printf '%s\n' "$SSH_USER" > "$SHARE/ssh-user"
printf '%s\n' "$LIBC" > "$SHARE/libc"
chmod 644 "$SHARE/ssh-user" "$SHARE/libc"

# `ws` on the default PATH; the file itself comes from the read-only tool mount at run time.
mkdir -p /usr/local/bin
ln -sf /opt/agentbook/bin/ws /usr/local/bin/ws

echo "agentbook: laptop layer installed (user $SSH_USER, libc $LIBC, sftp $SFTP)"
