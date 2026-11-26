# AgentBook laptop layer: sshd + SFTP, the SSH user and the entrypoint wrapper, on top of any
# Debian/Ubuntu or Alpine based image (the project's devcontainer image or the standard Equipment).
#
# Build args (set by the engine):
#   BASE     the image to add the layer to (required)
#   SSHUSER  the resolved SSH user (empty = the tool's `claude` user)
#   HTTP_PROXY / HTTPS_PROXY / NO_PROXY are Docker's predefined proxy args and reach RUN as-is.
#
# An image with a shell but without apt-get/apk (busybox, distroless :debug) fails in install.sh
# with AGENTBOOK-LAYER-UNSUPPORTED; an image without /bin/sh (scratch, distroless) fails at the RUN
# step itself with `exec: "/bin/sh": stat /bin/sh: no such file or directory`. The engine maps both
# to the plain "cannot add the laptop layer" message
# (agentbook_engine::assets::layer::is_unsupported_base).
ARG BASE
FROM ${BASE}
ARG SSHUSER=
# Numeric: `USER root` needs an /etc/passwd, which scratch lacks, and would hide the /bin/sh error.
# The layered image keeps running as root: entry.sh must start sshd.
USER 0
COPY install.sh entry.sh session.sh /tmp/agentbook-layer/
RUN SSHUSER="${SSHUSER}" sh /tmp/agentbook-layer/install.sh && rm -rf /tmp/agentbook-layer
