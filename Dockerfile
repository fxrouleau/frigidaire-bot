FROM node:22-alpine AS build

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
COPY --from=build /app/package.json /app/yarn.lock ./

RUN yarn workspaces focus --production
CMD yarn prod
