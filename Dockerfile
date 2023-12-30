FROM node:latest
LABEL authors="felix"

ARG NODE_ENV=production

RUN corepack enable
COPY . /app
WORKDIR /app

RUN yarn install
CMD yarn prod
