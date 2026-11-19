# Artisyn AI Work Hub — dockerized run mode (plan D15). Build context: work-hub/.
#   docker compose -f deploy/docker-compose.yml up -d --build
# Three stages: the web UI (bun), the release server binary with the SPA and image/ embedded
# (rust), and a slim runtime. The default workspace image is NOT built here: the server builds it
# through the Docker Engine API on its first start (that first start needs the network).

# --- 1. Web UI -----------------------------------------------------------------------------------
FROM oven/bun:1.4.4 AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# --- 2. Server binary ----------------------------------------------------------------------------
FROM rust:1.92 AS server
WORKDIR /src
# rust-toolchain.toml is left out on purpose: the base image already is the pinned 1.92 toolchain,
# and the file would make rustup fetch rustfmt/clippy, which a release build does not need.
COPY Cargo.toml Cargo.lock ./
COPY server/ ./server/
COPY image/ ./image/
COPY --from=web /src/web/dist ./web/dist
# rust-embed includes web/dist and image/ into the binary at compile time (release build).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p work-hub-server \
 && install -D target/release/work-hub-server /out/work-hub-server

# --- 3. Runtime ----------------------------------------------------------------------------------
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=server /out/work-hub-server /usr/local/bin/work-hub-server
# Runs as root: it talks to the host's Docker socket, and access to that socket equals root on the
# host anyway (see README "Dockerized"). Recordings and temp files live in /data (a volume).
ENV HOST=0.0.0.0 \
    PORT=3100 \
    WORK_HUB_DATA_DIR=/data
WORKDIR /data
VOLUME ["/data"]
EXPOSE 3100
CMD ["work-hub-server"]
