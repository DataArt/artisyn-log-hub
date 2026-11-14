# Artisyn AI Work Hub — default devcontainer image (plan D6).
#
# Built by the server at startup when WORK_HUB_DEFAULT_IMAGE is missing, or by hand with
# `npm run image` (work-hub/scripts/image.mjs):
#   docker build -t artisyn-work-hub-default:<server crate version> work-hub/image
#
# Every download is verified against a pinned sha256 (same pins as docker-dev/Dockerfile):
#   - Node: https://nodejs.org/dist/v<NODE_VERSION>/SHASUMS256.txt (node-v<v>-linux-x64.tar.xz)
#   - Claude Code: platforms["linux-x64"].checksum of
#     https://downloads.claude.ai/claude-code-releases/<CLAUDE_VERSION>/manifest.json
#
# The home directory is a per-workspace volume, so nothing the image needs lives under it: the
# Claude Code binary goes to /usr/local/bin. libatomic1 is a runtime dependency of the Node
# binary that docker-dev gets transitively and a minimal image does not.

ARG UBUNTU_IMAGE=ubuntu:24.04

FROM ${UBUNTU_IMAGE} AS fetch
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /dl

FROM fetch AS fetch-node
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG NODE_VERSION=26.13.1
ARG NODE_SHA256=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864
RUN set -eux; \
    curl -fsSL --retry 5 -o node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c -; \
    mkdir /out; \
    tar -xJf node.tar.xz -C /out --strip-components=1 --no-same-owner; \
    rm -f /out/CHANGELOG.md /out/LICENSE /out/README.md

FROM fetch AS fetch-claude
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG CLAUDE_VERSION=2.1.304
ARG CLAUDE_SHA256=ea0f135784631619a7a409d07322ecec964f9cc4fd377508ed1ba3f141f27912
RUN set -eux; \
    curl -fsSL --retry 5 -o claude \
      "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/linux-x64/claude"; \
    echo "${CLAUDE_SHA256}  claude" | sha256sum -c -; \
    chmod 0755 claude

FROM ${UBUNTU_IMAGE}
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# User `workhub` takes uid/gid 1000: the stock `ubuntu` user is removed so the ids are free.
RUN set -eux; \
    userdel -r ubuntu 2>/dev/null || true; \
    groupdel ubuntu 2>/dev/null || true; \
    groupadd -g 1000 workhub; \
    useradd -m -u 1000 -g 1000 -s /bin/bash -d /home/workhub workhub

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      git tmux sudo ca-certificates procps curl less unzip libatomic1; \
    rm -rf /var/lib/apt/lists/*; \
    echo 'workhub ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/workhub; \
    chmod 0440 /etc/sudoers.d/workhub

COPY --from=fetch-node /out/ /usr/local/
COPY --from=fetch-claude /dl/claude /usr/local/bin/claude

COPY tmux.conf /etc/tmux.conf
RUN set -eux; \
    printf '[init]\n\tdefaultBranch = main\n' > /etc/gitconfig; \
    chmod 0644 /etc/gitconfig /etc/tmux.conf; \
    node --version; \
    npm --version; \
    git --version; \
    tmux -V; \
    claude --version

USER workhub
WORKDIR /home/workhub
CMD ["sleep", "infinity"]
