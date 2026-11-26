#!/bin/sh
# AgentBook laptop entrypoint (/usr/local/share/agentbook/entry.sh). Starts sshd, then hands over to
# the image's or devcontainer's original command, so SSH also works after a plain `docker start`,
# an engine restart and with `overrideCommand`.
#
#   1. copies the key files from the read-only key mount to the tmpfs /run/agentbook (chmod 755:
#      sshd StrictModes refuses the tmpfs default 1777);
#   1a. gives the SSH user the uid/gid of the shared folder's owner when that is not root
#      (match_owner);
#   2. dumps this process's environment (the image ENV plus containerEnv, PATH included) to
#      /run/agentbook/base.env, which session.sh sources for every SSH session;
#   3. starts sshd and execs "$@" (or sleeps when there is no command).
#
# sshd needs root. When the container runs as another user, the root part goes through `sudo -n`
# when that works; otherwise SSH is not started and a line on stderr says why.
RUN_DIR=/run/agentbook
KEY_DIR=/opt/agentbook/key
SHARE=/usr/local/share/agentbook

match_owner() {
  # The SSH user takes the uid/gid of the shared folder's owner (the working directory under
  # /work), like devcontainers' updateRemoteUserUID: a folder with real Linux owners (a folder
  # inside a WSL distro, a Linux host) is then writable for the user. A folder owned by root (a
  # Windows drive, which every user may write) changes nothing. Files of the user's home that
  # belonged to the old ids move along.
  user=$(cat "$SHARE/ssh-user" 2>/dev/null)
  [ -n "$user" ] && [ "$user" != root ] || return 0
  case "$PWD" in /work/*) ;; *) return 0 ;; esac
  uid=$(stat -c %u "$PWD" 2>/dev/null) || return 0
  gid=$(stat -c %g "$PWD" 2>/dev/null) || return 0
  [ "$uid" != 0 ] || return 0
  old_uid=$(id -u "$user" 2>/dev/null) || return 0
  old_gid=$(id -g "$user" 2>/dev/null) || return 0
  [ "$uid" = "$old_uid" ] && [ "$gid" = "$old_gid" ] && return 0
  # A user that already has the new uid (`ubuntu`, uid 1000, in Ubuntu 24.04 images) swaps with
  # the SSH user and takes its old uid, so every uid keeps one name (`whoami`, `ls`, git).
  other=$(awk -F: -v u="$user" -v n="$uid" '$3 == n && $1 != u { print $1; exit }' /etc/passwd)
  other_home=
  [ -n "$other" ] && other_home=$(awk -F: -v u="$other" '$1 == u { print $6 }' /etc/passwd)
  own_group=
  grep -q "^$user:[^:]*:$old_gid:" /etc/group && own_group=1
  swap_gid=
  if [ -n "$own_group" ] && [ "$gid" != "$old_gid" ]; then
    swap_gid=$(awk -F: -v u="$user" -v n="$gid" '$3 == n && $1 != u { print $1; exit }' /etc/group)
  fi
  home=$(awk -F: -v u="$user" '$1 == u { print $6 }' /etc/passwd)
  tmp=$(mktemp) || return 0
  awk -F: -v OFS=: -v u="$user" -v nu="$uid" -v ng="$gid" -v ou="$old_uid" -v og="$old_gid" \
    -v swap="$swap_gid" '
      $1 == u { $3 = nu; $4 = ng; print; next }
      $3 == nu { $3 = ou }
      swap != "" && $4 == ng { $4 = og }
      { print }' /etc/passwd > "$tmp" && cat "$tmp" > /etc/passwd
  if [ -n "$own_group" ]; then
    # The user's own group (same name) follows, swapping with a group that had the new gid.
    awk -F: -v OFS=: -v u="$user" -v ng="$gid" -v og="$old_gid" '
        $1 == u { $3 = ng; print; next }
        $3 == ng { $3 = og }
        { print }' /etc/group > "$tmp" && cat "$tmp" > /etc/group
  fi
  rm -f "$tmp"
  # Files follow their owner: the other user's home first (new → old), then the SSH user's.
  if [ -n "$other_home" ] && [ -d "$other_home" ] && [ "$other_home" != "$home" ]; then
    find "$other_home" -xdev -uid "$uid" -exec chown -h "$old_uid" {} + 2>/dev/null
    [ -n "$swap_gid" ] && find "$other_home" -xdev -gid "$gid" -exec chgrp -h "$old_gid" {} + 2>/dev/null
  fi
  if [ -n "$home" ] && [ -d "$home" ]; then
    find "$home" -xdev -uid "$old_uid" -exec chown -h "$uid" {} + 2>/dev/null
    find "$home" -xdev -gid "$old_gid" -exec chgrp -h "$gid" {} + 2>/dev/null
  fi
  echo "agentbook: $user now has uid $uid and gid $gid, the owner of $PWD${other:+ ($other moved to uid $old_uid)}" >&2
}

prepare_as_root() {
  # $1: a file holding the environment dump to install as base.env (may be empty).
  mkdir -p "$RUN_DIR" "$RUN_DIR/env" /run/sshd
  chmod 755 "$RUN_DIR" "$RUN_DIR/env"
  if [ -n "$1" ] && [ -f "$1" ]; then
    cp "$1" "$RUN_DIR/base.env"
    rm -f "$1"
  fi
  [ -f "$RUN_DIR/base.env" ] || : > "$RUN_DIR/base.env"
  chmod 644 "$RUN_DIR/base.env"
  match_owner
  if [ ! -r "$KEY_DIR/ssh_host_ed25519_key" ] || [ ! -r "$KEY_DIR/authorized_keys" ]; then
    echo "agentbook: no keys in $KEY_DIR, sshd not started" >&2
    return 1
  fi
  cp "$KEY_DIR/ssh_host_ed25519_key" "$RUN_DIR/ssh_host_ed25519_key"
  cp "$KEY_DIR/authorized_keys" "$RUN_DIR/authorized_keys"
  [ -r "$KEY_DIR/ssh_host_ed25519_key.pub" ] && cp "$KEY_DIR/ssh_host_ed25519_key.pub" "$RUN_DIR/ssh_host_ed25519_key.pub"
  chown root:root "$RUN_DIR/ssh_host_ed25519_key" "$RUN_DIR/authorized_keys" 2>/dev/null
  chmod 600 "$RUN_DIR/ssh_host_ed25519_key"
  chmod 644 "$RUN_DIR/authorized_keys"
  [ -f "$RUN_DIR/ssh_host_ed25519_key.pub" ] && chmod 644 "$RUN_DIR/ssh_host_ed25519_key.pub"
  # A container restart keeps the tmpfs contents only on some engines; a stale pid file is harmless
  # but a still-running sshd (restart of PID 1 only) must not be started twice.
  if [ -f "$RUN_DIR/sshd.pid" ] && kill -0 "$(cat "$RUN_DIR/sshd.pid" 2>/dev/null)" 2>/dev/null; then
    return 0
  fi
  /usr/sbin/sshd -f /etc/ssh/sshd_agentbook_config -E "$RUN_DIR/sshd.log"
}

if [ "${1:-}" = "--agentbook-root" ]; then
  # Re-entry through sudo from a non-root container user.
  prepare_as_root "${2:-}"
  exit $?
fi

ENV_DUMP=$(mktemp 2>/dev/null || echo "/tmp/agentbook-base.env.$$")
export -p > "$ENV_DUMP" 2>/dev/null

if [ "$(id -u)" = 0 ]; then
  prepare_as_root "$ENV_DUMP" || true
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  sudo -n /bin/sh "$SHARE/entry.sh" --agentbook-root "$ENV_DUMP" || true
else
  rm -f "$ENV_DUMP"
  echo "agentbook: the container runs as $(id -un 2>/dev/null || id -u) without sudo, sshd not started" >&2
fi

if [ "$#" -eq 0 ]; then
  # No command: keep the laptop running.
  while :; do sleep 3600; done
fi
exec "$@"
