# Stand-in for a workstream container: git + tmux + the Claude Code CLI, non-root user.
FROM node:26.13.1-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
COPY tmux.conf /home/node/.tmux.conf
RUN mkdir -p /workspace /home/node/.wh && chown -R node:node /workspace /home/node
USER node
ENV LANG=C.UTF-8 TERM=xterm-256color
WORKDIR /workspace
CMD ["sleep", "infinity"]
