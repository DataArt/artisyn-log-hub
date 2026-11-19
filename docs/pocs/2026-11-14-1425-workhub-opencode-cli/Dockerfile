# PoC image: the Work Hub default image plus a pinned, sha256-verified OpenCode binary.
# Build from this folder:
#   docker build -t workhub-opencode-poc:1 .
# The fetch stage mirrors work-hub/image/Dockerfile (curl + `sha256sum -c`).

ARG BASE_IMAGE=artisyn-work-hub-default:0.1.0-alpha.1

FROM ubuntu:24.04 AS fetch-opencode
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
# https://github.com/anomalyco/opencode/releases/tag/v<OPENCODE_VERSION>
# (the GitHub release API lists the same value as the asset's `digest`).
ARG OPENCODE_VERSION=1.19.5
ARG OPENCODE_SHA256=588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a
RUN set -eux; \
    curl -fsSL --retry 5 -o opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz"; \
    echo "${OPENCODE_SHA256}  opencode.tar.gz" | sha256sum -c -; \
    tar -xzf opencode.tar.gz --no-same-owner; \
    chmod 0755 opencode

FROM ${BASE_IMAGE}
COPY --from=fetch-opencode /dl/opencode /usr/local/bin/opencode
RUN opencode --version
