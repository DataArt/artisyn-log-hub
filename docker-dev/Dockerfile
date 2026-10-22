# check=skip=SecretsUsedInArgOrEnv
# log-hub dev sandbox image (Phase 2: full development sandbox).
#
# Built by scripts/claude-docker.mjs:
#   docker build -f docker-dev/Dockerfile -t log-hub-dev:latest \
#     --label log-hub.dev-image-hash=<sha256> docker-dev
# The build context is docker-dev/ restricted by Dockerfile.dockerignore (an allow-list).
#
# Every download is verified against a pinned sha256 taken from the vendor's official source:
#   - Node: https://nodejs.org/dist/v<NODE_VERSION>/SHASUMS256.txt (node-v<v>-linux-x64.tar.xz)
#   - Claude Code: platforms["linux-x64"].checksum of
#     https://downloads.claude.ai/claude-code-releases/<CLAUDE_VERSION>/manifest.json
#     (the dist bucket URL used by the official https://claude.ai/install.sh)
#   - bun: https://github.com/oven-sh/bun/releases/download/bun-v<BUN_VERSION>/SHASUMS256.txt
#     (bun-linux-x64.zip)
#   - Mailpit: the GitHub release asset digest of mailpit-linux-amd64.tar.gz
#     (https://github.com/axllent/mailpit/releases/tag/v<MAILPIT_VERSION>)
#   - Chrome: the SHA256 of the versioned .deb in Google's apt index
#     https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages
#   - git-core PPA: signing-key fingerprint from https://launchpad.net/~git-core/+archive/ubuntu/ppa
# Playwright's Chromium is installed by Playwright's own installer (PLAYWRIGHT_VERSION = the root
# package-lock.json version); the npm globals are pinned by version.
# No Python anywhere in the image (asserted at the end).

ARG UBUNTU_IMAGE=ubuntu:24.04

# ---------------------------------------------------------------------------------------------
# Download stages (run in parallel under BuildKit)
# ---------------------------------------------------------------------------------------------
# apt runs with BuildKit cache mounts for its lists and .debs (one id per stage, so parallel stages
# never wait on each other's lock; kept across builds, never part of a layer), so a rebuild after a
# Dockerfile edit does not download them again. The stock docker-clean hook is removed so
# downloaded .debs stay in the cache mount.
FROM ${UBUNTU_IMAGE} AS fetch-base
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,id=apt-cache-fetch-base,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-fetch-base,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates aria2 xz-utils unzip
WORKDIR /dl

FROM fetch-base AS fetch-node
ARG NODE_VERSION=24.22.1
ARG NODE_SHA256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
RUN set -eux; \
    aria2c -x16 -s16 --console-log-level=warn -o node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c -; \
    mkdir /out; \
    tar -xJf node.tar.xz -C /out --strip-components=1 --no-same-owner; \
    rm -f /out/CHANGELOG.md /out/LICENSE /out/README.md

FROM fetch-base AS fetch-claude
ARG CLAUDE_VERSION=2.1.304
ARG CLAUDE_SHA256=ea0f135784631619a7a409d07322ecec964f9cc4fd377508ed1ba3f141f27912
RUN set -eux; \
    aria2c -x16 -s16 --console-log-level=warn -o claude \
      "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/linux-x64/claude"; \
    echo "${CLAUDE_SHA256}  claude" | sha256sum -c -; \
    chmod 0755 claude

FROM fetch-base AS fetch-bun
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN set -eux; \
    aria2c -x16 -s16 --console-log-level=warn -o bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"; \
    echo "${BUN_SHA256}  bun.zip" | sha256sum -c -; \
    unzip -q bun.zip; \
    mkdir /out; \
    install -m 0755 bun-linux-x64/bun /out/bun

FROM fetch-base AS fetch-mailpit
# Keep equal to the Mailpit image tag in the compose files (DD-12).
ARG MAILPIT_VERSION=1.31.6
ARG MAILPIT_SHA256=10fa12ccc610f653d4ed4df848c1817f9935dcf4e9a6a458a19ab0fa02093f91
RUN set -eux; \
    aria2c -x16 -s16 --console-log-level=warn -o mailpit.tar.gz \
      "https://github.com/axllent/mailpit/releases/download/v${MAILPIT_VERSION}/mailpit-linux-amd64.tar.gz"; \
    echo "${MAILPIT_SHA256}  mailpit.tar.gz" | sha256sum -c -; \
    mkdir /out; \
    tar -xzf mailpit.tar.gz -C /out --no-same-owner mailpit; \
    chmod 0755 /out/mailpit

FROM fetch-base AS fetch-chrome
ARG CHROME_VERSION=156.0.8078.47-1
ARG CHROME_SHA256=6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8
RUN set -eux; \
    aria2c -x16 -s16 --console-log-level=warn -o chrome.deb \
      "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb"; \
    echo "${CHROME_SHA256}  chrome.deb" | sha256sum -c -

# Playwright's Chromium (PLAYWRIGHT_VERSION = the root package-lock.json version), downloaded by
# Playwright's own installer in its own stage: it is the slowest download of the image (~5 min), so
# it runs in parallel with the apt stages and stays cached when later steps change. The browsers
# dir is relocatable; the final stage copies it to dev's default ~/.cache/ms-playwright.
FROM fetch-base AS fetch-playwright
ARG PLAYWRIGHT_VERSION=1.60.0
COPY --from=fetch-node /out/ /usr/local/
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -eux; \
    npx -y "playwright@${PLAYWRIGHT_VERSION}" install chromium; \
    test -n "$(ls -A /ms-playwright)"; \
    rm -rf /root/.npm

# Chrome and its dependencies as .debs, resolved against a stock Ubuntu, so the final stage can
# install them offline.
FROM ${UBUNTU_IMAGE} AS chrome-debs
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=fetch-chrome /dl/chrome.deb /tmp/chrome.deb
RUN --mount=type=cache,id=apt-cache-chrome-debs,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-chrome-debs,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries; \
    apt-get update; \
    cd /tmp; \
    mkdir -p /debs /tmp/archives/partial; \
    apt-get install -y --no-install-recommends --download-only \
      -o Dir::Cache::archives=/tmp/archives ./chrome.deb libasound2t64; \
    cp /tmp/archives/*.deb /debs/; \
    cp /tmp/chrome.deb /debs/google-chrome-stable.deb

# ---------------------------------------------------------------------------------------------
# Final image
# ---------------------------------------------------------------------------------------------
FROM ${UBUNTU_IMAGE}
ARG CLAUDE_VERSION=2.1.304
ARG NPM_VERSION=11.16.0
ARG TS_LS_VERSION=6.0.2
# TypeScript 7 (the native port) ships no tsserver, which typescript-language-server needs, so the
# global fallback stays on the latest 6.x.
ARG TYPESCRIPT_VERSION=6.0.3
ARG GIT_PPA_KEY_FPR=F911AB184317630C59970973E363C90F8F1B6217
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# User `dev` takes uid 1000: the stock `ubuntu` user is removed so the uid is free.
RUN set -eux; \
    userdel -r ubuntu 2>/dev/null || true; \
    useradd -m -u 1000 -U -s /bin/bash dev

# Base packages. git comes from the signed git-core PPA, added by hand (add-apt-repository pulls
# in Python): the key is fetched, its fingerprint checked against GIT_PPA_KEY_FPR, then used as a
# signed-by keyring. procps provides pgrep (live-session count). The apt lists and .debs live in
# BuildKit cache mounts (see fetch-base), so nothing of them lands in the layer.
RUN --mount=type=cache,id=apt-cache-final,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-final,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates gnupg aria2 sudo procps jq ripgrep \
      postgresql-client socat curl; \
    tmp="$(mktemp -d)"; \
    aria2c --console-log-level=warn -d "$tmp" -o git-core.asc \
      "https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0x${GIT_PPA_KEY_FPR}"; \
    fprs="$(GNUPGHOME="$tmp" gpg --batch --show-keys --with-colons "$tmp/git-core.asc" \
      | awk -F: '/^pub/{p=1; next} p && /^fpr/{print $10; p=0}')"; \
    test "$fprs" = "${GIT_PPA_KEY_FPR}"; \
    install -d -m 0755 /etc/apt/keyrings; \
    GNUPGHOME="$tmp" gpg --batch --dearmor -o /etc/apt/keyrings/git-core-ppa.gpg "$tmp/git-core.asc"; \
    chmod 0644 /etc/apt/keyrings/git-core-ppa.gpg; \
    rm -rf "$tmp"; \
    . /etc/os-release; \
    echo "deb [signed-by=/etc/apt/keyrings/git-core-ppa.gpg] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu ${VERSION_CODENAME} main" \
      > /etc/apt/sources.list.d/git-core-ppa.list; \
    apt-get update --error-on=any; \
    apt-get install -y --no-install-recommends git; \
    echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev; \
    chmod 0440 /etc/sudoers.d/dev

# Chrome (for the Playwright MCP's chrome channel) from the pre-downloaded debs, offline.
# The Chrome package registers its own apt source on install; it is removed so a later
# `apt-get update` never reaches an unpinned repository.
COPY --from=chrome-debs /debs /tmp/debs
RUN --mount=type=cache,id=apt-cache-final,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lists-final,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    apt-get install -y --no-install-recommends /tmp/debs/*.deb; \
    rm -rf /tmp/debs; \
    rm -f /etc/apt/sources.list.d/google-chrome* /etc/cron.daily/google-chrome; \
    ! ls /etc/apt/sources.list.d | grep -q google; \
    google-chrome --version

# Node + npm (host versions), bun, Mailpit, the TypeScript language server.
COPY --from=fetch-node /out/ /usr/local/
COPY --from=fetch-bun /out/bun /usr/local/bin/bun
COPY --from=fetch-mailpit /out/mailpit /usr/local/bin/mailpit
RUN set -eux; \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx; \
    npm install -g "npm@${NPM_VERSION}"; \
    npm install -g "typescript-language-server@${TS_LS_VERSION}" "typescript@${TYPESCRIPT_VERSION}"; \
    npm cache clean --force; \
    rm -rf /root/.npm

# Claude Code native binary, laid out like `claude install` so auto-update works. The cache dirs
# are mount points of the shared cache volumes and must belong to dev.
RUN set -eux; \
    mkdir -p /home/dev/.local/share/claude/versions /home/dev/.local/bin /home/dev/.claude-home \
      /home/dev/.npm /home/dev/.bun /home/dev/.cache/ms-playwright; \
    chown -R dev:dev /home/dev/.local /home/dev/.claude-home /home/dev/.npm /home/dev/.bun \
      /home/dev/.cache
COPY --from=fetch-claude --chown=dev:dev /dl/claude /home/dev/.local/share/claude/versions/${CLAUDE_VERSION}
RUN set -eux; \
    ln -s "/home/dev/.local/share/claude/versions/${CLAUDE_VERSION}" /home/dev/.local/bin/claude; \
    chown -h dev:dev /home/dev/.local/bin/claude
ENV PATH=/home/dev/.local/bin:${PATH} \
    CLAUDE_CONFIG_DIR=/home/dev/.claude-home

# Playwright's Chromium from its parallel stage into dev's /home/dev/.cache/ms-playwright (a fresh
# shared cache volume is seeded from here).
COPY --from=fetch-playwright --chown=dev:dev /ms-playwright/ /home/dev/.cache/ms-playwright/

# Image files (paths per DD-12).
COPY gitconfig /etc/gitconfig
COPY CLAUDE.container.md /etc/claude-code/CLAUDE.md
COPY settings.template.json provision.mjs /opt/log-hub-dev/
COPY entrypoint.sh devctl npx.cmd /usr/local/bin/
RUN set -eux; \
    chmod 0644 /etc/gitconfig /etc/claude-code/CLAUDE.md \
      /opt/log-hub-dev/settings.template.json /opt/log-hub-dev/provision.mjs; \
    chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/devctl /usr/local/bin/npx.cmd; \
    install -d -o dev -g dev /run/dev /var/log/dev

# Final assertions: git >= 2.48 (worktree --relative-paths), no Python, every tool present.
RUN set -eux; \
    gv="$(git --version | awk '{print $3}')"; \
    dpkg --compare-versions "$gv" ge 2.48; \
    if command -v python3 || command -v python; then echo 'python must not be in the image' >&2; exit 1; fi; \
    node --version; \
    npm --version; \
    bun --version; \
    mailpit version; \
    psql --version; \
    command -v socat; \
    command -v pgrep; \
    command -v curl; \
    typescript-language-server --version; \
    tsc --version; \
    test -x "/home/dev/.local/share/claude/versions/${CLAUDE_VERSION}"

WORKDIR /home/dev
# Runs as root; `docker run --init` provides tini as PID 1.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
