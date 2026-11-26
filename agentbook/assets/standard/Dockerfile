# AgentBook standard Equipment (`agentbook-std:<v>`): used when a shared folder has no devcontainer.
# Ubuntu 24.04 LTS pinned by digest, with git, ca-certificates and curl from the Ubuntu archive
# (verified by apt's signatures) and Node.js from the official linux tarball, which the tool
# downloads on the host, checks against its sha256 constant and sends in the build context.
# The laptop layer (assets/layer) is built on top of this image like on any project image.
#
# Build context: this Dockerfile plus `node-linux.tar.xz`.
# Build args (set by the engine from agentbook_core::pins):
#   NODE_VERSION  e.g. v24.22.3
#   NODE_SHA256   sha256 of node-linux.tar.xz, checked again inside the build
# HTTP_PROXY / HTTPS_PROXY / NO_PROXY are Docker's predefined proxy args and reach RUN as-is.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

ARG NODE_VERSION
ARG NODE_SHA256

RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

COPY node-linux.tar.xz /tmp/node-linux.tar.xz
RUN test -n "${NODE_SHA256}" \
 && echo "${NODE_SHA256}  /tmp/node-linux.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node-linux.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
 && rm -f /usr/local/CHANGELOG.md /usr/local/README.md \
 && rm /tmp/node-linux.tar.xz \
 && node --version \
 && test "$(node --version)" = "${NODE_VERSION}"

LABEL artisyn.agentbook="1"
CMD ["sleep", "infinity"]
