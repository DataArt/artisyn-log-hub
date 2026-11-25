#!/bin/sh
# Artisyn Log Hub installer / upgrader (Linux, macOS, WSL).
#
#   curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.sh | sh
#
# Environment (all optional):
#   VERSION      release to install: `latest` (default), `X.Y.Z` or `vX.Y.Z`
#   INSTALL_DIR  install directory (default: $HOME/artisyn-log-hub)
#   FORCE=1      allow installing a version lower than the one already installed
#
# It downloads docker-compose.yml and env.example of the release into INSTALL_DIR, generates a
# `.env` with random secrets on the first install only, then runs `docker compose pull` and
# `docker compose up -d`. With AUTH_MODE=none it then checks that this machine can sign in
# (GET /api/v1/auth/local-check) and, when the app sees the host under an unexpected address
# (Rancher Desktop), adds that address to AUTH_NONE_TRUSTED_PEERS in `.env` and restarts the app —
# the only change ever made to an existing `.env`.
#
# POSIX sh only — it runs as `| sh`, so no bashisms. Everything lives in main(), which is called
# on the last line: the shell parses the whole script before running anything, so a command that
# reads stdin cannot swallow the rest of the piped script.

set -eu

IMAGE='ghcr.io/dataart/artisyn-log-hub'
RELEASES_URL='https://github.com/DataArt/artisyn-log-hub/releases'
DEFAULT_URL='http://localhost:5003'
# The compose file publishes the app on 127.0.0.1:5003 only.
LOCAL_CHECK_URL='http://127.0.0.1:5003/api/v1/auth/local-check'
LOCAL_CHECK_TIMEOUT_SEC=180

TMP_DIR=''

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

is_semver() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
}

# True when version $1 is lower than version $2 (both X.Y.Z), compared field by field as integers.
version_lt() {
  a_major=${1%%.*}; a_rest=${1#*.}; a_minor=${a_rest%%.*}; a_patch=${a_rest#*.}
  b_major=${2%%.*}; b_rest=${2#*.}; b_minor=${b_rest%%.*}; b_patch=${b_rest#*.}
  if [ "$a_major" -ne "$b_major" ]; then [ "$a_major" -lt "$b_major" ]; return; fi
  if [ "$a_minor" -ne "$b_minor" ]; then [ "$a_minor" -lt "$b_minor" ]; return; fi
  [ "$a_patch" -lt "$b_patch" ]
}

# Prints the image tag of the `image: IMAGE:<tag>` line of a compose file, or nothing.
image_tag() {
  [ -f "$1" ] || return 0
  line=$(grep -E "^[[:space:]]*image:[[:space:]]*ghcr\.io/dataart/artisyn-log-hub:" "$1" 2>/dev/null | head -n 1) || true
  [ -n "$line" ] || return 0
  printf '%s\n' "${line#*artisyn-log-hub:}" | tr -d " \"'\r\t"
}

rand_hex() {
  od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'
}

# download <url> <file>; exits with a clear message on 404 or any other failure.
download() {
  code=$(curl -sSL -o "$2" -w '%{http_code}' "$1") || code='000'
  if [ "$code" = '404' ]; then
    die "release $VERSION not found ($1)"
  fi
  if [ "$code" != '200' ]; then
    die "download failed (HTTP $code): $1"
  fi
}

# Value of the last active `NAME=value` line of a .env file (empty when absent), quotes stripped.
env_value() {
  grep -E "^[[:space:]]*$2[[:space:]]*=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d " \"'\r\t" || true
}

# Exact private IPv4 (10/8, 172.16/12, 192.168/16, 169.254/16) — the only form the server's
# AUTH_NONE_TRUSTED_PEERS accepts.
is_private_ipv4() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' || return 1
  # Octets as decimal: leading zeros stripped, so `[ -le ]` never sees an octal-looking value.
  octets=$(printf '%s\n' "$1" | tr '.' '\n' | sed -e 's/^0*//' -e 's/^$/0/' | tr '\n' ' ')
  set -- $octets
  for o in "$1" "$2" "$3" "$4"; do
    [ "$o" -le 255 ] || return 1
  done
  o1=$1; o2=$2
  [ "$o1" -eq 10 ] && return 0
  [ "$o1" -eq 172 ] && [ "$o2" -ge 16 ] && [ "$o2" -le 31 ] && return 0
  [ "$o1" -eq 192 ] && [ "$o2" -eq 168 ] && return 0
  [ "$o1" -eq 169 ] && [ "$o2" -eq 254 ] && return 0
  return 1
}

# Asks the app, from this machine, whether it treats us as local (Mode 1 self-check). Sets
# CHECK_STATE (ok | unsupported | timeout), CHECK_LOCAL (true | false) and CHECK_PEER.
# Retries while the app starts; never goes through a proxy.
local_check() {
  CHECK_STATE='timeout'; CHECK_LOCAL=''; CHECK_PEER=''
  body_file="$TMP_DIR/local-check.json"
  waited=0
  while [ "$waited" -lt "$LOCAL_CHECK_TIMEOUT_SEC" ]; do
    code=$(curl -s --noproxy '*' -m 5 -o "$body_file" -w '%{http_code}' "$LOCAL_CHECK_URL" </dev/null) || code='000'
    if [ "$code" = '200' ]; then
      body=$(tr -d ' \r\n\t' <"$body_file")
      CHECK_STATE='ok'
      case "$body" in
        *'"local":true'*) CHECK_LOCAL='true' ;;
        *) CHECK_LOCAL='false' ;;
      esac
      CHECK_PEER=$(printf '%s\n' "$body" | sed -n 's/.*"peer":"\([^"]*\)".*/\1/p')
      return 0
    fi
    # 404: an image without the self-check (or AUTH_MODE is not none after all).
    if [ "$code" = '404' ]; then
      CHECK_STATE='unsupported'
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

# Adds $2 to AUTH_NONE_TRUSTED_PEERS in .env ($1): extends an active line, or appends one.
# The only edit the installer ever makes to an existing .env.
add_trusted_peer() {
  current=$(env_value "$1" AUTH_NONE_TRUSTED_PEERS)
  case ",$(printf '%s' "$current" | tr ' \t' ',,')," in
    *",$2,"*) return 0 ;;
  esac
  env_tmp="$1.tmp.$$"
  if grep -Eq '^[[:space:]]*AUTH_NONE_TRUSTED_PEERS[[:space:]]*=' "$1"; then
    if [ -n "$current" ]; then new_value="$current,$2"; else new_value="$2"; fi
    sed -e "s/^[[:space:]]*AUTH_NONE_TRUSTED_PEERS[[:space:]]*=.*/AUTH_NONE_TRUSTED_PEERS=$new_value/" "$1" >"$env_tmp"
  else
    cp "$1" "$env_tmp"
    [ -z "$(tail -c 1 "$env_tmp")" ] || printf '\n' >>"$env_tmp"
    printf '\n# Added by the installer: the address this machine reaches the app from (AUTH_MODE=none).\nAUTH_NONE_TRUSTED_PEERS=%s\n' "$2" >>"$env_tmp"
  fi
  chmod 600 "$env_tmp" 2>/dev/null || true
  mv "$env_tmp" "$1"
}

main() {
  # 1. Docker, Compose and a running daemon.
  command -v docker >/dev/null 2>&1 || die 'Docker/Compose not found: install a Docker Engine with the Compose v2 plugin'
  docker compose version >/dev/null 2>&1 </dev/null || die "Docker/Compose not found: 'docker compose version' failed — install the Compose v2 plugin"
  docker info >/dev/null 2>&1 </dev/null || die 'Docker is not running (or this user cannot reach the Docker daemon)'
  command -v curl >/dev/null 2>&1 || die 'curl not found'

  # 2. Requested version and the download base URL.
  VERSION=${VERSION:-latest}
  VERSION=${VERSION#v}
  if [ "$VERSION" = 'latest' ]; then
    base_url="$RELEASES_URL/latest/download"
  else
    is_semver "$VERSION" || die "VERSION must be latest or X.Y.Z, got '$VERSION'"
    base_url="$RELEASES_URL/download/v$VERSION"
  fi
  install_dir=${INSTALL_DIR:-$HOME/artisyn-log-hub}
  force=${FORCE:-}

  # 3. Download the release files into a temp directory.
  TMP_DIR=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  printf 'Downloading release %s...\n' "$VERSION"
  download "$base_url/docker-compose.yml" "$TMP_DIR/docker-compose.yml"
  download "$base_url/env.example" "$TMP_DIR/env.example"

  # 4. Refuse a downgrade: DB migrations only go forward.
  new_tag=$(image_tag "$TMP_DIR/docker-compose.yml")
  if [ -z "$new_tag" ] || ! is_semver "$new_tag"; then
    die "unexpected docker-compose.yml: no 'image: $IMAGE:X.Y.Z' line"
  fi
  old_tag=$(image_tag "$install_dir/docker-compose.yml")
  if [ -n "$old_tag" ] && is_semver "$old_tag" && version_lt "$new_tag" "$old_tag"; then
    if [ "$force" != '1' ]; then
      die "downgrade not supported — DB migrations are forward-only (installed $old_tag, requested $new_tag). Set FORCE=1 to override."
    fi
    printf 'FORCE=1: downgrading %s -> %s\n' "$old_tag" "$new_tag"
  fi

  # 5. Move the new files in, keeping the previous compose file.
  mkdir -p "$install_dir"
  had_prev=''
  if [ -f "$install_dir/docker-compose.yml" ]; then
    cp "$install_dir/docker-compose.yml" "$install_dir/docker-compose.yml.prev"
    had_prev='1'
  fi
  mv "$TMP_DIR/docker-compose.yml" "$install_dir/docker-compose.yml"
  mv "$TMP_DIR/env.example" "$install_dir/.env.example"

  # 6. First install only: generate .env with random secrets.
  if [ ! -f "$install_dir/.env" ]; then
    pg_password=$(rand_hex 18)
    session_secret=$(rand_hex 32)
    env_tmp="$install_dir/.env.tmp.$$"
    (
      umask 077
      tr -d '\r' <"$install_dir/.env.example" \
        | sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$pg_password/" \
              -e "s/^SESSION_SECRET=.*/SESSION_SECRET=$session_secret/" >"$env_tmp"
      printf '\nNODE_ENV=production\n' >>"$env_tmp"
    )
    mv "$env_tmp" "$install_dir/.env"
    printf 'Generated %s/.env with random secrets.\n' "$install_dir"
  else
    printf 'Keeping the existing %s/.env.\n' "$install_dir"
  fi

  # 7. Pull and start.
  cd "$install_dir"
  if ! docker compose pull </dev/null; then
    if [ -n "$had_prev" ]; then
      mv docker-compose.yml.prev docker-compose.yml
      die 'docker compose pull failed — restored the previous docker-compose.yml'
    fi
    die 'docker compose pull failed'
  fi
  docker compose up -d </dev/null || die "docker compose up -d failed — see 'docker compose logs app'"

  # 8. AUTH_MODE=none: make sure the browser on this machine can sign in. Some runtimes
  # (Rancher Desktop) deliver host traffic from an address the app does not know as local; the
  # app reports it, the installer trusts it in .env and restarts the app. Never fails the
  # install: a problem here is printed with the fix.
  if [ "$(env_value .env AUTH_MODE)" = 'none' ]; then
    printf 'Checking passwordless sign-in from this machine...\n'
    local_check
    if [ "$CHECK_STATE" = 'ok' ] && [ "$CHECK_LOCAL" = 'false' ] && is_private_ipv4 "$CHECK_PEER"; then
      printf 'The app sees this machine as %s — adding it to AUTH_NONE_TRUSTED_PEERS in .env and restarting.\n' "$CHECK_PEER"
      add_trusted_peer .env "$CHECK_PEER"
      docker compose up -d --force-recreate app </dev/null || die "docker compose up -d failed — see 'docker compose logs app'"
      local_check
    fi
    if [ "$CHECK_STATE" = 'ok' ] && [ "$CHECK_LOCAL" = 'true' ]; then
      printf 'Passwordless sign-in works from this machine.\n'
    elif [ "$CHECK_STATE" = 'ok' ]; then
      printf "WARNING: the app sees this machine as '%s' and will refuse passwordless sign-in. Set AUTH_MODE=password in %s/.env and run 'docker compose up -d' in %s.\n" "$CHECK_PEER" "$install_dir" "$install_dir" >&2
    elif [ "$CHECK_STATE" = 'timeout' ]; then
      printf "WARNING: the app did not answer on %s within %s s, so sign-in was not checked — see 'docker compose logs app'. If the login page refuses your email, run this installer again.\n" "$DEFAULT_URL" "$LOCAL_CHECK_TIMEOUT_SEC" >&2
    fi
  fi

  # 9. Where to find it.
  url=$(grep -E '^PUBLIC_BASE_URL=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d " \"'\r\t") || true
  [ -n "$url" ] || url=$DEFAULT_URL
  printf '\nArtisyn Log Hub %s is installed in %s\n' "$new_tag" "$install_dir"
  printf 'Open %s\n' "$url"
}

main "$@"
