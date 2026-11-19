# Work Hub fake-agent image (plan D14): the default image with the real Claude Code binary replaced
# by tests/fake-agent/claude.mjs. Test infrastructure only, never shipped.
#
# Built by the scenario stand (scripts/scenarios.mjs) and the contract runner as
#   docker build --build-arg BASE_IMAGE=artisyn-work-hub-default:<server crate version> \
#     -t artisyn-work-hub-fake-agent:test work-hub/tests/fake-agent
# and used as WORK_HUB_DEFAULT_IMAGE, so every workspace and workstream container runs it.
ARG BASE_IMAGE=artisyn-work-hub-default:0.1.0-alpha.1
FROM ${BASE_IMAGE}

USER root
COPY claude.mjs /usr/local/lib/work-hub-fake-agent/claude.mjs
# CRLF guard for a Windows checkout (the shebang line would read `node\r`); the symlink keeps the
# .mjs real path, so Node loads it as an ES module.
RUN set -eux; \
    sed -i 's/\r$//' /usr/local/lib/work-hub-fake-agent/claude.mjs; \
    chmod 0755 /usr/local/lib/work-hub-fake-agent/claude.mjs; \
    rm -f /usr/local/bin/claude; \
    ln -s /usr/local/lib/work-hub-fake-agent/claude.mjs /usr/local/bin/claude; \
    claude --version

USER workhub
WORKDIR /home/workhub
CMD ["sleep", "infinity"]
