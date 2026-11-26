ARG BASE
FROM ${BASE}
ARG SSHUSER=
USER root
COPY install.sh /tmp/agentbook-install.sh
RUN SSHUSER="${SSHUSER}" sh /tmp/agentbook-install.sh && rm /tmp/agentbook-install.sh
