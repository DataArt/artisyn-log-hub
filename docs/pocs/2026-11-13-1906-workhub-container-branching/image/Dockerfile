# Stand-in for a workspace devcontainer: git, non-root user, the repository lives in the
# container filesystem (not in a volume) so `docker commit` carries it.
FROM node:26.13.1-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /workspace /data && chown -R node:node /workspace /data
USER node
RUN git config --global user.name "Work Hub" && git config --global user.email "work-hub@localhost" \
 && git config --global init.defaultBranch main
WORKDIR /workspace
CMD ["sleep", "infinity"]
