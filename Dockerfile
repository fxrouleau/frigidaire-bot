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

# ---- prod: final stage = default build target ----
FROM node:26-alpine AS prod
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
RUN mkdir -p /app/data
CMD ["node", "dist/app.js"]
