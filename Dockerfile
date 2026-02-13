FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
RUN corepack enable yarn
WORKDIR /app
COPY . .
RUN yarn install
RUN yarn build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
RUN mkdir -p /app/data
CMD ["node", "dist/app.js"]

