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
FROM test AS build
RUN yarn build

# ---- prod-deps: the runtime node_modules only (no biome/typescript/vitest/nodemon/ts-node) ----
FROM base AS prod-deps
RUN yarn workspaces focus --all --production

# ---- prod: final stage = default build target ----
FROM node:26-alpine AS prod
# su-exec: the entrypoint starts as root only long enough to make the data volume writable by the
# unprivileged `node` user, then drops privileges for the bot process itself.
# ffmpeg/ffprobe: voice messages (Ogg/Opus) are re-encoded to MP3 for the transcription model, and
# videos too big to send whole are sampled into keyframes + an audio track (src/ai/media/transcoder.ts).
# About 130 MB installed. Without it, voice messages are still sent as Ogg and small clips still work.
RUN apk add --no-cache su-exec ffmpeg
# Baked in by CI (docker-push.yml) so the bot can announce which commit it's running.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA \
    NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./
COPY --chown=node:node docker/entrypoint.sh /app/entrypoint.sh
RUN mkdir -p /app/data && chown node:node /app/data && chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/app.js"]
