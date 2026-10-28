# Build tools are pinned to the versions the repo itself builds with: bun = BUN_VERSION of the CI
# workflows and docker-dev, typescript and @vercel/ncc = the root package-lock.json.

# Stage 1 — client-build
FROM --platform=$BUILDPLATFORM node:24.22.1-slim AS client-build
RUN npm install -g bun@1.3.14
WORKDIR /app/client
# client/vite.config.ts aliases @loghub/pricing to the repo-local package sources.
COPY packages/ /app/packages/
COPY client/ ./
RUN bun install --frozen-lockfile && bun run build

# Stage 2 — hooks-installer build (generates artisyn-hooks-installer.tgz + hooks.tar.gz)
FROM --platform=$BUILDPLATFORM node:24.22.1-slim AS hooks-build
WORKDIR /app
COPY artisyn-hooks-installer/ ./artisyn-hooks-installer/
COPY hook/ ./hook/
COPY scripts/build-hooks-installer.js ./scripts/build-hooks-installer.js
RUN mkdir -p server/src/public/static \
 && npm ci --prefix artisyn-hooks-installer \
 && npm install --no-save typescript@6.0.3 \
 && node scripts/build-hooks-installer.js

# Stage 3 — server-build
FROM --platform=$BUILDPLATFORM node:24.22.1-slim AS server-build
RUN npm install -g @vercel/ncc@0.38.4
WORKDIR /app/server
# server/package.json depends on the repo-local @loghub/pricing (file:../packages/pricing).
COPY packages/ /app/packages/
COPY server/ ./
# ncc type-checks every file in server/tsconfig.json, including the *.algo.spec.ts tests that
# import this loader (only its .d.cts is needed; nothing from it reaches the bundle).
COPY scripts/algo-docs/ /app/scripts/algo-docs/
RUN npm ci && ncc build src/main.ts -o /app/dist
WORKDIR /app
# dist/wasm: the tree-sitter WASM the server's Bash analysis loads (scripts/copy-wasm.js).
RUN mkdir -p /app/dist/drizzle /app/dist/prebuilds /app/dist/wasm \
 && cp -r server/drizzle/migrations /app/dist/drizzle/migrations \
 && cp -r server/node_modules/argon2/prebuilds/* /app/dist/prebuilds/ \
 && cp server/node_modules/web-tree-sitter/web-tree-sitter.wasm server/node_modules/tree-sitter-bash/tree-sitter-bash.wasm /app/dist/wasm/ \
 && cp server/node_modules/connect-pg-simple/table.sql /app/dist/table.sql

# Stage 4 — runtime
# Alpine, not Debian slim: the Debian base carries util-linux/glibc/zlib/ncurses CVEs that Debian
# marks wont-fix (Snyk Container). argon2 ships musl prebuilds, which prebuilds/* below includes.
# npm, npx, corepack and yarn are removed: the server never runs them, and npm's bundled packages
# are the image's only remaining high findings.
FROM node:24.22.1-alpine AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ARG VERSION=unknown
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-build /app/dist                        ./dist
COPY --from=client-build /app/client/dist                 ./dist/public
COPY --from=hooks-build  /app/server/src/public/static/   ./dist/public/static/
RUN mkdir -p dist/public/static \
 && printf '{"version":"%s","gitCommit":"%s"}' "$VERSION" "$GIT_COMMIT" > dist/public/static/build-info.json
EXPOSE 3000
ENV PORT=3000
ENV CLUSTER_MODE=primary
WORKDIR /app/dist
CMD ["node", "index.js"]
