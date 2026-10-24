# Build tools are pinned to the versions the repo itself builds with: bun = BUN_VERSION of the CI
# workflows and docker-dev, typescript and @vercel/ncc = the root package-lock.json.

# Stage 1 — client-build
FROM node:24.22.1-slim AS client-build
RUN npm install -g bun@1.3.14
WORKDIR /app/client
COPY client/ ./
RUN bun install --frozen-lockfile && bun run build

# Stage 2 — hooks-installer build (generates artisyn-hooks-installer.tgz + hooks.tar.gz)
FROM node:24.22.1-slim AS hooks-build
WORKDIR /app
COPY artisyn-hooks-installer/ ./artisyn-hooks-installer/
COPY hook/ ./hook/
COPY scripts/build-hooks-installer.js ./scripts/build-hooks-installer.js
RUN mkdir -p server/src/public/static \
 && npm ci --prefix artisyn-hooks-installer \
 && npm install --no-save typescript@6.0.3 \
 && node scripts/build-hooks-installer.js

# Stage 3 — server-build
FROM node:24.22.1-slim AS server-build
RUN npm install -g @vercel/ncc@0.38.4
WORKDIR /app/server
COPY server/ ./
# ncc type-checks every file in server/tsconfig.json, including the *.algo.spec.ts tests that
# import this loader (only its .d.cts is needed; nothing from it reaches the bundle).
COPY scripts/algo-docs/ /app/scripts/algo-docs/
RUN npm ci && ncc build src/main.ts -o /app/dist
WORKDIR /app
RUN mkdir -p /app/dist/drizzle /app/dist/prebuilds \
 && cp -r server/drizzle/migrations /app/dist/drizzle/migrations \
 && cp -r server/node_modules/argon2/prebuilds/* /app/dist/prebuilds/ \
 && cp server/node_modules/connect-pg-simple/table.sql /app/dist/table.sql \
 && node -p "require('./server/package.json').version" > /app/dist/.app-version

# Stage 4 — runtime
# Alpine, not Debian slim: the Debian base carries util-linux/glibc/zlib/ncurses CVEs that Debian
# marks wont-fix (Snyk Container). argon2 ships musl prebuilds, which prebuilds/* below includes.
# npm, npx, corepack and yarn are removed: the server never runs them, and npm's bundled packages
# are the image's only remaining high findings.
FROM node:24.22.1-alpine AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ARG GIT_COMMIT=unknown
ARG RELEASE_STAMP=unknown
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-build /app/dist                        ./dist
COPY --from=client-build /app/client/dist                 ./dist/public
COPY --from=hooks-build  /app/server/src/public/static/   ./dist/public/static/
RUN VERSION=$(cat dist/.app-version) && mkdir -p dist/public/static && printf '{"version":"%s","gitCommit":"%s","releaseStamp":"%s"}' "$VERSION" "${GIT_COMMIT:-unknown}" "${RELEASE_STAMP:-unknown}" > dist/public/static/build-info.json && rm dist/.app-version
EXPOSE 3000
ENV PORT=3000
ENV CLUSTER_MODE=primary
WORKDIR /app/dist
CMD ["node", "index.js"]
