# syntax=docker/dockerfile:1

# ---- base: dependencies only (cached unless package.json/yarn.lock/.yarnrc.yml change) ----
FROM node:26-alpine AS base
# Native module build tools (better-sqlite3, sharp)
RUN apk add --no-cache python3 make g++
# Corepack is no longer bundled with Node 25+ — install it from npm
RUN npm install -g corepack && corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    LEFTHOOK=0
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

# ---- test: deps + full source; used by `docker compose run test` and CI ----
FROM base AS test
COPY --chown=node:node . .
CMD ["yarn", "test"]

# ---- ci: building this stage runs the full gate (lint, types, build, tests) ----
FROM test AS ci
RUN yarn check:ci && yarn typecheck && yarn build && yarn test

# ---- build: compile TypeScript for prod ----
FROM base AS build
COPY --chown=node:node . .
RUN yarn build

# ---- prod-deps: production-only node_modules for the prod image ----
# `yarn workspaces focus --all --production` is the Yarn 4 (Berry) replacement for
# `yarn install --production` (workspace-tools is bundled with Yarn 4): it re-runs
# the install with devDependencies excluded, pruning them from node_modules.
# base already has python3/make/g++, so if Yarn rebuilds the native modules
# (better-sqlite3, sharp) during this install, the toolchain is available.
FROM base AS prod-deps
RUN yarn workspaces focus --all --production

# ---- prod: final stage = default build target ----
FROM node:26-alpine AS prod
# Baked in by CI (docker-push.yml) so the bot can announce which commit it's running.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./
# Run as the unprivileged `node` user (uid/gid 1000, built into node:26-alpine)
# instead of root — the bot decodes untrusted images (sharp) and writes SQLite/
# debug captures under /app/data.
# OPERATOR NOTE: docker-compose.yaml host-mounts ./data:/app/data. Hosts that
# previously ran this image as root have root-owned files there; a one-time
# `chown -R 1000:1000 ./data` on the host is required or the bot cannot write
# its database and captures.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "dist/app.js"]
