FROM node:22-alpine AS build

RUN apk add --no-cache python3 make g++

RUN corepack enable yarn
WORKDIR /app

COPY . .
RUN yarn install
RUN yarn build

FROM node:22-alpine

RUN corepack enable yarn
WORKDIR /app
ARG NODE_ENV=production

COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/yarn.lock /app/.yarnrn.yml ./
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

RUN yarn workspaces focus --production

RUN mkdir -p /app/data

CMD yarn prod
