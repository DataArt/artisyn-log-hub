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
# `.env` with random secrets on the first install only (an existing `.env` is never touched),
# then runs `docker compose pull` and `docker compose up -d`.
#
# POSIX sh only — it runs as `| sh`, so no bashisms. Everything lives in main(), which is called
# on the last line: the shell parses the whole script before running anything, so a command that
# reads stdin cannot swallow the rest of the piped script.

set -eu

IMAGE='ghcr.io/dataart/artisyn-log-hub'
RELEASES_URL='https://github.com/DataArt/artisyn-log-hub/releases'
DEFAULT_URL='http://localhost:5003'

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

  # 8. Where to find it.
  url=$(grep -E '^PUBLIC_BASE_URL=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d " \"'\r\t") || true
  [ -n "$url" ] || url=$DEFAULT_URL
  printf '\nArtisyn Log Hub %s is installed in %s\n' "$new_tag" "$install_dir"
  printf 'Open %s\n' "$url"
}

main "$@"
